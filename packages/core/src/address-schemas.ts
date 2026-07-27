import { z } from 'zod';
import { municipiosFor } from './colombia-locations.js';

/** Checkout address for storefront orders. No postal code: Colombian postal
 * codes (introduced by 4-72 in 2013) are not part of everyday addressing
 * culture and are not required by domestic carriers, so this schema omits
 * one entirely rather than treat it as optional-but-expected. `municipioName`
 * is cross-validated against `departamentoCode` via `.refine()` below, since
 * a municipio name alone (e.g. "Armenia" exists in multiple departments in
 * general Latin American usage, though not in Colombia specifically) is only
 * meaningful paired with its departamento. */
export const checkoutAddressSchema = z
  .object({
    nombreCompleto: z.string().min(2).max(120),
    telefono: z.string().min(7).max(20),
    departamentoCode: z.string(),
    municipioName: z.string(),
    direccion: z.string().min(3).max(200),
    complemento: z.string().max(100).optional(),
    barrio: z.string().max(100).optional(),
    notas: z.string().max(500).optional(),
  })
  .refine((v) => municipiosFor(v.departamentoCode).some((m) => m.name === v.municipioName), {
    message: 'El municipio no pertenece al departamento seleccionado',
    path: ['municipioName'],
  });

export type CheckoutAddressInput = z.infer<typeof checkoutAddressSchema>;
