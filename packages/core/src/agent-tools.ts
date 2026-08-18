import { z } from 'zod';

/**
 * Input schemas for the AI sales agent's tools (docs/SPEC.md §7).
 *
 * These live in `@ventia/core` rather than next to the executors because they
 * are the one definition two different consumers must agree on: the JSON
 * Schema handed to Claude in the `tools` array, and the runtime validation of
 * whatever comes back in a `tool_use` block.
 *
 * ## Why the model's tool input is validated at all
 *
 * A `tool_use` input is model-generated text. It is not attacker-controlled in
 * the usual sense, but it is not trustworthy either — it can be malformed, it
 * can carry values the model inferred rather than read, and on a storefront
 * widget the model is reacting to whatever a shopper typed. Every executor
 * therefore parses its input through the schema here before touching the
 * database, exactly like an HTTP controller does with a request body. Nothing
 * downstream gets to assume a field is present or in range.
 *
 * ## Naming
 *
 * Tool names and field names are snake_case because that is what reads
 * naturally to the model and what SPEC.md §7 specifies. The TypeScript types
 * inferred from these schemas therefore carry snake_case fields, which is
 * deliberately inconsistent with the rest of this codebase's camelCase — the
 * boundary is the model, and matching the spec matters more here than matching
 * local style. Executors convert at the edge.
 */

/** Shared bound. Every list-returning tool is capped low: the model gets a
 * short, high-signal result set rather than a page it has to summarize, and a
 * shopper on WhatsApp cannot be sent twenty products. */
const LIMIT = z.number().int().min(1).max(10).default(5);

export const searchProductsInput = z.object({
  query: z.string().min(1).max(200),
  category: z.string().min(1).max(120).optional(),
  price_max_cents: z.number().int().positive().max(1_000_000_000).optional(),
  limit: LIMIT,
});
export type SearchProductsInput = z.infer<typeof searchProductsInput>;

export const getProductInput = z.object({
  product_id: z.string().uuid(),
});
export type GetProductInput = z.infer<typeof getProductInput>;

export const recommendProductsInput = z.object({
  need_description: z.string().min(1).max(500),
  budget_cents: z.number().int().positive().max(1_000_000_000).optional(),
});
export type RecommendProductsInput = z.infer<typeof recommendProductsInput>;

export const createCartLinkInput = z.object({
  items: z
    .array(
      z.object({
        variant_id: z.string().uuid(),
        qty: z.number().int().min(1).max(50),
      }),
    )
    .min(1)
    .max(20),
});
export type CreateCartLinkInput = z.infer<typeof createCartLinkInput>;

/**
 * Order lookup requires BOTH the order number and a contact that matches the
 * order — SPEC.md §7's "double factor". An order number alone is guessable
 * (they are sequential per tenant), and this tool returns a shopper's order
 * state, so one factor would make every order in a store enumerable through
 * the chat widget.
 */
export const getOrderStatusInput = z.object({
  order_number: z.string().min(1).max(20),
  email_or_phone: z.string().min(3).max(200),
});
export type GetOrderStatusInput = z.infer<typeof getOrderStatusInput>;

export const getStoreInfoInput = z.object({
  topic: z.enum(['shipping', 'returns', 'payments', 'contact', 'about']),
});
export type GetStoreInfoInput = z.infer<typeof getStoreInfoInput>;

/** Every tool the agent may be offered. The executor map is keyed by this, so
 * adding a name here without an executor fails at compile time rather than at
 * the moment a shopper triggers it. */
export const AGENT_TOOL_NAMES = [
  'search_products',
  'get_product',
  'recommend_products',
  'create_cart_link',
  'get_order_status',
  'get_store_info',
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/**
 * The JSON Schemas handed to Claude in the `tools` array.
 *
 * ## Why these are written out rather than generated from the Zod schemas above
 *
 * Deriving them was the first attempt, and it is the obvious instinct — one
 * definition, no drift. It does not survive this repo's dependency graph:
 * `@ventia/core` pins Zod 3 while the generator resolves Zod 4, and two Zod
 * copies produce structurally incompatible types. Rather than pin transitive
 * versions across the workspace to keep a convenience, the two artifacts are
 * written side by side and `agent-tool-schemas.test.ts` asserts they agree on
 * every property name and on which are required. A test that fails loudly is a
 * better guarantee than a derivation that fights the toolchain.
 *
 * It also turns out to be the better shape. These two schemas answer different
 * questions: the Zod one decides whether input is SAFE to execute, and this one
 * teaches the model what the field MEANS. Per-field descriptions belong in the
 * second and would be noise in the first — and they are what make the
 * difference between an agent that passes `price_max_cents: 50` and one that
 * passes `5000000`.
 */
export interface AgentToolJsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export const AGENT_TOOL_JSON_SCHEMAS: Record<AgentToolName, AgentToolJsonSchema> = {
  search_products: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Texto de búsqueda, en las palabras del cliente.' },
      category: { type: 'string', description: 'Slug de categoría, opcional.' },
      price_max_cents: {
        type: 'integer',
        // Spelled out because it is the field a model most often gets wrong:
        // Colombian prices are large numbers, and "under 100 mil" is
        // 10_000_000 cents, not 100.
        description: 'Precio máximo EN CENTAVOS de peso colombiano. $100.000 COP son 10000000.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Cuántos productos traer (por defecto 5).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  get_product: {
    type: 'object',
    properties: {
      product_id: { type: 'string', description: 'El product_id devuelto por search_products o recommend_products.' },
    },
    required: ['product_id'],
    additionalProperties: false,
  },
  recommend_products: {
    type: 'object',
    properties: {
      need_description: {
        type: 'string',
        description: 'Qué necesita el cliente, en una frase. Ej: "camisa formal para una boda en clima cálido".',
      },
      budget_cents: { type: 'integer', description: 'Presupuesto máximo EN CENTAVOS, opcional.' },
    },
    required: ['need_description'],
    additionalProperties: false,
  },
  create_cart_link: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Las variantes que el cliente quiere comprar.',
        items: {
          type: 'object',
          properties: {
            variant_id: { type: 'string', description: 'El variant_id devuelto por get_product.' },
            qty: { type: 'integer', minimum: 1, maximum: 50 },
          },
          required: ['variant_id', 'qty'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
  get_order_status: {
    type: 'object',
    properties: {
      order_number: { type: 'string', description: 'Solo los dígitos, sin el prefijo VNT-.' },
      email_or_phone: {
        type: 'string',
        // The double factor is stated to the model as well as enforced in
        // code, so it asks for the second factor instead of calling the tool
        // and relaying a failure.
        description: 'El correo o celular con que se hizo el pedido. Es obligatorio: pídeselo al cliente si no lo dio.',
      },
    },
    required: ['order_number', 'email_or_phone'],
    additionalProperties: false,
  },
  get_store_info: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        enum: ['shipping', 'returns', 'payments', 'contact', 'about'],
        description: 'Qué tema consultar de la información publicada por la tienda.',
      },
    },
    required: ['topic'],
    additionalProperties: false,
  },
};

/**
 * The body of a shopper's message to the agent — the HTTP request schema, not
 * a tool schema.
 *
 * Here rather than in the API package for the same reason as everything above:
 * `services/api` deliberately carries no direct `zod` dependency (see
 * `services/api/src/catalog/parse.ts` for the pnpm peer-resolution hazard that
 * caused), so every schema its controllers parse against is owned by this
 * package.
 *
 * Note what is NOT in it: the tenant. That comes from the request's resolved
 * domain via `PublicTenantGuard`, never from the body — a caller who could
 * name a tenant could address another merchant's agent and spend their AI
 * budget.
 */
export const agentMessageInput = z.object({
  // Bounded because every character is billed as input tokens on every
  // subsequent turn of the conversation, not just this one. Two thousand is
  // far more than a chat window produces and far less than a paste-bomb.
  message: z.string().trim().min(1).max(2000),
  /** Absent starts a new conversation. Always re-checked against the resolved
   * tenant server-side, so an id belonging to another store yields a new
   * conversation rather than someone else's transcript. */
  conversationId: z.string().uuid().optional(),
});

export type AgentMessageInput = z.infer<typeof agentMessageInput>;
