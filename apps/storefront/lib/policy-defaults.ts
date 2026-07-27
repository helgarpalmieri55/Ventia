/** es-CO fallback copy for the four policy content types, used when
 * `GET /v1/storefront/content/:type` 404s (the merchant hasn't written that
 * page yet) so a storefront visitor never sees a raw 404 for these. */
export const POLICY_DEFAULTS: Record<
  'policy_shipping' | 'policy_returns' | 'policy_privacy' | 'about',
  { title: string; bodyMd: string }
> = {
  policy_shipping: {
    title: 'Envíos',
    bodyMd: 'Esta tienda aún no ha configurado su política de envíos.',
  },
  policy_returns: {
    title: 'Cambios y devoluciones',
    bodyMd: 'Esta tienda aún no ha configurado su política de cambios y devoluciones.',
  },
  policy_privacy: {
    title: 'Privacidad',
    bodyMd: 'Esta tienda aún no ha configurado su política de privacidad.',
  },
  about: {
    title: 'Contacto',
    bodyMd: 'Esta tienda aún no ha configurado su información de contacto.',
  },
};

export type PolicyType = keyof typeof POLICY_DEFAULTS;

/** Looks up the fallback copy for a policy `type`, matching the shape
 * `GET /v1/storefront/content/:type` returns on 200 (`{ title, bodyMd }`) so
 * a page can render one or the other without branching on shape. */
export function policyDefault(type: PolicyType): { title: string; bodyMd: string } {
  return POLICY_DEFAULTS[type];
}
