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
 *   GET    /v1/admin/domains          -> { items, customDomainEnabled, verificationHost }
 *   POST   /v1/admin/domains          -> 201 { id, domain, token }
 *   POST   /v1/admin/domains/:id/verify -> 200 { verified }   (200 even when false)
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
}

/** `POST /v1/admin/domains`'s 201 body. Note there is no `verified` field —
 * a freshly added domain is unverified by definition. */
export interface DomainAdded {
  id: string;
  domain: string;
  token: string;
}

/** `POST /v1/admin/domains/:id/verify`. Answers 200 with `verified: false`
 * for "not yet", deliberately — see the controller: minutes of DNS
 * propagation is the expected state, not an error. */
export interface DomainVerifyResult {
  verified: boolean;
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
 * The platform's own zone (`ventia.co`, `ventia.localhost`, …).
 *
 * ## Why this is derived and not read
 *
 * The API does not send it. `GET /v1/admin/domains` returns rows plus the
 * plan flag plus the TXT host, and this app has no `PLATFORM_ROOT_DOMAIN` of
 * its own — the one place that guessed it (`app/_components/checklist-panel.tsx`'s
 * `ROOT_DOMAIN = 'ventia.localhost'`) is simply wrong in production. Adding
 * `platformRootDomain` to that response is one line on the server and would
 * retire this whole function; it is written up in the handoff notes.
 *
 * ## Why not from `isPrimary`
 *
 * It used to be: the only `isPrimary` row was the `${slug}.${root}` subdomain.
 * `POST /:id/primary` ended that — a merchant's own `mitienda.com` can now be
 * primary, and stripping its first label would yield `com`, which would then
 * match every other `.com` domain as "inside our zone" and tell a merchant
 * their unconfigured domain already works.
 *
 * ## What it uses instead
 *
 * 1. **The admin panel's own hostname.** The admin is served at
 *    `admin.${root}` — `admin.ventia.localhost` in the dev stack
 *    (docker/Caddyfile) and `admin.${PLATFORM_ROOT_DOMAIN}` in production
 *    (docs/deploying.md §6 lists `apex`, `api.`, `admin.`, `cdn.` as the
 *    known hostnames). Dropping its first label is exact whenever the panel is
 *    reached by its real address.
 * 2. **The primary row**, only as a fallback for when it is not — a developer
 *    on `http://localhost:3001`, where step 1 yields nothing.
 *
 * Both steps require the remainder to still contain a dot, which is what keeps
 * `mitienda.com` from producing the root `com`.
 *
 * Residual limitation, stated rather than hidden: on the fallback path a
 * promoted three-label custom domain (`tienda.mitienda.com`) yields the root
 * `mitienda.com`, so a sibling (`www.mitienda.com`) would read as ours. It
 * needs the panel to be reached off its canonical hostname AND a promoted
 * subdomain-shaped custom domain; {@link domainState} additionally refuses to
 * call anything unverified "ours", which keeps the misread off every domain a
 * merchant is still setting up.
 */
export function platformRootDomain(items: readonly TenantDomain[], adminHostname?: string | null): string | null {
  const fromAdmin = parentZone(adminHostname);
  if (fromAdmin) return fromAdmin;
  return parentZone(items.find((item) => item.isPrimary)?.domain);
}

/** `admin.ventia.co` -> `ventia.co`; `mitienda.com` -> null (`com` is not a
 * zone we could own); `localhost` -> null. */
function parentZone(host: string | null | undefined): string | null {
  if (typeof host !== 'string') return null;
  const value = host.trim().toLowerCase();
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const remainder = value.slice(dot + 1);
  return remainder.includes('.') ? remainder : null;
}

/**
 * Whether a domain lives inside the platform's own zone — the free
 * `${slug}.${root}` address — rather than being a domain the merchant owns.
 *
 * Mirrors `isPlatformSubdomain` on the server, INCLUDING the leading dot in
 * the suffix test. Without that dot `evilventia.co` matches root `ventia.co`,
 * and this UI would tell the owner of a lookalike domain that their store is
 * already being served there for free — the same class of mistake the server
 * comment calls out, in the half of the stack that sets expectations.
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
    `La dirección de tu tienda que aparece en tu política de tratamiento de datos pasa a ser ${nextDomain}.`,
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
 * **What the API can and cannot tell us.** `POST /:id/verify` returns a bare
 * boolean: `CustomDomainsService#verify` collapses "the lookup threw"
 * (NXDOMAIN, timeout) and "records came back but none matched" into the same
 * `false`. So this UI genuinely does not know whether the record is missing
 * or whether its value is wrong, and it must not pretend to — telling someone
 * "el valor no coincide" when the record simply has not propagated sends them
 * to re-type a value that was already correct. (The API change that would fix
 * this is one field; it is described in the handoff notes.)
 *
 * What we CAN do is stop repeating the same sentence. The first failure is
 * overwhelmingly propagation, and the honest answer is "not yet, this takes
 * time". From the second failure on, propagation is no longer the most likely
 * story, so we name every cause we know of — including both of the ones the
 * boolean conflates — with the exact values to compare against.
 */
export function verificationHelp(attempts: number, record: DnsRecord): VerificationHelp {
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
    checks: [
      `En el campo "nombre" o "host" escribe solo ${record.host}. Casi todos los proveedores le agregan tu dominio automáticamente, y si escribes el nombre completo queda ${record.name}.${record.domain}, que no sirve.`,
      `El valor debe quedar idéntico a ${record.value}, sin comillas, sin espacios al inicio o al final y sin cortarlo.`,
      'El tipo del registro debe ser TXT. Un registro A o CNAME con ese nombre no nos sirve para verificar.',
      'Si tu proveedor tiene un botón de "guardar" o "publicar cambios" aparte, revisa que hayas quedado con los cambios guardados.',
    ],
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
