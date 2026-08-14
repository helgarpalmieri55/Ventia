/** Shared resolution of THIS codebase's own storefront base URL, for the two
 * adapters whose gateway flow sends the shopper's browser back to a
 * first-party storefront route: `epayco.ts` (its `/pago/epayco` bridge page,
 * shipped in P3b Task 6) and `wompi.ts` (its `/pago/wompi-retorno/{orderNumber}`
 * return-capture page, added in P3c Task 2).
 *
 * **Interim, explicitly-provisional mechanism for the storefront-redirect
 * architectural gap (see `epayco.ts`'s module doc comment's
 * `response`/`confirmation` section for the full reasoning on why no
 * per-tenant public base URL reaches these adapters today).** Each adapter's
 * returned/registered redirect URL must point at THIS codebase's own
 * storefront — a real, public, per-TENANT browser-reachable base URL, which
 * neither `OrderForPayment` nor `TenantProviderConfig` carries, and which
 * sourcing correctly requires widening `OrderForPayment` and touching
 * `checkout.controller.ts`/`checkout.service.ts`. Rather than silently
 * hardcode any single tenant's real domain (which would produce a WRONG,
 * broken redirect for every other tenant, in production, with no signal that
 * anything's wrong) or throw unconditionally (which would make these adapters
 * unusable end-to-end even for local, single-tenant-dev testing), this reads
 * ONE explicitly provisional env var, defaulting to `http://localhost:3000`
 * for a single-tenant dev loop (mirroring `revalidate.ts`'s identical
 * `STOREFRONT_INTERNAL_URL` dev default) — **this default, and indeed this
 * whole mechanism, is WRONG for any real multi-tenant deployment where more
 * than one tenant uses ePayco or Wompi**: every tenant's shopper would be
 * redirected to the SAME single storefront base regardless of which tenant
 * they actually checked out on. This is a real, load-bearing,
 * multi-tenant-wrong limitation, not a convenience shortcut — flagged loudly
 * here, in the commit body, and in this task's own report: **whoever wires
 * these adapters' redirect URLs up for production MUST replace this with the
 * real per-request tenant domain** (resolved the same way
 * `services/api/src/tenants/domain-resolver.ts`'s `DomainResolver` already
 * resolves an inbound request's host to a tenant, threaded down through
 * `OrderForPayment` or an equivalent widened input), NOT simply leave this
 * env var in place for production.
 *
 * ## Naming (P3c Task 2)
 *
 * This started life as `EPAYCO_STOREFRONT_BASE_URL`, private to `epayco.ts`.
 * P3c gave Wompi the identical need, and the gap above affects both adapters
 * IDENTICALLY — so it was renamed to the provider-neutral
 * `PAYMENTS_STOREFRONT_BASE_URL` and moved here, rather than duplicated as
 * two near-identical provider-specific vars that would then have to be kept
 * in sync (and that would imply, wrongly, that this is a per-provider
 * concern). The env var name is the ONLY thing that changed: the default and
 * the produced URLs are byte-identical to before the rename, which
 * `test/epayco.test.ts`'s dedicated regression block pins explicitly.
 */
export const STOREFRONT_BASE_ENV_VAR = 'PAYMENTS_STOREFRONT_BASE_URL';

export function resolveStorefrontBase(): string {
  return process.env[STOREFRONT_BASE_ENV_VAR] ?? 'http://localhost:3000';
}
