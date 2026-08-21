import { apiFetch } from './api';

/**
 * Client for `/v1/admin/domains` (owner-only — `@Roles('owner')` on
 * `services/api/src/tenants/custom-domains.controller.ts`), plus the pure
 * logic the Dominios page needs.
 *
 * Types are hand-written mirrors of the server's responses, for the same
 * reason `whatsapp-api.ts` and `payment-alerts-api.ts` hand-write theirs:
 * this app cannot import from `services/api/src`. Every shape here was read
 * off the controller/service, not assumed:
 *
 *   GET    /v1/admin/domains          -> { items, customDomainEnabled, verificationHost,
 *                                          platformRootDomain, pointsTo, apexIp }
 *   POST   /v1/admin/domains          -> 201 { id, domain, token }
 *   POST   /v1/admin/domains/:id/verify -> 200 { verified, reason? }  (200 even when false)
 *   DELETE /v1/admin/domains/:id      -> { ok: true }
 */

/** The page's route. Single source of truth shared by `nav.ts` and the page. */
export const DOMAINS_PATH = '/dominios';

/** One row of `GET /v1/admin/domains`'s `items` — see
 * `CustomDomainsService#listForTenant`. `token` is the TXT value derived from
 * the tenant + domain, so it is the SAME value on every fetch: a merchant who
 * reloads mid-setup is never handed a different one than the one they already
 * pasted into their DNS panel. */
export interface TenantDomain {
  id: string;
  domain: string;
  /**
   * The store's PUBLIC address — exactly one row per tenant carries it
   * (`setPrimary` demotes and promotes in one transaction).
   *
   * Not a label: `whatsapp-inbound.service.ts#storefrontBaseUrl` orders by it
   * to build the links the AI agent sends real shoppers, and
   * `privacy-policy.service.ts` quotes it as the store's web address in the
   * published política de tratamiento. Changing it changes both.
   *
   * It starts out on the `${slug}.${root}` row minted at onboarding, but since
   * `POST /:id/primary` exists it may sit on a merchant's own domain — so it
   * must NOT be used to decide whether a domain is inside the platform's zone.
   * See {@link isPlatformDomain}.
   */
  isPrimary: boolean;
  verified: boolean;
  token: string;
}

export interface DomainsResponse {
  items: TenantDomain[];
  /** `TenantLimits.customDomain`. False means `POST /v1/admin/domains` can
   * only ever answer 402, AND that the TLS gate refuses a certificate for any
   * domain outside the platform's own zone — see `isDomainAllowed`. */
  customDomainEnabled: boolean;
  /** `_ventia-verify` — the TXT record's host prefix, returned by the API so
   * this UI shows the exact record instead of describing it in prose. Never
   * hardcoded here: a mistyped host is the most common reason verification
   * never completes, and two copies of the string are two chances to drift. */
  verificationHost: string;
  /** The platform's own zone (`ventia.co`), straight from the server's
   * `PLATFORM_ROOT_DOMAIN`. This used to be guessed from the admin panel's own
   * hostname, which was exact only when the panel was reached at
   * `admin.${root}` and simply wrong on `localhost:3001`. */
  platformRootDomain: string;
  /** Where the merchant CNAMEs their own domain: this tenant's free
   * `${slug}.${root}` address.
   *
   * NOT whichever domain is currently primary. A custom domain can be promoted
   * to primary, and telling a merchant to point `mitienda.com` at
   * `mitienda.com` is instructing them to build a loop. */
  pointsTo: string;
  /** The A record for a bare apex (`mitienda.com`), where most DNS providers
   * refuse a CNAME. `null` when the operator has not set `PLATFORM_APEX_IP`,
   * in which case the panel asks the merchant to contact support rather than
   * showing an address that would black-hole their store. */
  apexIp: string | null;
}

/** `POST /v1/admin/domains`'s 201 body. Note there is no `verified` field —
 * a freshly added domain is unverified by definition. */
export interface DomainAdded {
  id: string;
  domain: string;
  token: string;
}

/** Why a verification attempt failed — mirrors `DomainVerifyFailure` in
 * `services/api/src/tenants/custom-domains.service.ts`. */
export type DomainVerifyFailure = 'not_found' | 'dns_unreachable' | 'record_missing' | 'record_mismatch';

/** `POST /v1/admin/domains/:id/verify`. Answers 200 with `verified: false`
 * for "not yet", deliberately — see the controller: minutes of DNS
 * propagation is the expected state, not an error.
 *
 * `reason` is present exactly when `verified` is false. Optional on the type
 * anyway, so a panel deployed against an API that predates the field degrades
 * to the generic message instead of rendering `undefined`. */
export interface DomainVerifyResult {
  verified: boolean;
  reason?: DomainVerifyFailure;
}

export function listDomains(): Promise<DomainsResponse> {
  return apiFetch<DomainsResponse>('/v1/admin/domains');
}

export function addDomain(domain: string): Promise<DomainAdded> {
  return apiFetch<DomainAdded>('/v1/admin/domains', {
    method: 'POST',
    body: JSON.stringify({ domain }),
  });
}

export function verifyDomain(id: string): Promise<DomainVerifyResult> {
  return apiFetch<DomainVerifyResult>(`/v1/admin/domains/${id}/verify`, { method: 'POST' });
}

/** Makes a VERIFIED domain the store's public address. 409
 * `DOMAIN_NOT_VERIFIED` covers both "not verified yet" and "not this
 * tenant's", by design — see the controller. */
export function setPrimaryDomain(id: string): Promise<{ ok: boolean; domain: string }> {
  return apiFetch<{ ok: boolean; domain: string }>(`/v1/admin/domains/${id}/primary`, { method: 'POST' });
}

export function removeDomain(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/v1/admin/domains/${id}`, { method: 'DELETE' });
}

/* -------------------------------------------------------------------------- */
/* Normalizing what the merchant types                                        */
/* -------------------------------------------------------------------------- */

/**
 * A client-side mirror of `normalizeDomain` in
 * `services/api/src/tenants/custom-domains.service.ts`, used ONLY to preview
 * what will be registered and to catch a hopeless value before a round trip.
 *
 * The server stays authoritative — it re-normalizes the string this sends and
 * 400s `VALIDATION_FAILED` on anything it rejects, which the page surfaces.
 * If the two ever drift, the cost is one wasted request and a server-worded
 * error, never a domain registered in a shape the server did not choose.
 *
 * The regex is copied verbatim from the server's, including the deliberate
 * strictness: no wildcard, no underscore, at least two labels, no
 * leading/trailing hyphen.
 */
export function normalizeDomainInput(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z]+:\/\//, '');
  value = value.split('/')[0]!;
  value = value.split(':')[0]!;
  value = value.replace(/\.$/, '');
  if (!value || value.length > 253) return null;
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value)) return null;
  return value;
}

/**
 * The message for the domain field when `POST /v1/admin/domains` answers 400.
 *
 * `VALIDATION_FAILED` from that endpoint carries `details: { domain: 'dominio
 * inválido' }` — a plain object, NOT zod's `{ fieldErrors }` flatten shape, so
 * `fieldErrors()` from `lib/errors.ts` returns `{}` for it and the merchant
 * would get "Revisa los campos marcados" with no field marked. Matched on the
 * real shape, and answered with copy that says what a valid value looks like
 * instead of repeating the server's two terse words.
 */
export function addDomainFieldError(e: { code: string; details: unknown }): string | null {
  if (e.code !== 'VALIDATION_FAILED') return null;
  const details = e.details;
  if (typeof details !== 'object' || details === null || !('domain' in details)) return null;
  return INVALID_DOMAIN_MESSAGE;
}

/** Also used for the client-side check, so a merchant sees the same sentence
 * whether the value was rejected here or by the server. */
export const INVALID_DOMAIN_MESSAGE =
  'Escribe el dominio como mitienda.com o tienda.mitienda.com, sin espacios, sin asteriscos y sin acentos.';

/* -------------------------------------------------------------------------- */
/* Which domains are ours and which are the merchant's                        */
/* -------------------------------------------------------------------------- */

/**
 * The platform's own zone used to be DERIVED here, from the admin panel's own
 * hostname with the primary row as a fallback, because `GET /v1/admin/domains`
 * did not send it. That guess was exact only when the panel was reached at
 * `admin.${root}`: on `localhost:3001` it produced nothing, and on the
 * fallback path a promoted three-label custom domain (`tienda.mitienda.com`)
 * produced the root `mitienda.com`, which would then read `www.mitienda.com`
 * as ours and tell a merchant their unconfigured domain already worked.
 *
 * The response now carries `platformRootDomain` straight from the server's
 * `PLATFORM_ROOT_DOMAIN` — the only place that actually knows it — so the
 * derivation is gone rather than kept as a fallback. A fallback would just be
 * the same wrong answer, arriving only in the cases nobody tests.
 */

export function isPlatformDomain(domain: string, root: string | null): boolean {
  if (!root) return false;
  return domain === root || domain.endsWith(`.${root}`);
}

/* -------------------------------------------------------------------------- */
/* What state a domain is actually in                                         */
/* -------------------------------------------------------------------------- */

/**
 * The four situations a merchant can be in, named after what is TRUE of the
 * storefront rather than after a database column:
 *
 * - `platform`        — the address we gave them. Always served; the plan gate
 *                       explicitly does not apply inside our own zone
 *                       (`isDomainAllowed` condition 4), which is why a
 *                       `basico` store still has HTTPS on its own subdomain.
 * - `blocked_by_plan` — a domain of theirs, on a plan without `customDomain`.
 *                       The TLS gate refuses the certificate, so the store
 *                       does NOT answer there no matter how the DNS looks.
 * - `pending`         — entitled, but the TXT record has not been seen yet.
 * - `active`          — verified and entitled: served.
 */
export type DomainState = 'platform' | 'blocked_by_plan' | 'pending' | 'active';

export interface DomainStateInput {
  customDomainEnabled: boolean;
  platformRoot: string | null;
}

/**
 * The plan check runs BEFORE the verification check, and that order is the
 * whole point of requirement 3: a `basico` merchant who is told "pending —
 * publish this TXT record" spends an afternoon in their registrar's control
 * panel to arrive at a certificate we were never going to issue. They need to
 * know the plan is the blocker first, while the DNS work is still ahead of
 * them rather than behind.
 */
export function domainState(domain: TenantDomain, input: DomainStateInput): DomainState {
  // `verified &&`, not just the suffix test: every platform subdomain is
  // created already verified (`onboarding.service.ts` writes `verifiedAt` at
  // the same moment it writes the row), so an UNVERIFIED domain is never one
  // of ours no matter how its name reads. That is what stops a misderived
  // root (see `platformRootDomain`) from ever telling a merchant that a domain
  // they are still setting up already works.
  //
  // `isPrimary` is deliberately absent: since `POST /:id/primary`, primary
  // means "the address customers see", which a merchant's own domain can be.
  if (domain.verified && isPlatformDomain(domain.domain, input.platformRoot)) return 'platform';
  if (!input.customDomainEnabled) return 'blocked_by_plan';
  if (!domain.verified) return 'pending';
  return 'active';
}

/** Badge copy per state. `Badge`'s own variants, structurally typed so `lib/`
 * stays free of a UI import. */
export const DOMAIN_STATE_LABEL: Record<DomainState, string> = {
  platform: 'Funcionando',
  blocked_by_plan: 'Requiere otro plan',
  pending: 'Falta verificar',
  active: 'Funcionando',
};

export const DOMAIN_STATE_BADGE: Record<DomainState, 'default' | 'secondary' | 'destructive'> = {
  platform: 'default',
  blocked_by_plan: 'destructive',
  pending: 'secondary',
  active: 'default',
};

/** One sentence, in the merchant's terms, about whether their store answers
 * at this address right now. */
export function domainStateExplanation(state: DomainState): string {
  switch (state) {
    case 'platform':
      return 'Esta es la dirección que te dimos al crear la tienda. Ya funciona y no tienes que configurar nada.';
    case 'blocked_by_plan':
      return 'Tu plan actual no incluye dominio propio, así que tu tienda todavía no responde en esta dirección. Mejora tu plan para activarla.';
    case 'pending':
      return 'Tu tienda todavía no responde en esta dirección: falta que publiques el registro TXT y que lo verifiquemos.';
    case 'active':
      return 'Tu tienda responde en esta dirección con candado de seguridad (HTTPS).';
  }
}

/* -------------------------------------------------------------------------- */
/* The primary domain: the address customers actually see                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether the page may offer "usar como dirección principal".
 *
 * Verified is the API's own rule (`setPrimary` returns null otherwise, and the
 * controller turns that into 409 `DOMAIN_NOT_VERIFIED`). The extra rule here
 * is `blocked_by_plan`: the API would happily promote a verified domain whose
 * plan does not include custom domains, but the TLS gate refuses that domain a
 * certificate — so every WhatsApp link the agent then sent a shopper would
 * land on a certificate error, and the store's published privacy policy would
 * name an address that does not answer. Offering that action would be offering
 * to break the store's own outbound links.
 */
export function canBecomePrimary(domain: TenantDomain, state: DomainState): boolean {
  if (domain.isPrimary) return false;
  return state === 'active' || state === 'platform';
}

/**
 * What actually changes for the merchant's CUSTOMERS when the primary domain
 * moves — the two real consumers of `isPrimary`, named in the merchant's terms
 * rather than as "isPrimary".
 *
 * Also says what does NOT change, because the scary reading of this dialog is
 * "my old links die": the demoted row keeps its `verifiedAt` and the TLS gate
 * never consults `isPrimary`, so the previous address keeps serving.
 */
export function primaryChangeConsequences(nextDomain: string, currentDomain: string | null): string[] {
  const consequences = [
    `Los enlaces que el asistente le envíe a tus clientes por WhatsApp van a usar ${nextDomain}.`,
    // Both documents name the primary domain, and both are GENERATED, not
    // live: `privacy-policy.service.ts` and `terms.service.ts` each read the
    // primary row at generation time and the result is then published as
    // stored text. So promoting a domain does not rewrite what a shopper is
    // reading right now — it changes what the next regeneration says. Telling
    // the merchant otherwise would leave them believing a published legal
    // document updated itself.
    `Tu política de tratamiento de datos y tus términos y condiciones nombran la dirección de tu tienda. Los textos ya publicados no cambian solos: la próxima vez que los vuelvas a generar van a decir ${nextDomain}.`,
  ];
  if (currentDomain) {
    consequences.push(
      `${currentDomain} sigue funcionando: los enlaces que ya enviaste y los que tus clientes tengan guardados siguen abriendo tu tienda.`,
    );
  }
  return consequences;
}

/* -------------------------------------------------------------------------- */
/* The record the merchant has to publish                                     */
/* -------------------------------------------------------------------------- */

export interface DnsRecord {
  type: 'TXT';
  /** The full name, e.g. `_ventia-verify.tienda.com`. */
  name: string;
  /** Just the host part, e.g. `_ventia-verify`. Shown alongside the full name
   * because most Colombian registrars' panels append the zone themselves, and
   * pasting the full name there produces
   * `_ventia-verify.tienda.com.tienda.com` — the single most common reason a
   * verification never completes. */
  host: string;
  /** The domain being verified, e.g. `tienda.com` — kept alongside `name` so
   * the troubleshooting copy can show what the doubled-name mistake actually
   * produces without re-deriving it from `name`. */
  domain: string;
  value: string;
}

export function verificationRecord(domain: TenantDomain | DomainAdded, verificationHost: string): DnsRecord {
  return {
    type: 'TXT',
    name: `${verificationHost}.${domain.domain}`,
    host: verificationHost,
    domain: domain.domain,
    value: domain.token,
  };
}

/* -------------------------------------------------------------------------- */
/* Verification feedback                                                      */
/* -------------------------------------------------------------------------- */

export interface VerificationHelp {
  /** What we actually know, stated as such. */
  headline: string;
  /** Concrete things to check, in the order they are usually wrong. Empty on
   * the first failed attempt. */
  checks: string[];
  /** Whether the merchant can safely walk away and come back. */
  footnote: string;
}

/**
 * What to tell a merchant when `verify` answered `{ verified: false }`.
 *
 * The API now says WHICH failure it was, so this no longer has to hedge. It
 * used to receive a bare boolean that collapsed "the lookup threw" with
 * "records came back and none matched", and hedging was the only honest thing
 * to do: telling someone "el valor no coincide" when their record simply had
 * not propagated sent them to re-type a value that was already correct.
 *
 * The three DNS reasons want genuinely different advice:
 *
 * - `dns_unreachable` is almost always propagation on the first try, so the
 *   first attempt gets "wait" and nothing else. Repeat attempts are no longer
 *   plausibly propagation, so they get the full checklist.
 * - `record_missing` means the zone answered and there is nothing at that
 *   host. Waiting is not the fix; the name is. That checklist leads with the
 *   duplicated-zone mistake, which is what produces this exact result.
 * - `record_mismatch` means something IS published there and it is not ours.
 *   The merchant did the work — the value is what needs correcting, so that is
 *   the only thing this says. Repeating "espera un rato" here would be wrong.
 */
export function verificationHelp(
  reason: DomainVerifyFailure | undefined,
  attempts: number,
  record: DnsRecord,
): VerificationHelp {
  const nameCheck = `En el campo "nombre" o "host" escribe solo ${record.host}. Casi todos los proveedores le agregan tu dominio automáticamente, y si escribes el nombre completo queda ${record.name}.${record.domain}, que no sirve.`;
  const valueCheck = `El valor debe quedar idéntico a ${record.value}, sin comillas, sin espacios al inicio o al final y sin cortarlo.`;
  const typeCheck = 'El tipo del registro debe ser TXT. Un registro A o CNAME con ese nombre no nos sirve para verificar.';
  const savedCheck =
    'Si tu proveedor tiene un botón de "guardar" o "publicar cambios" aparte, revisa que hayas quedado con los cambios guardados.';

  if (reason === 'record_mismatch') {
    return {
      headline: `Encontramos un registro TXT en ${record.name}, pero con otro valor.`,
      checks: [valueCheck, 'Si dejaste un registro de un intento anterior, bórralo: nos quedamos con el que no coincide.'],
      footnote:
        'No hace falta esperar: el registro ya está publicado, solo hay que corregir el valor. Después de guardarlo puede tardar unos minutos en verse desde acá.',
    };
  }

  if (reason === 'record_missing') {
    return {
      headline: `Tu dominio responde, pero no hay ningún registro TXT en ${record.name}.`,
      checks: [nameCheck, typeCheck, savedCheck],
      footnote:
        'Si acabas de crearlo, dale unos minutos y vuelve a intentar. Si ya lleva un rato, casi siempre es que el nombre del registro quedó distinto.',
    };
  }

  // `dns_unreachable` and anything an older API sends: the lookup itself did
  // not get an answer.
  if (attempts <= 1) {
    return {
      headline: `Todavía no vemos el registro TXT en ${record.name}.`,
      checks: [],
      footnote:
        'Es lo normal si acabas de crearlo: los cambios de DNS tardan desde unos minutos hasta varias horas en verse desde acá. Puedes cerrar esta página y volver más tarde; el valor que te mostramos no cambia.',
    };
  }

  return {
    headline: `Seguimos sin encontrar el registro TXT en ${record.name}.`,
    checks: [nameCheck, valueCheck, typeCheck, savedCheck],
    footnote:
      'Si ya revisaste todo eso, espera un rato más y vuelve a intentar: algunos proveedores tardan varias horas en publicar un registro nuevo.',
  };
}

/* -------------------------------------------------------------------------- */
/* Links                                                                      */
/* -------------------------------------------------------------------------- */

/** Hostnames that cannot have a publicly-trusted certificate, and which this
 * repo's dev stack really uses (`*.ventia.localhost` served over plain HTTP by
 * docker/Caddyfile). Mirrors `LOCAL_HOST_SUFFIXES` /`LOCAL_HOST_EXACT` in
 * `services/api/src/tenants/tenant-public-url.ts`. */
const LOCAL_HOST_EXACT = new Set(['localhost', '127.0.0.1']);
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.test'];

/**
 * The browser-reachable URL of the storefront at this domain.
 *
 * Same rule as the API's `resolveStorefrontScheme`, and the default matters in
 * the same direction: a real registered domain gets `https`, so a merchant is
 * never handed a plaintext link to their own live store. Only reserved,
 * unregistrable names (`.localhost`, `.local`, `.test`, loopback) fall back to
 * `http`, which is what the dev stack serves.
 */
export function storefrontUrl(domain: string): string {
  const host = domain.trim().toLowerCase();
  const local = LOCAL_HOST_EXACT.has(host) || LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  return `${local ? 'http' : 'https'}://${host}`;
}
