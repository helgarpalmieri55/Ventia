import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import { platformDb } from '@ventia/db';

/**
 * Custom domains and the on-demand TLS gate (docs/SPEC.md §11 P6: "custom
 * domains + on-demand TLS").
 *
 * ## The gate is the whole security story
 *
 * Caddy's on-demand TLS issues a certificate for whatever hostname shows up in
 * a TLS handshake, which is exactly what a multi-tenant platform needs and
 * exactly what an attacker would abuse. Caddy's `ask` directive is the
 * mitigation: before issuing, it calls an HTTP endpoint and issues only on a
 * 2xx.
 *
 * That endpoint is `isDomainAllowed` below, and it must fail CLOSED on every
 * uncertainty. If it ever returns 200 for a domain we do not serve, anyone who
 * points DNS at this platform can make Let's Encrypt issue certificates
 * through our account until the rate limit trips — which then blocks
 * certificate issuance for every real tenant. The failure is not "an attacker
 * gets a cert for their own domain" (they could get that anywhere); it is that
 * they exhaust the shared issuance budget and take the platform's TLS down.
 *
 * ## Why verification is required before a domain is served
 *
 * A `TenantDomain` row on its own proves nothing — a merchant can type any
 * hostname into the admin form, including a competitor's. Serving it would let
 * them receive traffic for a domain they do not control the moment its DNS
 * pointed here. `verifiedAt` is set only after a DNS TXT record we asked for
 * appears, which requires control of the zone.
 */

/** The TXT record's host prefix. Namespaced so it cannot collide with anything
 * else in a merchant's zone. */
export const VERIFICATION_HOST_PREFIX = '_ventia-verify';

/** Injectable so tests exercise the real verification logic without DNS. */
export type TxtResolver = (hostname: string) => Promise<string[][]>;

/**
 * The platform's own zone, e.g. `ventia.co`. Same default and same env var as
 * `onboarding.service.ts`, which is what mints the subdomains this recognises;
 * if the two ever disagreed, tenants would be issued addresses the TLS gate
 * would then refuse.
 */
export function platformRootDomain(): string {
  return (process.env.PLATFORM_ROOT_DOMAIN ?? 'ventia.localhost').trim().toLowerCase();
}

/**
 * Whether `domain` is inside the platform's own zone — the free
 * `${slug}.${root}` address every tenant gets — rather than a domain the
 * merchant owns and pointed at us.
 *
 * `endsWith('.' + root)` with the dot, deliberately: without it,
 * `evilventia.co` matches `ventia.co` and an attacker who registered a
 * lookalike domain would be treated as living in our zone, skipping the plan
 * gate. The apex itself counts too — it serves the platform landing page and,
 * if it were ever registered as a TenantDomain, is certainly ours.
 */
export function isPlatformSubdomain(domain: string, root: string = platformRootDomain()): boolean {
  return domain === root || domain.endsWith(`.${root}`);
}

/**
 * Why a verification attempt did not succeed, in the merchant's terms.
 *
 * Every one of these is a 200 to the merchant — see `verify`'s doc comment —
 * but they call for different next steps, and "no pudimos verificar" with no
 * further detail is the message that makes someone give up on a DNS record
 * that is one typo away from working:
 *
 * - `not_found` — the id is not this tenant's. Not a DNS problem at all.
 * - `dns_unreachable` — the lookup itself failed (NXDOMAIN, timeout). Expected
 *   for minutes after the record is published; the answer is "wait".
 * - `record_missing` — the zone answered, with nothing at that host. Either
 *   the record was never created or it was created under the wrong name (the
 *   classic being `_ventia-verify.tienda.com.tienda.com`, from pasting the
 *   full name into a provider that already appends the zone).
 * - `record_mismatch` — something IS published there and it is not our token.
 *   A stale value from an earlier attempt, or a partial copy-paste. This is
 *   the case worth separating: the merchant did the work and still needs to
 *   fix something, which is very different from having done nothing yet.
 */
export type DomainVerifyFailure = 'not_found' | 'dns_unreachable' | 'record_missing' | 'record_mismatch';

export type DomainVerifyResult = { verified: true } | { verified: false; reason: DomainVerifyFailure };

@Injectable()
export class CustomDomainsService {
  /**
   * Caddy's `ask` answer: may we issue a certificate for this hostname?
   *
   * Four conditions, all required. Each removal is a separate way to hand out
   * certificates for domains this platform has no business serving.
   */
  async isDomainAllowed(rawDomain: string): Promise<boolean> {
    const domain = normalizeDomain(rawDomain);
    if (!domain) return false;

    const row = await platformDb.tenantDomain.findUnique({
      where: { domain },
      include: { tenant: { include: { limits: true } } },
    });

    // 1. Registered at all.
    if (!row) return false;
    // 2. DNS-verified. An unverified row is a hostname somebody typed.
    //    (A platform subdomain is verified at creation by
    //    onboarding.service.ts — we own the zone, so there is nothing to
    //    prove — which is why this check does not need an exemption below.)
    if (!row.verifiedAt) return false;
    // 3. The tenant is actually live. A draft store has nothing to serve, and
    //    a suspended one is suspended precisely so it stops being served —
    //    issuing it a fresh certificate would work against that.
    if (row.tenant.status !== 'live') return false;
    // 4. The plan includes custom domains — BUT ONLY FOR A CUSTOM DOMAIN.
    //
    //    Every tenant is given `${slug}.${PLATFORM_ROOT_DOMAIN}` at
    //    onboarding (onboarding.service.ts), verified, `isPrimary: true`. That
    //    subdomain is not an entitlement, it is the product: it is the only
    //    address a `basico` store has, and `basico.customDomain` is `false`.
    //
    //    Applying the plan gate to it refuses a certificate for the store's
    //    own address, so every basic-plan storefront has no HTTPS and is
    //    simply unreachable. That never showed up in development because
    //    `.localhost` needs no certificate — this endpoint's first real
    //    caller is production.
    //
    //    So the gate applies to domains OUTSIDE our own zone, which is what
    //    "custom domain" means and what the plan is actually selling.
    if (!isPlatformSubdomain(domain) && !row.tenant.limits?.customDomain) return false;

    return true;
  }

  /**
   * Promotes a verified domain to the tenant's PRIMARY address.
   *
   * ## Why this has to exist for a custom domain to mean anything
   *
   * Connecting a domain and BEING that domain are different things, and until
   * this method the platform only did the first. `add()` creates every custom
   * domain with `isPrimary: false`, and the only row that ever carried
   * `isPrimary: true` was the `${slug}.${root}` subdomain minted at onboarding.
   *
   * That matters because `isPrimary` is what the rest of the system reads to
   * answer "where does this store live":
   *
   *   - `whatsapp-inbound.service.ts#storefrontBaseUrl` orders by it to build
   *     the links the agent sends to real shoppers.
   *   - `privacy-policy.service.ts` quotes it as the store's web address in the
   *     published política de tratamiento.
   *
   * So a merchant could point `mitienda.com` here, pass DNS verification and
   * get a certificate, while their customers kept receiving WhatsApp links to
   * `mitienda.ventia.co` and their own privacy policy kept naming a domain they
   * did not choose. Both consumers already read `isPrimary` correctly; what was
   * missing was any way to change it.
   *
   * ## Verified only
   *
   * An unverified domain must never become primary. `verifiedAt` is the only
   * evidence the merchant controls the name, and promoting an unverified one
   * would put a hostname nobody has proven into every outbound link and into a
   * legal document — and, because `isDomainAllowed` refuses to issue a
   * certificate for it, those links would land on a TLS error.
   *
   * ## Exactly one primary
   *
   * Demote-then-promote in ONE transaction. Two primaries would make
   * `find(d => d.isPrimary)` return whichever row the database happened to
   * yield first, so a shopper's link host would change run to run. Postgres has
   * no partial unique index here to lean on, so the transaction is the
   * guarantee.
   *
   * Returns `null` when the domain does not belong to this tenant or is not
   * verified, so the caller can tell those apart from success without this
   * method deciding the HTTP status.
   */
  async setPrimary(tenantId: string, id: string): Promise<{ id: string; domain: string } | null> {
    const row = await platformDb.tenantDomain.findFirst({ where: { id, tenantId } });
    if (!row || !row.verifiedAt) return null;

    return platformDb.$transaction(async (tx) => {
      await tx.tenantDomain.updateMany({ where: { tenantId, isPrimary: true }, data: { isPrimary: false } });
      const promoted = await tx.tenantDomain.update({ where: { id }, data: { isPrimary: true } });
      return { id: promoted.id, domain: promoted.domain };
    });
  }

  /**
   * The TXT value a merchant must publish. Derived from the domain and the
   * tenant rather than random, so it is stable across retries — a merchant who
   * reloads the page mid-setup must not be handed a different token than the
   * one they already pasted into their DNS panel.
   *
   * HMAC-style over a server-side secret so it cannot be computed by someone
   * who only knows the domain and tenant id.
   */
  verificationToken(tenantId: string, domain: string): string {
    const secret = process.env.DOMAIN_VERIFICATION_SECRET ?? process.env.PAYMENTS_ENCRYPTION_KEY ?? '';
    return createHash('sha256').update(`${secret}:${tenantId}:${normalizeDomain(domain)}`).digest('hex').slice(0, 32);
  }

  /**
   * Checks the merchant's zone for the expected TXT record and, if present,
   * marks the domain verified.
   *
   * A DNS failure (NXDOMAIN, timeout) is reported as "not yet", not as an
   * error: a merchant who just added the record is genuinely in that state for
   * minutes, and an error page would make them think they had done it wrong.
   */
  async verify(
    tenantId: string,
    domainId: string,
    resolveTxt: TxtResolver = defaultResolveTxt,
  ): Promise<DomainVerifyResult> {
    const row = await platformDb.tenantDomain.findFirst({ where: { id: domainId, tenantId } });
    if (!row) return { verified: false, reason: 'not_found' };
    if (row.verifiedAt) return { verified: true };

    const expected = this.verificationToken(tenantId, row.domain);
    let records: string[][];
    try {
      records = await resolveTxt(`${VERIFICATION_HOST_PREFIX}.${row.domain}`);
    } catch {
      return { verified: false, reason: 'dns_unreachable' };
    }

    if (records.length === 0) return { verified: false, reason: 'record_missing' };

    // TXT values arrive as arrays of chunks; a long value is split by the DNS
    // protocol itself and must be rejoined before comparison.
    const found = records.some((chunks) => chunks.join('').trim() === expected);
    if (!found) return { verified: false, reason: 'record_mismatch' };

    await platformDb.tenantDomain.update({ where: { id: row.id }, data: { verifiedAt: new Date() } });
    return { verified: true };
  }

  /** Registers a domain against a tenant, unverified. */
  async add(tenantId: string, rawDomain: string): Promise<{ id: string; domain: string; token: string }> {
    const domain = normalizeDomain(rawDomain);
    if (!domain) throw new Error('invalid domain');

    const row = await platformDb.tenantDomain.create({ data: { tenantId, domain, isPrimary: false } });
    return { id: row.id, domain, token: this.verificationToken(tenantId, domain) };
  }

  async listForTenant(tenantId: string) {
    const rows = await platformDb.tenantDomain.findMany({ where: { tenantId }, orderBy: { domain: 'asc' } });
    return rows.map((row) => ({
      id: row.id,
      domain: row.domain,
      isPrimary: row.isPrimary,
      verified: row.verifiedAt !== null,
      token: this.verificationToken(tenantId, row.domain),
    }));
  }

  /**
   * Removes a domain, refusing the two cases that leave the store worse than
   * the merchant intended.
   *
   * This used to be an unconditional `deleteMany`, which allowed both:
   *
   * **Deleting the last domain.** A tenant with no `TenantDomain` row has no
   * address at all: `DomainResolver` cannot resolve it, so the storefront is
   * unreachable, and `whatsapp-inbound.service.ts#storefrontBaseUrl` builds
   * links from `''`. It is also not self-recoverable — `add()` is gated on the
   * `customDomain` plan feature, so a `basico` merchant who deleted their own
   * subdomain could not put it back.
   *
   * **Deleting the primary while others remain.** `find(d => d.isPrimary)`
   * then returns `undefined` and `storefrontBaseUrl` falls through to its
   * alphabetical tie-break, so the host in every link the agent sends to
   * shoppers changes — silently, and to whichever domain happens to sort
   * first. Reassigning primary automatically would be worse: it would pick a
   * new public address for the store without anyone deciding it. Making the
   * merchant promote another domain first is the only version where the
   * store's address changes because someone chose it.
   *
   * Returns a discriminated result rather than a boolean so the caller can
   * distinguish "not yours" from the two refusals without re-querying.
   */
  async remove(
    tenantId: string,
    domainId: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'is_primary' | 'last_domain' }> {
    const row = await platformDb.tenantDomain.findFirst({ where: { id: domainId, tenantId } });
    if (!row) return { ok: false, reason: 'not_found' };

    const total = await platformDb.tenantDomain.count({ where: { tenantId } });
    if (total <= 1) return { ok: false, reason: 'last_domain' };
    if (row.isPrimary) return { ok: false, reason: 'is_primary' };

    await platformDb.tenantDomain.delete({ where: { id: domainId } });
    return { ok: true };
  }
}

/**
 * Lowercases, strips a port, a trailing dot and any scheme or path a merchant
 * might paste.
 *
 * Returns `null` for anything that is not a plausible hostname — and that
 * rejection is load-bearing, because this value is compared against a database
 * column to decide certificate issuance. A value that normalizes loosely could
 * match a row it should not.
 */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z]+:\/\//, '');
  value = value.split('/')[0]!;
  value = value.split(':')[0]!;
  value = value.replace(/\.$/, '');
  if (!value || value.length > 253) return null;
  // Labels: alphanumeric plus hyphens, not leading/trailing hyphen, at least
  // two labels. Deliberately strict — a wildcard or an underscore here has no
  // legitimate use and both are things people try.
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value)) return null;
  return value;
}

const defaultResolveTxt: TxtResolver = (hostname) => dnsPromises.resolveTxt(hostname);
