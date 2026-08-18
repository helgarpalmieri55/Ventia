import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_TOOL_JSON_SCHEMAS,
  AGENT_TOOL_NAMES,
  createCartLinkInput,
  getOrderStatusInput,
  getProductInput,
  getStoreInfoInput,
  recommendProductsInput,
  searchProductsInput,
} from '../src/agent-tools';

/**
 * The agent's tools carry two schemas: a Zod one that decides whether the
 * model's output is SAFE to execute, and a JSON Schema that teaches the model
 * what each field means. They are written side by side rather than derived
 * from one another (see agent-tools.ts for why the derivation does not survive
 * this repo's Zod versions), so this file is what stops them drifting.
 *
 * Drift here is not cosmetic. A field required by Zod but optional in the JSON
 * Schema means the model is told it may omit something the executor will
 * reject — the tool fails at runtime, in front of a shopper, for a reason the
 * model cannot see. A field present in the JSON Schema but absent from Zod is
 * worse: the model is invited to send something the executor silently drops.
 */

const ZOD_SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  search_products: searchProductsInput,
  get_product: getProductInput,
  recommend_products: recommendProductsInput,
  create_cart_link: createCartLinkInput,
  get_order_status: getOrderStatusInput,
  get_store_info: getStoreInfoInput,
};

/** A Zod field is optional to the MODEL if it may be omitted from input —
 * which includes fields with defaults, since the executor supplies one. */
function zodOptionalFields(schema: z.ZodObject<z.ZodRawShape>): Set<string> {
  const optional = new Set<string>();
  for (const [key, field] of Object.entries(schema.shape)) {
    if (field.isOptional() || field instanceof z.ZodDefault) optional.add(key);
  }
  return optional;
}

describe('agent tool schemas — the two definitions agree', () => {
  it.each(AGENT_TOOL_NAMES)('%s exposes the same properties in both', (name) => {
    const json = AGENT_TOOL_JSON_SCHEMAS[name];
    const zod = ZOD_SCHEMAS[name];

    expect(Object.keys(json.properties).sort()).toEqual(Object.keys(zod.shape).sort());
  });

  it.each(AGENT_TOOL_NAMES)('%s marks the same fields required in both', (name) => {
    const json = AGENT_TOOL_JSON_SCHEMAS[name];
    const zod = ZOD_SCHEMAS[name];

    const jsonRequired = new Set(json.required ?? []);
    const zodRequired = new Set(
      Object.keys(zod.shape).filter((key) => !zodOptionalFields(zod).has(key)),
    );

    expect([...jsonRequired].sort()).toEqual([...zodRequired].sort());
  });

  it.each(AGENT_TOOL_NAMES)('%s refuses unknown properties, so a hallucinated field is not silently dropped', (name) => {
    expect(AGENT_TOOL_JSON_SCHEMAS[name].additionalProperties).toBe(false);
  });

  it('every tool name has both a Zod schema and a JSON schema', () => {
    // Guards the case where a seventh tool is added to AGENT_TOOL_NAMES and
    // only one of the two definitions follows it.
    for (const name of AGENT_TOOL_NAMES) {
      expect(ZOD_SCHEMAS[name], `missing Zod schema for ${name}`).toBeDefined();
      expect(AGENT_TOOL_JSON_SCHEMAS[name], `missing JSON schema for ${name}`).toBeDefined();
    }
  });
});

describe('agent tool schemas — the bounds that protect the executors', () => {
  it('caps how many products a single call can pull', () => {
    // A shopper on WhatsApp cannot be sent twenty products, and a large limit
    // is also the cheapest way for a confused model to burn a merchant's
    // budget on one question.
    expect(searchProductsInput.parse({ query: 'x', limit: 10 }).limit).toBe(10);
    expect(searchProductsInput.safeParse({ query: 'x', limit: 50 }).success).toBe(false);
  });

  it('defaults the limit rather than leaving it undefined', () => {
    expect(searchProductsInput.parse({ query: 'camisa' }).limit).toBe(5);
  });

  it('rejects a cart line with a non-positive quantity', () => {
    expect(
      createCartLinkInput.safeParse({ items: [{ variant_id: crypto.randomUUID(), qty: 0 }] }).success,
    ).toBe(false);
  });

  it('requires BOTH factors for an order lookup', () => {
    // The schema is the first place the double factor is enforced — before the
    // executor, before the database.
    expect(getOrderStatusInput.safeParse({ order_number: '1001' }).success).toBe(false);
    expect(
      getOrderStatusInput.safeParse({ order_number: '1001', email_or_phone: 'a@b.co' }).success,
    ).toBe(true);
  });

  it('constrains store-info topics to what the tenant can actually have published', () => {
    expect(getStoreInfoInput.safeParse({ topic: 'shipping' }).success).toBe(true);
    expect(getStoreInfoInput.safeParse({ topic: 'competitor_prices' }).success).toBe(false);
  });
});
