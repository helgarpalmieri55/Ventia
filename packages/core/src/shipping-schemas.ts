import { z } from 'zod';

/** The 4 shipping method shapes a tenant can configure: a flat rate, a
 * per-departamento rate table (with an optional fallback for departments not
 * listed), a free-shipping-over-a-threshold rate (with a fallback price
 * below the threshold), or in-store pickup (no shipping charge). */
export const SHIPPING_METHOD_TYPES = ['flat', 'zone', 'free_over', 'pickup'] as const;
export type ShippingMethodType = (typeof SHIPPING_METHOD_TYPES)[number];

const money = z.number().int().min(0);

/**
 * Cuántos días HÁBILES tarda una entrega por este método. Opcional, y las dos
 * mitades van juntas o no van: un rango con solo un extremo no se puede
 * redactar ("Recíbelo entre … y 5 días") y es peor que no decir nada.
 *
 * Días hábiles y no calendario porque es como lo cuentan las transportadoras
 * colombianas y como lo va a leer el comprador. Se muestra en la ficha de
 * producto, en el checkout y en los términos — hoy los términos generados
 * dejan ahí un `[COMPLETAR: …]` justamente porque este dato no existía.
 *
 * Es una ESTIMACIÓN del comerciante, no una promesa de la plataforma. El
 * plazo que obliga es el del artículo 50 de la Ley 1480: treinta días
 * calendario, y eso lo dicen los términos aparte.
 */
const etaFields = {
  etaMinDays: z.number().int().min(0).max(90).optional(),
  etaMaxDays: z.number().int().min(0).max(90).optional(),
};

/**
 * El rango tiene que ser coherente si viene: ambos extremos, y el mínimo no
 * mayor que el máximo.
 *
 * Va SOBRE la unión, no dentro de cada variante: `discriminatedUnion` solo
 * acepta miembros que sean objetos planos, y un `superRefine` envuelve al
 * miembro en `ZodEffects`, que rompe la discriminación. Encima de la unión
 * corre igual de bien, porque Zod ya eligió la variante por su `type` antes de
 * llegar aquí.
 */
function refineEta<T extends { etaMinDays?: number; etaMaxDays?: number }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  const { etaMinDays: min, etaMaxDays: max } = value;
  if ((min === undefined) !== (max === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [min === undefined ? 'etaMinDays' : 'etaMaxDays'],
      message: 'Indica el mínimo y el máximo de días, o ninguno de los dos',
    });
    return;
  }
  if (min !== undefined && max !== undefined && min > max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['etaMaxDays'],
      message: 'El máximo de días no puede ser menor que el mínimo',
    });
  }
}

export const shippingMethodSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('flat'),
    label: z.string().min(1).max(60),
    priceCents: money,
    enabled: z.boolean(),
    ...etaFields,
  }),
  z.object({
    id: z.string(),
    type: z.literal('zone'),
    label: z.string().min(1).max(60),
    ratesByDepartamento: z.record(z.string(), money),
    defaultPriceCents: money.optional(),
    enabled: z.boolean(),
    ...etaFields,
  }),
  z.object({
    id: z.string(),
    type: z.literal('free_over'),
    label: z.string().min(1).max(60),
    thresholdCents: money,
    fallbackPriceCents: money,
    enabled: z.boolean(),
    ...etaFields,
  }),
  z.object({
    id: z.string(),
    type: z.literal('pickup'),
    label: z.string().min(1).max(60),
    instructions: z.string().max(500).optional(),
    enabled: z.boolean(),
    ...etaFields,
  }),
]).superRefine(refineEta);

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
