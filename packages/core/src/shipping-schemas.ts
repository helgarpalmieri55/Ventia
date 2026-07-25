import { z } from 'zod';

/** The 4 shipping method shapes a tenant can configure: a flat rate, a
 * per-departamento rate table (with an optional fallback for departments not
 * listed), a free-shipping-over-a-threshold rate (with a fallback price
 * below the threshold), or in-store pickup (no shipping charge). */
export const SHIPPING_METHOD_TYPES = ['flat', 'zone', 'free_over', 'pickup'] as const;
export type ShippingMethodType = (typeof SHIPPING_METHOD_TYPES)[number];

const money = z.number().int().min(0);

export const shippingMethodSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('flat'),
    label: z.string().min(1).max(60),
    priceCents: money,
    enabled: z.boolean(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('zone'),
    label: z.string().min(1).max(60),
    ratesByDepartamento: z.record(z.string(), money),
    defaultPriceCents: money.optional(),
    enabled: z.boolean(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('free_over'),
    label: z.string().min(1).max(60),
    thresholdCents: money,
    fallbackPriceCents: money,
    enabled: z.boolean(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('pickup'),
    label: z.string().min(1).max(60),
    instructions: z.string().max(500).optional(),
    enabled: z.boolean(),
  }),
]);

export type ShippingMethodInput = z.infer<typeof shippingMethodSchema>;

/** `codRestrictedDepartamentos`: departamento codes where cash-on-delivery is
 * disallowed (e.g. remote departments many carriers don't offer COD to) —
 * enforcement happens at the order/payment layer, this only carries the
 * configured list. */
export const shippingSettingsSchema = z.object({
  methods: z.array(shippingMethodSchema).max(8),
  codRestrictedDepartamentos: z.array(z.string()).optional(),
});

export type ShippingSettingsInput = z.infer<typeof shippingSettingsSchema>;
