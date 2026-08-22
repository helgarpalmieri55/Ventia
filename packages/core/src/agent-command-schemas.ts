import { z } from 'zod';
import type { AgentToolJsonSchema } from './agent-tools.js';
import { dashboardDaySchema } from './dashboard-schemas.js';

/**
 * Contract for `POST /v1/admin/ai/command` — the MERCHANT's assistant
 * (docs/design-gap.md §7 item 6).
 *
 * ## This is not the shopper agent, and shares no tool with it
 *
 * `agent-tools.ts` next door defines what an AI salesperson may do on behalf
 * of a store: search the catalogue a shopper can see, build them a cart, look
 * up their order behind a double factor. This file defines what a STORE OWNER
 * may ask about their own business: takings, orders, which product has stopped
 * moving, what a thing costs them.
 *
 * The two sets are deliberately disjoint, and the separation is the point
 * rather than an accident of scope. A merchant asking "¿cuál es mi margen en
 * las camisas?" must not be answered by a model holding `create_cart_link`,
 * because a tool offered is a tool that will eventually be called on a misread
 * question — and a cart invented out of a margin question is a fake order in
 * the merchant's own books. In the other direction, `cost_cents` below is the
 * merchant's purchase price: handing that to the shopper loop would put it one
 * confused sentence away from a customer's chat window.
 *
 * ## Everything here is READ-ONLY, and that is a product decision
 *
 * There is no tool to change a price, publish a product, cancel an order or
 * refund a payment, and none should be added here. An assistant that can only
 * read is wrong at worst; an assistant that can act on a misread question is a
 * different product with a different risk profile. If write access is ever
 * wanted it needs its own design — a confirmation step, an audit trail, a
 * narrower blast radius — not one more entry in the array below.
 *
 * ## Why the schemas live in `@ventia/core`
 *
 * Same reason as `agent-tools.ts`: `services/api` deliberately carries no
 * direct `zod` dependency (see `services/api/src/catalog/parse.ts` for the
 * pnpm peer-resolution hazard behind that), so every schema its controllers
 * and executors parse against is owned by this package. The JSON Schemas are
 * written out by hand beside the Zod ones for the reason documented on
 * {@link AgentToolJsonSchema}'s home in `agent-tools.ts`, and
 * `services/api/test/agent-command-schemas.test.ts` is what stops the two
 * drifting.
 *
 * ## Naming
 *
 * Tool and field names are snake_case, matching the shopper tools and what
 * reads naturally to the model, and are therefore deliberately inconsistent
 * with this codebase's camelCase. Descriptions are in Colombian Spanish
 * because the merchant's question is, and because the model reasons about the
 * fields in the language it will answer in.
 */

/**
 * The window every tool accepts, in Colombian civil days.
 *
 * Reuses `dashboardDaySchema` rather than restating a date regex, so a window
 * this assistant reports on is exactly a window the merchant's own
 * `/v1/admin/dashboard` would accept — including its rejection of `2026-02-31`,
 * which a bare regex waves through and which would otherwise roll into March
 * and answer about a range nobody asked for.
 *
 * Both bounds are optional. Omitting them means the same default window the
 * tablero uses, resolved server-side from the clock: only the server knows
 * what "hoy" is in Bogota, and letting the model assert a date is exactly how
 * an assistant ends up confidently answering about the wrong week.
 */
const WINDOW = {
  from: dashboardDaySchema.optional(),
  to: dashboardDaySchema.optional(),
};

/** Shared window description, so the three tools teach the model one story
 * about dates instead of three subtly different ones. */
const FROM_DESCRIPTION =
  'Primer día del rango, AAAA-MM-DD, hora civil colombiana. Opcional: si lo omites se usa la ventana por defecto del tablero.';
const TO_DESCRIPTION = 'Último día del rango, AAAA-MM-DD, inclusive. Opcional: si lo omites se usa hoy en Colombia.';

/**
 * The merchant's tablero for a window, straight from `DashboardService` —
 * takings, orders, conversations, the AI-resolution rate, the daily series,
 * top products, sales by channel and payment mix, each against the equivalent
 * previous window.
 *
 * Deliberately the SAME service the `/v1/admin/dashboard` screen calls, not a
 * second set of aggregations. A merchant who is told "vendiste 12% menos que
 * la semana pasada" and then opens their own tablero and reads a different
 * number has been given two answers by one product, and has no way to tell
 * which is the lie. Sharing the computation makes disagreement impossible
 * rather than unlikely.
 */
export const businessSummaryInput = z.object(WINDOW);
export type BusinessSummaryInput = z.infer<typeof businessSummaryInput>;

/**
 * How `get_product_performance` ranks the catalogue.
 *
 * The RANKING happens on the server, not in the model, and that is the whole
 * reason this field exists instead of a tool that returns the catalogue and
 * lets the model sort it. "¿Qué producto se está quedando quieto?" is a join
 * between every product a store stocks and every unit it sold in a window; a
 * model handed the two lists and asked to join them will get it approximately
 * right, and approximately right is a merchant marking down the wrong product.
 */
export const PRODUCT_PERFORMANCE_SORTS = ['slowest', 'bestselling', 'lowest_stock'] as const;
export type ProductPerformanceSort = (typeof PRODUCT_PERFORMANCE_SORTS)[number];

export const productPerformanceInput = z.object({
  ...WINDOW,
  sort: z.enum(PRODUCT_PERFORMANCE_SORTS),
  // Capped low for the same reason the shopper tools are: a short, ranked,
  // high-signal list is what the model can actually reason about, and every
  // extra row is billed to the merchant's own plan on this turn AND on every
  // later turn of the same question.
  limit: z.number().int().min(1).max(20).default(10),
});
export type ProductPerformanceInput = z.infer<typeof productPerformanceInput>;

/**
 * Orders in a window, broken down by state.
 *
 * Overlaps the tablero's order COUNT on purpose and answers a different
 * question: the tablero says how many orders there were, this says how many
 * are still waiting to be confirmed, packed or paid. "¿Cuántos pedidos van
 * hoy?" is the first, "¿tengo algo sin despachar?" is the second, and a
 * merchant asks both in the same breath.
 */
export const ordersSnapshotInput = z.object({
  ...WINDOW,
  /** How many individual recent orders to list alongside the counts. The
   * counts are always complete for the window; this bounds only the sample. */
  limit: z.number().int().min(1).max(20).default(10),
});
export type OrdersSnapshotInput = z.infer<typeof ordersSnapshotInput>;

/**
 * Every tool the merchant assistant may be offered.
 *
 * The executor map is keyed by this, so a name added here without an executor
 * fails to compile rather than failing in front of a merchant.
 */
export const COMMAND_TOOL_NAMES = ['get_business_summary', 'get_product_performance', 'get_orders_snapshot'] as const;

export type CommandToolName = (typeof COMMAND_TOOL_NAMES)[number];

/** What each tool is FOR, in the model's words. Kept beside the schemas rather
 * than in the API service so the whole contract the model sees — names,
 * descriptions, field meanings — is readable in one file. */
export const COMMAND_TOOL_DESCRIPTIONS: Record<CommandToolName, string> = {
  get_business_summary:
    'Ventas, pedidos, conversaciones y resolución de la IA en un rango, comparados contra el rango anterior equivalente. Incluye la serie diaria, los productos más vendidos, las ventas por canal y los medios de pago. Es la MISMA información del tablero del comerciante: úsala siempre antes de afirmar cualquier cifra de ventas.',
  get_product_performance:
    'Lista productos del catálogo ordenados por lo que se movió (o no se movió) en el rango: unidades vendidas, ingresos, stock actual y costo. Úsala para "qué se está quedando quieto", "qué se está agotando" y preguntas de margen.',
  get_orders_snapshot:
    'Pedidos del rango contados por estado y por estado de pago, más los más recientes. Úsala para "cuántos pedidos van", "qué falta por despachar" o "qué está sin pagar". No devuelve datos personales de los clientes.',
};

export const COMMAND_TOOL_JSON_SCHEMAS: Record<CommandToolName, AgentToolJsonSchema> = {
  get_business_summary: {
    type: 'object',
    properties: {
      from: { type: 'string', description: FROM_DESCRIPTION },
      to: { type: 'string', description: TO_DESCRIPTION },
    },
    // No required fields: the commonest merchant question ("¿cómo vamos?")
    // carries no dates at all, and forcing the model to invent a pair is how
    // it ends up answering about a window the merchant never asked for.
    additionalProperties: false,
  },
  get_product_performance: {
    type: 'object',
    properties: {
      from: { type: 'string', description: FROM_DESCRIPTION },
      to: { type: 'string', description: TO_DESCRIPTION },
      sort: {
        type: 'string',
        enum: [...PRODUCT_PERFORMANCE_SORTS],
        description:
          'slowest = los que MENOS se vendieron en el rango teniendo stock (para "se está quedando quieto"); bestselling = los que más se vendieron; lowest_stock = los que menos unidades quedan (para "se está agotando").',
      },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Cuántos productos traer (por defecto 10).' },
    },
    required: ['sort'],
    additionalProperties: false,
  },
  get_orders_snapshot: {
    type: 'object',
    properties: {
      from: { type: 'string', description: FROM_DESCRIPTION },
      to: { type: 'string', description: TO_DESCRIPTION },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Cuántos pedidos recientes listar (por defecto 10). Los conteos por estado siempre cubren TODO el rango.',
      },
    },
    additionalProperties: false,
  },
};

/**
 * The body of `POST /v1/admin/ai/command`.
 *
 * Note what is NOT in it: the tenant. That comes from the admin session, never
 * from the body — a merchant who could name a tenant could read another
 * store's takings, which is the one failure this whole surface must not have.
 *
 * Note also what else is not in it: any conversation history. This endpoint
 * answers ONE question per call and holds no thread. Two reasons, both
 * deliberate:
 *
 *  1. There is nowhere to put a merchant thread. `Conversation`/`Message` are
 *     the SHOPPER transcript — the merchant reads them on /conversaciones, and
 *     the tablero counts them for the "conversaciones" tile and the
 *     AI-resolution rate. Writing the owner's own questions there would inflate
 *     the very KPIs this assistant is supposed to explain, and no new table is
 *     available to this change.
 *  2. A client-supplied history is unbounded input billed to the merchant's own
 *     plan on every turn, and it lets the caller put words in the assistant's
 *     mouth by labelling them `assistant`.
 *
 * Follow-up questions therefore have to restate their context. That is a real
 * limitation, stated here rather than papered over.
 */
export const agentCommandInput = z.object({
  // Bounded because every character is billed to the merchant's own AI
  // allowance. A thousand is far more than a question needs and far less than
  // a pasted report.
  question: z.string().trim().min(1).max(1000),
});

export type AgentCommandInput = z.infer<typeof agentCommandInput>;

/**
 * What the merchant assistant costs against the plan, returned on every
 * answered question.
 *
 * This exists because of a consequence the shared counter creates: the
 * merchant assistant and the shopper agent spend the SAME
 * `TenantLimits.aiMessagesMonth`, so an owner who spends an afternoon asking
 * questions is spending the budget that answers their customers. The admin UI
 * cannot warn about that unless the server says so on every answer, so it does
 * — see `SHOPPER_RESERVE_FRACTION` in the API service for the floor that keeps
 * the spending from ever reaching zero.
 */
export interface AgentCommandBudget {
  /** Messages spent this month, across BOTH assistants, after this answer. */
  used: number;
  /** `TenantLimits.aiMessagesMonth`. Zero for a tenant with no plan row. */
  limit: number;
  /** Messages held back for shoppers, which this assistant will not spend. */
  shopperReserve: number;
  /** How many more questions this assistant will answer before it stops to
   * protect the shopper agent. Never negative. */
  remainingForCommands: number;
  /** How many messages remain before the SHOPPER agent goes silent too. Shown
   * alongside the figure above so a merchant can see what their own questions
   * are costing their storefront. */
  remainingTotal: number;
  /** True from 90% of the limit onward — SPEC.md §7's merchant warning. */
  warning: boolean;
}

/** The reason a question was refused, in `details.reason` of the 402. Lets the
 * admin UI say "se acabó" and "lo estoy guardando para tus clientes"
 * differently, which are different problems with different remedies. */
export type AgentCommandRefusalReason = 'exhausted' | 'shopper_reserve';

/** What `POST /v1/admin/ai/command` answers with. */
export interface AgentCommandResponse {
  /** The assistant's answer, in Colombian Spanish. */
  answer: string;
  /**
   * Which tools ran, in order, and whether each succeeded.
   *
   * Returned so the admin UI can show what the answer was grounded in, and so
   * a merchant who gets a surprising number can tell "it looked" from "it
   * guessed". A turn with an empty array and a confident figure in `answer` is
   * a bug worth being able to see.
   */
  usedTools: Array<{ name: string; ok: boolean }>;
  budget: AgentCommandBudget;
}
