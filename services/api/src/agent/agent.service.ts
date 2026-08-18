import { Inject, Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { platformDb, tenantDb } from '@ventia/db';
import { AGENT_TOOL_JSON_SCHEMAS, AGENT_TOOL_NAMES } from '@ventia/core';
import { AgentToolsService } from './agent-tools.service';
import { AgentBudgetService, BUDGET_EXHAUSTED_REPLY } from './agent-budget.service';
import { AgentThrottleService, THROTTLED_REPLY } from './agent-throttle.service';
import { buildSystemPrompt } from './system-prompt';

/**
 * The agent's conversation loop (docs/SPEC.md §7): load history → call Claude
 * with the tenant's tools → execute any tool calls server-side → loop until
 * the model is done → persist everything.
 *
 * ## The client is injected, not constructed here
 *
 * `ANTHROPIC_CLIENT` is a Nest provider so tests can substitute a fake and
 * assert on what the loop does — how it dispatches tools, what it persists,
 * whether it respects the budget — without a network call or an API key. Same
 * seam, and same reason, as the `fetchImpl` parameter the payment adapters
 * take.
 *
 * ## Why a manual loop rather than the SDK's tool runner
 *
 * The tool runner would drive this loop for us, and for a plain custom-tool
 * agent it is usually the right call. Here the loop body is not just "execute
 * and continue": every tool result is persisted, the turn is capped, and each
 * step has to stay tenant-scoped to a tenant the model never sees. Owning the
 * loop keeps those three concerns in one readable place rather than spread
 * across runner hooks.
 */

export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

/** SPEC.md §7's model of record for this product. */
const MODEL = 'claude-opus-5';

/**
 * How many model round-trips one shopper turn may take.
 *
 * A turn normally needs two: one to decide on a tool, one to answer with the
 * result. Four leaves room for a genuine multi-tool answer ("find me a shirt
 * under 100k and tell me if it ships to Cali") while bounding the worst case —
 * a model that keeps calling tools without concluding would otherwise bill the
 * merchant unboundedly for a single question, and the shopper would watch a
 * spinner the whole time. On hitting the cap the loop stops and returns
 * whatever text it has, rather than erroring: a partial answer is more useful
 * to a shopper than a failure.
 */
const MAX_MODEL_TURNS = 4;

/** How much history goes to the model — SPEC.md §7's "last 20 messages". */
const HISTORY_LIMIT = 20;

export interface AgentReply {
  conversationId: string;
  text: string;
  /** Tool results from this turn, so a caller can render product cards or a
   * cart link rather than re-deriving them from prose. */
  toolResults: Array<{ name: string; result: unknown }>;
  /** True when the reply is the fixed out-of-budget text and no model call
   * happened. */
  budgetExhausted: boolean;
  /** True when the per-conversation throttle answered instead of the model —
   * either the message budget is spent or this is a repeat inside the
   * cool-down. Also no model call. */
  throttled: boolean;
}

/**
 * Progress emitted while a turn is still running, for the SSE transport.
 *
 * These are turn-level events, not token deltas: the widget learns the
 * conversation id immediately and can show "Buscando productos…" the moment a
 * tool runs, rather than a spinner until the whole answer lands. Token-level
 * streaming would mean driving the loop with `messages.stream()`, which is a
 * worthwhile follow-up but changes how tool round-trips are assembled; this
 * event contract is deliberately shaped so that swapping the transport
 * underneath it does not change what a caller consumes.
 */
export type AgentEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'tool'; name: string; result: unknown }
  | { type: 'message'; text: string };

/**
 * The tool list handed to the model. Schemas come from `@ventia/core`, next to
 * the Zod schemas the executors validate against — see that file for why the
 * two are written side by side and how a test keeps them in step.
 *
 * `escalate_to_human` is filtered out for a store whose plan does not include
 * handoff. Offering a tool and then refusing the call would teach the model to
 * promise a shopper a callback that is never coming; not offering it leaves the
 * prompt's fallback (give the store's contact details) as the only path, which
 * is what such a store can actually deliver.
 */
function buildToolDefinitions(handoffEnabled: boolean): Anthropic.Tool[] {
  const descriptions: Record<(typeof AGENT_TOOL_NAMES)[number], string> = {
    search_products: 'Busca productos de esta tienda por texto. Úsala siempre antes de mencionar un precio.',
    get_product: 'Trae el detalle completo de un producto, incluidas sus variantes y disponibilidad.',
    recommend_products:
      'Recomienda hasta 4 productos a partir de una necesidad descrita por el cliente. Prioriza los que hay en stock.',
    create_cart_link:
      'Crea un carrito con las variantes elegidas y devuelve el link para abrirlo. Úsala cuando el cliente quiera comprar.',
    get_order_status:
      'Consulta el estado de un pedido. Exige el número de pedido Y el correo o celular con que se compró.',
    get_store_info: 'Responde sobre envíos, devoluciones, pagos, contacto o la tienda, con la información publicada.',
    escalate_to_human:
      'Pasa la conversación a una persona del equipo. Úsala si el cliente está molesto, pide hablar con alguien, o llevas 3 intentos sin resolver.',
  };

  return AGENT_TOOL_NAMES.filter((name) => handoffEnabled || name !== 'escalate_to_human').map((name) => ({
    name,
    description: descriptions[name],
    input_schema: AGENT_TOOL_JSON_SCHEMAS[name] as unknown as Anthropic.Tool.InputSchema,
  }));
}

@Injectable()
export class AgentService {
  // Both variants built once. Which one a turn gets depends on the tenant's
  // plan, read alongside the budget below.
  private readonly toolsWithHandoff = buildToolDefinitions(true);
  private readonly toolsWithoutHandoff = buildToolDefinitions(false);

  constructor(
    @Inject(ANTHROPIC_CLIENT) private readonly anthropic: Anthropic,
    @Inject(AgentToolsService) private readonly toolExecutor: AgentToolsService,
    @Inject(AgentBudgetService) private readonly budget: AgentBudgetService,
    @Inject(AgentThrottleService) private readonly throttle: AgentThrottleService,
  ) {}

  /**
   * Answers one shopper message.
   *
   * `conversationId` is optional — absent starts a new conversation. It is
   * always re-checked against `tenantId` before use, so a caller passing
   * another store's conversation id gets a new conversation rather than
   * someone else's history.
   */
  async respond(input: {
    tenantId: string;
    conversationId?: string;
    shopperRef?: string;
    message: string;
    /** Called as the turn progresses, for the SSE transport. Synchronous and
     * best-effort — a caller whose connection has gone away should ignore the
     * event, not throw, since the turn is already paid for and still worth
     * persisting. */
    onEvent?: (event: AgentEvent) => void;
  }): Promise<AgentReply> {
    const { tenantId, message } = input;
    const db = tenantDb(tenantId);
    const emit = (event: AgentEvent) => {
      try {
        input.onEvent?.(event);
      } catch {
        // A dead SSE connection must not abort the turn.
      }
    };

    const conversation = await this.resolveConversation(tenantId, input.conversationId, input.shopperRef);
    emit({ type: 'conversation', conversationId: conversation.id });

    // Checked before ANYTHING is persisted: a throttled message costs the
    // merchant neither a row nor a token, which is the whole point — the
    // budget path below deliberately does persist, because a shopper refused
    // for budget is demand the merchant should see, whereas a client stuck in
    // a retry loop is not.
    const throttled = await this.throttle.check(conversation.id, message);
    if (throttled.kind !== 'allow') {
      // A repeat inside the cool-down gets the previous answer rather than a
      // scolding: from the shopper's side a double-tapped send should look
      // like it worked. Falling back to the throttle text covers the case
      // where there is no previous answer yet (the first turn is still in
      // flight), which is exactly when repeating is least useful.
      const text =
        throttled.kind === 'duplicate' ? ((await this.lastAssistantText(tenantId, conversation.id)) ?? THROTTLED_REPLY) : THROTTLED_REPLY;
      emit({ type: 'message', text });
      return {
        conversationId: conversation.id,
        text,
        toolResults: [],
        budgetExhausted: false,
        throttled: true,
      };
    }

    // The user's message is persisted BEFORE the budget check, so a turn
    // refused for budget still shows up in the transcript a merchant reads.
    // A shopper who asked something and got the fallback did ask it, and the
    // merchant needs to see that happening to understand why they should
    // upgrade.
    await db.message.create({
      data: { tenantId, conversationId: conversation.id, role: 'user', content: message },
    });

    const budget = await this.budget.check(tenantId);
    if (!budget.allowed) {
      // The hard cap: no model call at all, one fixed sentence. SPEC.md §7 is
      // explicit that this has no exceptions, which is why it sits here rather
      // than as an instruction in the prompt — a prompt rule is a request, and
      // the thing being enforced is a bill.
      await db.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          role: 'assistant',
          content: BUDGET_EXHAUSTED_REPLY,
        },
      });
      emit({ type: 'message', text: BUDGET_EXHAUSTED_REPLY });
      return {
        conversationId: conversation.id,
        text: BUDGET_EXHAUSTED_REPLY,
        toolResults: [],
        budgetExhausted: true,
        throttled: false,
      };
    }

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const system = buildSystemPrompt({
      storeName: tenant.name,
      agentConfig: tenant.agentConfig,
      handoffEnabled: budget.handoffEnabled,
    });
    const tools = budget.handoffEnabled ? this.toolsWithHandoff : this.toolsWithoutHandoff;

    const history = await this.loadHistory(tenantId, conversation.id);
    const messages: Anthropic.MessageParam[] = [...history];

    const toolResults: AgentReply['toolResults'] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let finalText = '';

    for (let turn = 0; turn < MAX_MODEL_TURNS; turn++) {
      const response = await this.anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        // Adaptive thinking with LOW effort: this is a sales chat, and a
        // shopper watching a widget feels every second. Low effort still
        // reasons about which tool to call — which is the only judgment this
        // agent makes — while keeping the reply fast and the per-message cost
        // predictable against a plan limit. Raise it if answers get shallow.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
        system,
        tools,
        messages,
      });

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;

      // Append the assistant turn verbatim. Not just the text: tool_use blocks
      // must come back unchanged or the follow-up tool_result has nothing to
      // attach to.
      messages.push({ role: 'assistant', content: response.content });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (text) finalText = text;

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (toolUses.length === 0) break;

      // Execute every tool the model asked for, then return ALL results in ONE
      // user message. Splitting them across messages would quietly train the
      // model out of asking for tools in parallel.
      const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const result = await this.toolExecutor.execute(
          // The tenant and the conversation come from THIS request, never from
          // anything the model produced — that is what keeps every tool scoped
          // to the store the shopper is actually talking to.
          { tenantId, conversationId: conversation.id, handoffEnabled: budget.handoffEnabled },
          toolUse.name,
          toolUse.input,
        );
        toolResults.push({ name: toolUse.name, result });
        emit({ type: 'tool', name: toolUse.name, result });
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
          // A tool that failed is reported as an error rather than dropped —
          // dropping it leaves the model waiting on a result that never comes.
          is_error: !result.ok,
        });
      }
      messages.push({ role: 'user', content: resultBlocks });

      await db.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          role: 'tool',
          content: '',
          toolCalls: toolResults.slice(-toolUses.length) as never,
        },
      });
    }

    await db.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        role: 'assistant',
        content: finalText,
        inputTokens,
        outputTokens,
      },
    });
    await this.budget.record(tenantId, { inputTokens, outputTokens });

    emit({ type: 'message', text: finalText });
    return {
      conversationId: conversation.id,
      text: finalText,
      toolResults,
      budgetExhausted: false,
      throttled: false,
    };
  }

  /** The most recent thing the agent said in this conversation, used to answer
   * a duplicate message without spending a turn on it. */
  private async lastAssistantText(tenantId: string, conversationId: string): Promise<string | null> {
    const row = await tenantDb(tenantId).message.findFirst({
      where: { tenantId, conversationId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
    });
    return row && row.content.trim().length > 0 ? row.content : null;
  }

  /** Finds this tenant's conversation or starts one. The tenant filter is what
   * stops a supplied id from reaching another store's transcript. */
  private async resolveConversation(tenantId: string, conversationId: string | undefined, shopperRef?: string) {
    const db = tenantDb(tenantId);
    if (conversationId) {
      const existing = await db.conversation.findFirst({ where: { id: conversationId, tenantId } });
      if (existing) return existing;
    }
    return db.conversation.create({
      data: { tenantId, channel: 'web', shopperRef: shopperRef ?? null, status: 'open' },
    });
  }

  /**
   * The last {@link HISTORY_LIMIT} messages, oldest first, as Anthropic
   * message params.
   *
   * Only `user` and `assistant` rows with real text are replayed. The `tool`
   * rows this service writes are a transcript record for the merchant, not
   * conversation state — replaying them would produce `tool_result` blocks
   * with no matching `tool_use` in the same history window, which the API
   * rejects. The model gets the same continuity a human reading the
   * transcript would.
   */
  private async loadHistory(tenantId: string, conversationId: string): Promise<Anthropic.MessageParam[]> {
    const rows = await tenantDb(tenantId).message.findMany({
      where: { tenantId, conversationId, role: { in: ['user', 'assistant'] } },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
    });

    return rows
      .reverse()
      .filter((row) => row.content.trim().length > 0)
      .map((row) => ({
        role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: row.content,
      }));
  }
}
