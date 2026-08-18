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
