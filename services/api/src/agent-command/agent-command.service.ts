import { HttpException, Inject, Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { platformDb } from '@ventia/db';
import {
  COMMAND_TOOL_DESCRIPTIONS,
  COMMAND_TOOL_JSON_SCHEMAS,
  COMMAND_TOOL_NAMES,
  type AgentCommandResponse,
} from '@ventia/core';
import { ANTHROPIC_CLIENT } from '../agent/agent.service';
import { AgentBudgetService } from '../agent/agent-budget.service';
import { PLAN_LIMIT_ERROR, type PlanQuota } from '../common/plan-limits';
import { bogotaDayOf } from '../dashboard/bogota-day';
import { AgentCommandToolsService } from './agent-command-tools.service';
import { budgetAfterAnswering, decideCommandBudget, type MonthlyUsage } from './command-budget';
import { buildMerchantSystemPrompt } from './merchant-system-prompt';

/**
 * The merchant assistant's question loop: `POST /v1/admin/ai/command`
 * (docs/design-gap.md §7 item 6).
 *
 * A store owner asks about their own business in Spanish and gets an answer
 * grounded in their own rows — takings, orders, what stopped selling — never
 * an estimate. Shaped after `agent/agent.service.ts` (same injected client,
 * same manual loop, same turn cap, same cacheable system block) and sharing
 * none of its tools: see `agent-command-tools.service.ts` for why the two tool
 * sets must stay disjoint.
 *
 * ## One question, no thread
 *
 * Every call is self-contained: no history is loaded, none is persisted. The
 * reasoning is in `@ventia/core`'s `agentCommandInput` — the short version is
 * that `Conversation`/`Message` are the SHOPPER transcript, and the tablero
 * counts them, so filing the owner's own questions there would inflate the
 * very KPIs this assistant exists to explain. No new table was available to
 * this change, and inventing one inside the shopper's tables is worse than
 * doing without.
 *
 * ## The shared budget, and the floor under it
 *
 * This assistant spends the SAME `TenantLimits.aiMessagesMonth` as the shopper
 * agent, through the same {@link AgentBudgetService}, and one merchant question
 * is one message however many model round-trips and tool calls it takes. That
 * was decided deliberately: the plan sells "mensajes de IA", two questions a
 * day is about 60 a month against básico's 500, and a second quota would be a
 * number the merchant was never sold and cannot reason about.
 *
 * It has a consequence that had to be handled rather than noted:
 * **a merchant spending their allowance on business questions makes their
 * shopper agent go silent, and the shopper agent is the thing that earns them
 * the money.** An owner exploring their numbers on the 3rd of the month could
 * leave their storefront answering every customer with the fixed
 * out-of-budget sentence for the remaining four weeks, and nothing in the
 * product would connect the two events.
 *
 * Two mechanisms answer that, and both are here rather than in the shopper
 * loop, because it is THIS surface that must yield:
 *
 *  1. `SHOPPER_RESERVE_FRACTION` (command-budget.ts) — a floor. Once the month's usage
 *     reaches the limit minus the reserve, this endpoint refuses with a 402
 *     while the shopper agent keeps answering customers on what is left. The
 *     merchant assistant runs out first, on purpose. It is the one whose
 *     silence costs nothing.
 *  2. Every successful answer returns `AgentCommandBudget`, so the admin
 *     UI can show what the question cost against the plan AND how close the
 *     storefront is to going quiet — the second number being the one a
 *     merchant would never think to ask for and most needs to see.
 *
 * ## What the merchant is NOT charged for
 *
 * A question refused by either branch costs nothing: `record()` runs only
 * after an answer exists. Same direction as the shopper loop — over-counting
 * bills a merchant for something they did not get, and there is no refund
 * path.
 */

/**
 * How many model round-trips one merchant question may take.
 *
 * A typical question needs two: one to pick a tool, one to answer with the
 * result. Four leaves room for a genuinely multi-tool question ("¿por qué
 * vendí menos esta semana y qué producto se frenó?", which wants the tablero
 * AND the catalogue ranking) while bounding the worst case — a model that
 * keeps calling tools without concluding would otherwise bill one question
 * unboundedly against the plan the storefront also depends on.
 *
 * On hitting the cap the loop returns whatever text it has rather than
 * erroring: a partial answer a merchant can sanity-check beats a failure.
 */
const MAX_MODEL_TURNS = 4;

/**
 * The tool array handed to the model.
 *
 * Built ONCE at module scope and never rebuilt per request. That is a
 * correctness requirement, not a micro-optimisation: the cacheable prefix is
 * `tools -> system -> messages`, so a tool array reassembled per call — with
 * any key-order or whitespace difference — would silently invalidate the
 * prompt cache on every single question and quietly restore the full input
 * bill this loop marks its system block to avoid.
 *
 * Unlike the shopper's, this list is not plan-gated: none of these three tools
 * is a paid feature, and there is no variant of it to choose between.
 */
const COMMAND_TOOLS: Anthropic.Tool[] = COMMAND_TOOL_NAMES.map((name) => ({
  name,
  description: COMMAND_TOOL_DESCRIPTIONS[name],
  input_schema: COMMAND_TOOL_JSON_SCHEMAS[name] as unknown as Anthropic.Tool.InputSchema,
}));

/** Env var overriding the model this assistant runs on, kept separate from the
 * shopper's `AGENT_MODEL` so an operator can move one without moving the
 * other — they answer different people and have different quality floors. */
export const COMMAND_MODEL_ENV = 'AGENT_COMMAND_MODEL';

/** SPEC.md §7's model of record for this product. */
export const DEFAULT_COMMAND_MODEL = 'claude-opus-5';

export function commandModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env[COMMAND_MODEL_ENV] ?? '').trim();
  return configured.length > 0 ? configured : DEFAULT_COMMAND_MODEL;
}

@Injectable()
export class AgentCommandService {
  constructor(
    @Inject(ANTHROPIC_CLIENT) private readonly anthropic: Anthropic,
    @Inject(AgentCommandToolsService) private readonly tools: AgentCommandToolsService,
    @Inject(AgentBudgetService) private readonly budget: AgentBudgetService,
  ) {}

  /**
   * Answers one merchant question.
   *
   * `tenantId` comes from the caller's admin session and is passed to every
   * tool execution below. It is never read from the body and never from
   * anything the model produced — that single fact is what keeps one store's
   * takings out of another store's assistant.
   *
   * @param now injected so tests can pin "today" rather than race a Bogota
   *   midnight, matching `DashboardService.summary`. Production callers omit it.
   */
  async ask(input: { tenantId: string; question: string }, now: Date = new Date()): Promise<AgentCommandResponse> {
    const { tenantId, question } = input;

    // Checked BEFORE anything else, and before any model call: the cap is a
    // bill, so it is enforced in code rather than requested in a prompt.
    const status = await this.budget.check(tenantId, now);
    this.assertAllowed(status);

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const system = buildMerchantSystemPrompt({ storeName: tenant.name });

    /**
     * Today's date rides in the USER turn, not the system block.
     *
     * The model has to know what "hoy" and "esta semana" mean, and only the
     * server may say — a model asserting a date is how an assistant ends up
     * confidently answering about the wrong week. But a date in the system
     * block would change its bytes every midnight and evict the cached prefix
     * for every store, once a day, forever. Putting it after the last cache
     * breakpoint keeps the prefix byte-identical for the life of the tenant
     * and costs nothing: the date is a dozen tokens either way.
     */
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `Hoy es ${bogotaDayOf(now)} en Colombia.\n\nPregunta de la tienda: ${question}`,
      },
    ];

    const usedTools: AgentCommandResponse['usedTools'] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    let answer = '';

    for (let turn = 0; turn < MAX_MODEL_TURNS; turn++) {
      const response = await this.anthropic.messages.create({
        model: commandModel(),
        max_tokens: 2048,
        // Adaptive thinking, at MEDIUM effort rather than the shopper loop's
        // low. The judgement here is harder than "which tool answers this":
        // "¿por qué vendí menos esta semana?" means reading a comparison
        // against the previous window, noticing which panel moved, and saying
        // so without over-claiming a cause. Low effort produced answers that
        // recited the tiles back. This is also a merchant waiting on their own
        // screen rather than a shopper watching a chat widget, so a slower,
        // better answer is the right trade — and it is one question, not one
        // per customer.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        // Marked cacheable, exactly as the shopper loop marks its own. The
        // cacheable prefix is tools -> system -> messages, so this one
        // breakpoint covers the tool schemas too; both are byte-identical on
        // every turn of every question for a given tenant. Without it they are
        // re-sent and re-billed at full input price on each of the up-to-four
        // round-trips a single question makes.
        //
        // Below the provider's minimum cacheable length the marker is ignored
        // rather than rejected, so a short prompt degrades to exactly the
        // previous behaviour.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: COMMAND_TOOLS,
        messages,
      });

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      // Cache tokens are reported SEPARATELY from `input_tokens` and billed at
      // different rates. Folding them into `inputTokens` would price a cache
      // hit as a full-price read and hide the saving the breakpoint exists to
      // produce — see agent-pricing.ts.
      cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
      cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

      // Appended verbatim. Not just the text: `tool_use` blocks must come back
      // unchanged or the follow-up `tool_result` has nothing to attach to.
      messages.push({ role: 'assistant', content: response.content });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (text) answer = text;

      const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
      if (toolUses.length === 0) break;

      // Every tool the model asked for, then ALL results in ONE user message.
      // Splitting them across messages would quietly train the model out of
      // asking for tools in parallel.
      const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const result = await this.tools.execute(
          // The tenant comes from THIS request. Never from the model.
          { tenantId },
          toolUse.name,
          toolUse.input,
          now,
        );
        usedTools.push({ name: toolUse.name, ok: result.ok });
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
          // A failed tool is reported as an error rather than dropped —
          // dropping it leaves the model waiting on a result that never comes,
          // and a merchant answered from a silently missing lookup is exactly
          // the invented number this feature must not produce.
          is_error: !result.ok,
        });
      }
      messages.push({ role: 'user', content: resultBlocks });
    }

    // Recorded only now, so a question that failed mid-flight costs nothing.
    await this.budget.record(tenantId, { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens }, now);

    return {
      answer,
      usedTools,
      // Derived from the status read before this turn plus the one message
      // just recorded, rather than re-reading the row. Under concurrency it
      // can be a message or two behind — the same bounded imprecision
      // `AgentBudgetService` already documents for its check/record split, and
      // a second round-trip to the counter would not remove it.
      budget: budgetAfterAnswering(status),
    };
  }

  /**
   * Refuses the question when the month's allowance is gone, or when
   * continuing would eat into the shoppers' reserve.
   *
   * A 402 carrying `PLAN_LIMIT_EXCEEDED`, which is the code the whole stack
   * already agreed on — `apps/admin/lib/api.ts` turns it into an `ApiError`
   * the UI maps to one upgrade prompt. `details.reason` distinguishes the two
   * cases because they are different problems: one is "upgrade or wait for
   * next month", the other is "your customers still have messages and I am
   * leaving them alone", and a merchant told the first when the second is true
   * would upgrade to fix something that is not broken.
   *
   * Which of the two applies is decided in `command-budget.ts`, so the whole
   * judgement is testable without a database or a model call.
   */
  private assertAllowed(usage: MonthlyUsage): void {
    const { refusal } = decideCommandBudget(usage);
    if (refusal === null) return;

    throw new HttpException(
      {
        error: PLAN_LIMIT_ERROR,
        // `feature` names the quota exactly as `common/plan-limits.ts` spells
        // it, so the admin UI's existing upgrade prompt needs no special case
        // for this endpoint.
        details: { feature: 'aiMessagesMonth' satisfies PlanQuota, limit: usage.limit, reason: refusal },
      },
      402,
    );
  }
}
