import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_NAMES,
  COMMAND_TOOL_DESCRIPTIONS,
  COMMAND_TOOL_JSON_SCHEMAS,
  COMMAND_TOOL_NAMES,
  agentCommandInput,
  businessSummaryInput,
  ordersSnapshotInput,
  productPerformanceInput,
  type CommandToolName,
} from '@ventia/core';
import {
  SHOPPER_RESERVE_FRACTION,
  budgetAfterAnswering,
  decideCommandBudget,
} from '../src/agent-command/command-budget';

/**
 * The merchant assistant's two contracts that need no database: who gets the
 * last AI message of the month, and what the model is told it may ask for.
 *
 * Both are pure by construction (`command-budget.ts` is structurally typed and
 * imports no Prisma client; the schemas live in `@ventia/core`), which is the
 * point — these are the decisions most likely to be argued with later, and an
 * argument settled by running a test is shorter than one settled by reading a
 * loop. The integration suite next door drives the same rules through a real
 * request; this file pins the arithmetic and the boundaries.
 */

/** básico's allowance, per docs/SPEC.md §5 — the plan every one of these
 * numbers is meant to be sane for. */
const BASICO = 500;

describe('the shopper reserve — who runs out first', () => {
  it('holds back a fifth of the plan for shoppers', () => {
    const { budget } = decideCommandBudget({ used: 0, limit: BASICO, warning: false });

    expect(budget.shopperReserve).toBe(100);
    // The merchant may ask 400 questions; the storefront keeps 100 messages
    // whatever the owner does.
    expect(budget.remainingForCommands).toBe(400);
    expect(budget.remainingTotal).toBe(BASICO);
  });

  it('answers the last question before the reserve, and refuses the next one', () => {
    // The boundary, spelled out in two assertions rather than one: an
    // off-by-one here either cheats the merchant of a question they paid for
    // or spends the shoppers' first reserved message.
    expect(decideCommandBudget({ used: 399, limit: BASICO, warning: true }).refusal).toBeNull();
    expect(decideCommandBudget({ used: 400, limit: BASICO, warning: true }).refusal).toBe('shopper_reserve');
  });

  it('says the allowance is EXHAUSTED, not reserved, once nothing is left at all', () => {
    // Order-dependent, and the order is load-bearing: at 500/500 the shoppers'
    // reserve is also gone, so telling the merchant "lo estoy guardando para
    // tus clientes" would be false at exactly the moment they most need to
    // know to upgrade.
    expect(decideCommandBudget({ used: BASICO, limit: BASICO, warning: true }).refusal).toBe('exhausted');
  });

  it('never reports a negative remainder, however far over the counter has run', () => {
    // The check/record split in AgentBudgetService allows a small concurrent
    // over-run, so `used > limit` is a state that really happens. "Te quedan
    // -3 mensajes" is not something to render to a merchant.
    const { budget, refusal } = decideCommandBudget({ used: 512, limit: BASICO, warning: true });

    expect(budget.remainingForCommands).toBe(0);
    expect(budget.remainingTotal).toBe(0);
    expect(refusal).toBe('exhausted');
  });

  it('treats an unprovisioned store as having nothing, not as having everything', () => {
    // `AgentBudgetService.check` reports limit 0 for a tenant with no
    // TenantLimits row. Free unmetered AI is the failure that costs money and
    // hides itself.
    const { budget, refusal } = decideCommandBudget({ used: 0, limit: 0, warning: false });

    expect(budget.shopperReserve).toBe(0);
    expect(budget.remainingTotal).toBe(0);
    expect(refusal).toBe('exhausted');
  });

  it('rounds the reserve UP, so a tiny plan still protects its storefront', () => {
    // 20% of 10 is exactly 2; 20% of 9 is 1.8, which must not round down to 1.
    expect(decideCommandBudget({ used: 0, limit: 10, warning: false }).budget.shopperReserve).toBe(2);
    expect(decideCommandBudget({ used: 0, limit: 9, warning: false }).budget.shopperReserve).toBe(2);
    // And the merchant stops at 8 of 10, leaving the two reserved messages.
    expect(decideCommandBudget({ used: 7, limit: 10, warning: false }).refusal).toBeNull();
    expect(decideCommandBudget({ used: 8, limit: 10, warning: false }).refusal).toBe('shopper_reserve');
  });

  it('gives a one-message plan to the shopper, not to the merchant', () => {
    // The deliberate extreme of the rule. The storefront is what earns the
    // money, so when there is exactly one message to allocate it goes there —
    // and the merchant is told WHY, rather than being told they are out.
    const { refusal } = decideCommandBudget({ used: 0, limit: 1, warning: false });
    expect(refusal).toBe('shopper_reserve');
  });

  it('carries the 90% warning through untouched', () => {
    // Computed by AgentBudgetService against the FULL limit, deliberately not
    // recomputed against the reserve: it is SPEC §7's merchant warning about
    // the plan, and the admin agent-usage screen must agree with this one.
    expect(decideCommandBudget({ used: 450, limit: BASICO, warning: true }).budget.warning).toBe(true);
    expect(decideCommandBudget({ used: 10, limit: BASICO, warning: false }).budget.warning).toBe(false);
  });

  it('reports the budget as it will stand AFTER the answer, advanced by what the answer cost', () => {
    // "Te quedan N" has to mean N MORE questions. Showing the pre-answer
    // figure would tell a merchant on their last question that they still have
    // one.
    //
    // It advances by TWO, the cost of a merchant question — not by one. The
    // number beside it is credits, and advancing by one would have this screen
    // disagree with the counter it is reporting, drifting a credit per question
    // until it was visibly wrong.
    const after = budgetAfterAnswering({ used: 10, limit: BASICO, warning: false });

    expect(after.used).toBe(12);
    expect(after.remainingForCommands).toBe(388);
    expect(after.remainingTotal).toBe(488);
  });

  it('reserves a fifth', () => {
    // Pinned so a change to the fraction is a deliberate edit to this line
    // rather than a silent shift in who goes quiet first.
    expect(SHOPPER_RESERVE_FRACTION).toBe(0.2);
  });
});

describe('the merchant assistant shares no tool with the shopper agent', () => {
  it('has no tool name in common with the sales agent', () => {
    // The invariant this whole module is built around. A merchant asking about
    // margins must never be answered by a model holding `create_cart_link`: a
    // tool offered is a tool that eventually gets called on a misread
    // question, and a cart invented out of a margin question is a fake order
    // in the merchant's own books.
    const shopper = new Set<string>(AGENT_TOOL_NAMES);
    for (const name of COMMAND_TOOL_NAMES) {
      expect(shopper.has(name), `${name} is offered to BOTH audiences`).toBe(false);
    }
  });

  it('offers nothing that writes', () => {
    // A crude but load-bearing guard. Every tool here is a query, and the
    // cheapest way to notice that someone added `update_price` is to fail on
    // the verb. If a legitimate read tool ever trips this, rename the tool —
    // do not loosen the list.
    const WRITE_VERBS = ['create', 'update', 'set', 'delete', 'cancel', 'refund', 'publish', 'archive', 'send'];
    for (const name of COMMAND_TOOL_NAMES) {
      for (const verb of WRITE_VERBS) {
        expect(name.startsWith(`${verb}_`), `${name} reads like a write tool`).toBe(false);
      }
    }
  });
});

/**
 * The two schemas per tool — a Zod one deciding whether the model's output is
 * SAFE to execute, and a JSON Schema teaching the model what each field means
 * — are written side by side rather than derived (see `agent-tools.ts` for why
 * the derivation does not survive this repo's Zod versions). These are what
 * stop them drifting.
 *
 * Drift is not cosmetic. A field required by Zod but optional in the JSON
 * Schema tells the model it may omit something the executor will reject — the
 * tool then fails in front of a merchant for a reason the model cannot see.
 * The reverse is worse: the model is invited to send something silently
 * dropped, so a date it carefully chose is ignored and the answer quietly
 * covers the wrong window.
 *
 * ## Why optionality is probed rather than introspected
 *
 * The equivalent test in `packages/core` reads Zod's internals
 * (`field.isOptional()`, `instanceof z.ZodDefault`). This package deliberately
 * carries NO direct `zod` dependency — see `src/catalog/parse.ts` for the pnpm
 * peer-resolution hazard behind that — so these probe the behaviour instead:
 * a field is optional to the model exactly when omitting it still parses.
 * That happens to be the better test. It is the property the model actually
 * depends on, and it stays true through any future refactor of how the schema
 * expresses optionality.
 */

/** The schema surface these assertions use, declared structurally so this file
 * needs no `zod` import. `@ventia/core`'s exported schemas satisfy it. */
interface ProbeSchema {
  shape: Record<string, unknown>;
  safeParse(data: unknown): { success: boolean };
  parse(data: unknown): unknown;
}

const ZOD_SCHEMAS: Record<CommandToolName, ProbeSchema> = {
  get_business_summary: businessSummaryInput,
  get_product_performance: productPerformanceInput,
  get_orders_snapshot: ordersSnapshotInput,
};

/** One fully-populated, valid input per tool — the baseline every probe below
 * removes a single field from. Every property of the schema must appear here,
 * which the first assertion checks, so a new field cannot be added without
 * being covered. */
const FULL_INPUTS: Record<CommandToolName, Record<string, unknown>> = {
  get_business_summary: { from: '2026-08-10', to: '2026-08-16' },
  get_product_performance: { from: '2026-08-10', to: '2026-08-16', sort: 'slowest', limit: 5 },
  get_orders_snapshot: { from: '2026-08-10', to: '2026-08-16', limit: 5 },
};

/** The fields the model may omit: probed by removing each in turn from a valid
 * input and seeing whether it still parses. */
function omittableFields(name: CommandToolName): string[] {
  const schema = ZOD_SCHEMAS[name];
  return Object.keys(schema.shape).filter((key) => {
    const withoutIt = { ...FULL_INPUTS[name] };
    delete withoutIt[key];
    return schema.safeParse(withoutIt).success;
  });
}

describe('command tool schemas — the two definitions agree', () => {
  it.each(COMMAND_TOOL_NAMES)('%s exposes the same properties in both', (name) => {
    expect(Object.keys(COMMAND_TOOL_JSON_SCHEMAS[name].properties).sort()).toEqual(
      Object.keys(ZOD_SCHEMAS[name].shape).sort(),
    );
  });

  it.each(COMMAND_TOOL_NAMES)('%s has every property covered by the probe baseline', (name) => {
    // Without this, a field added to a schema and not to FULL_INPUTS would be
    // "omitted" in every probe and the required-set assertion below would pass
    // vacuously.
    expect(Object.keys(FULL_INPUTS[name]).sort()).toEqual(Object.keys(ZOD_SCHEMAS[name].shape).sort());
    expect(ZOD_SCHEMAS[name].safeParse(FULL_INPUTS[name]).success).toBe(true);
  });

  it.each(COMMAND_TOOL_NAMES)('%s marks the same fields required in both', (name) => {
    const omittable = new Set(omittableFields(name));
    const actuallyRequired = Object.keys(ZOD_SCHEMAS[name].shape).filter((key) => !omittable.has(key));

    expect([...(COMMAND_TOOL_JSON_SCHEMAS[name].required ?? [])].sort()).toEqual(actuallyRequired.sort());
  });

  it.each(COMMAND_TOOL_NAMES)('%s refuses unknown properties, so a hallucinated field is not silently dropped', (name) => {
    expect(COMMAND_TOOL_JSON_SCHEMAS[name].additionalProperties).toBe(false);
  });

  it('every tool name has a Zod schema, a JSON schema and a description', () => {
    // Guards the case where a fourth tool is added and only some of the three
    // definitions follow it — the model would then be offered a tool with no
    // executable contract.
    for (const name of COMMAND_TOOL_NAMES) {
      expect(ZOD_SCHEMAS[name], `missing Zod schema for ${name}`).toBeDefined();
      expect(COMMAND_TOOL_JSON_SCHEMAS[name], `missing JSON schema for ${name}`).toBeDefined();
      expect(COMMAND_TOOL_DESCRIPTIONS[name], `missing description for ${name}`).toBeTruthy();
    }
  });

  it('rejects a date the calendar does not have', () => {
    // Inherited from `dashboardDaySchema`, and the reason this reuses it: a
    // bare YYYY-MM-DD regex waves 2026-02-31 through, and it then rolls into
    // March and answers about a window nobody asked for.
    expect(businessSummaryInput.safeParse({ from: '2026-02-31' }).success).toBe(false);
    expect(businessSummaryInput.safeParse({ from: '2026-02-28' }).success).toBe(true);
  });

  it('defaults the list size rather than letting the model choose nothing', () => {
    expect(productPerformanceInput.parse({ sort: 'slowest' }).limit).toBe(10);
  });

  it('refuses a sort the model invented', () => {
    expect(productPerformanceInput.safeParse({ sort: 'most_profitable' }).success).toBe(false);
  });
});

describe('the request body', () => {
  it('trims and requires a question', () => {
    expect(agentCommandInput.parse({ question: '  ¿cuántos pedidos van hoy?  ' }).question).toBe(
      '¿cuántos pedidos van hoy?',
    );
    expect(agentCommandInput.safeParse({ question: '   ' }).success).toBe(false);
  });

  it('refuses a pasted report', () => {
    // Every character is billed against the plan the storefront shares, so the
    // bound is a cost control rather than a formality.
    expect(agentCommandInput.safeParse({ question: 'a'.repeat(1001) }).success).toBe(false);
    expect(agentCommandInput.safeParse({ question: 'a'.repeat(1000) }).success).toBe(true);
  });

  it('has no field by which a caller could name a tenant', () => {
    // The whole security story of this endpoint: the tenant comes from the
    // admin session. A body field would be a way around that.
    expect(Object.keys(agentCommandInput.shape)).toEqual(['question']);
  });
});
