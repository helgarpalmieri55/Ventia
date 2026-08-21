/**
 * The pieces both generated legal documents share — the política de
 * tratamiento de datos personales (privacy-policy.template.ts) and the
 * términos y condiciones (terms.template.ts).
 *
 * These are extracted rather than copied because what they encode is a
 * CONTRACT WITH THE MERCHANT, not a formatting convenience:
 *
 *  - `[COMPLETAR: ...]` is a literal string the merchant is told to search
 *    for. `apps/admin/components/contenido-tab.tsx` renders the returned
 *    `placeholders` list under the heading "búscalos como [COMPLETAR: …] en
 *    el texto", and `services/api/test/*.test.ts` asserts a generated body
 *    never contains `undefined` where a marker should be. Two generators
 *    spelling that marker two ways is two chances for the checklist to point
 *    at text that is not there.
 *  - The Spanish date is the *fecha de entrada en vigencia* of both
 *    documents, and both must read it in Colombian civil time.
 *  - `joinEs` renders the same lists (payment gateways, departamentos) in
 *    both.
 *
 * Everything here is pure — no clock, no database, no environment — so both
 * templates stay pure too, and both can be tested by calling them.
 */

const MONTHS_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/**
 * "19 de agosto de 2026", in Colombian civil time.
 *
 * Hand-rolled rather than `Intl.DateTimeFormat('es-CO')` for two reasons: the
 * output must not depend on the Node build's ICU data (a `small-icu` runtime
 * would silently produce English), and the date must be Colombia's, not the
 * server's. Colombia is UTC-5 year-round with no DST, so a fixed offset is
 * exact here rather than an approximation.
 */
export function formatSpanishDate(date: Date): string {
  const bogota = new Date(date.getTime() - 5 * 60 * 60 * 1000);
  return `${bogota.getUTCDate()} de ${MONTHS_ES[bogota.getUTCMonth()]} de ${bogota.getUTCFullYear()}`;
}

/** Joins a list the way Spanish does: "a, b y c". */
export function joinEs(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/**
 * Integer cents as an es-CO peso amount: `formatCop(4590000) -> "$ 45.900"`.
 *
 * Same convention as `apps/admin/lib/format.ts`'s `formatCOP` — 100 cents = 1
 * peso, no decimals, a plain space after the `$` — so a shipping price quoted
 * inside a generated document reads exactly like the same price rendered in
 * the storefront's cart.
 *
 * Hand-rolled for the same reason {@link formatSpanishDate} is: `Intl` would
 * make the output depend on the runtime's ICU data, and this string ends up
 * inside a document a merchant publishes. Grouping is by thousands with `.`,
 * which is the Colombian separator.
 */
export function formatCop(cents: number): string {
  const pesos = Math.round(cents / 100);
  const digits = String(Math.abs(pesos));
  let grouped = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += '.';
    grouped += digits[i];
  }
  return `${pesos < 0 ? '-' : ''}$ ${grouped}`;
}

/** Collects `[COMPLETAR: ...]` markers as a document is built. */
export class PlaceholderTracker {
  readonly hints: string[] = [];

  /**
   * The value, or a loud, self-explanatory marker in its place.
   *
   * The whole point is that a missing field NEVER produces `undefined`, an
   * empty gap, or — worst of all — a sentence that silently reads as a
   * complete legal statement while missing the fact that made it one. A
   * merchant scanning the generated text has to be able to see what is still
   * theirs to write.
   */
  fill(value: string | null | undefined, hint: string): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length > 0) return trimmed;
    if (!this.hints.includes(hint)) this.hints.push(hint);
    return `[COMPLETAR: ${hint}]`;
  }
}

/**
 * Hints reused by BOTH generators, so a merchant who fills in their identidad
 * legal for one document sees the markers disappear from the other. The
 * strings are shown to the merchant verbatim, as a checklist.
 */
export const HINT = {
  legalName: 'razón social o nombre completo del titular de la tienda',
  taxId: 'NIT o número de cédula',
  contactEmail: 'correo electrónico de contacto de la tienda',
  contactPhone: 'teléfono o WhatsApp de contacto',
  address: 'dirección del domicilio del negocio',
  municipio: 'municipio del domicilio',
  departamento: 'departamento del domicilio',
  site: 'dirección web de la tienda',
} as const;

/** Shape both generators return. */
export interface GeneratedDocument {
  /** Suggested `TenantContent.title`. */
  title: string;
  /** Suggested `TenantContent.bodyMd`. */
  bodyMd: string;
  /**
   * Human-readable list of the `[COMPLETAR: ...]` markers the merchant still
   * has to fill in, so the admin UI can show a checklist instead of making
   * them hunt through the text. Empty only when the generator could answer
   * every question from the store's own configuration.
   */
  placeholders: string[];
}
