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
  /**
   * The privacy fallback is deliberately NOT a policy.
   *
   * A store that has published nothing must not have a política de tratamiento
   * fabricated on its behalf: that would be a legal statement made in the
   * merchant's name, by us, about data handling nobody at that store has
   * agreed to — precisely the thing Ley 1581 makes the *Responsable del
   * Tratamiento* answerable for. The generator (`POST
   * /v1/admin/content/policy_privacy/generate`) exists so the merchant can
   * produce, read and publish that text themselves; until they do, this page
   * must not pretend it exists.
   *
   * What the old copy got wrong was the other half. "Esta tienda aún no ha
   * configurado su política de privacidad." is addressed to nobody: it reads
   * like a missing-config warning, tells the shopper nothing about the rights
   * they already have, and offers them no way to act. Those rights do not
   * depend on the merchant having written a page — the shopper can demand to
   * know, update, rectify or delete their data whether or not this store ever
   * published anything. So the fallback now says exactly that, and points at
   * the contact page (`/contacto`, this app's `about` content type), which is
   * the channel the merchant actually answers on.
   */
  policy_privacy: {
    title: 'Privacidad',
    bodyMd: [
      'Esta tienda todavía no ha publicado su política de tratamiento de datos personales.',
      'Mientras tanto, sus derechos siguen vigentes. La Ley 1581 de 2012 le permite conocer qué datos ' +
        'suyos tiene esta tienda, actualizarlos, rectificarlos, pedir que los eliminen y revocar la ' +
        'autorización que dio para tratarlos.',
      'Para ejercerlos, escríbale a la tienda por los medios que aparecen en la página de contacto. Si no ' +
        'recibe respuesta, puede acudir a la Superintendencia de Industria y Comercio (SIC).',
    ].join('\n\n'),
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
