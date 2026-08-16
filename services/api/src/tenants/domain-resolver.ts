import type Redis from 'ioredis';
import type { PrismaClient } from '@ventia/db';

export interface ResolvedTenant {
  tenantId: string;
  slug: string;
  name: string;
  status: 'draft' | 'live' | 'suspended';
  /** The `TenantDomain.domain` row this tenant was resolved THROUGH on this
   * request — e.g. `demo-moda.ventia.localhost`, or a fully custom
   * `tienda.example.com`.
   *
   * Added for the payment-redirect multi-tenancy fix. The adapters that send a
   * shopper's browser back to a first-party storefront route (Wompi's
   * return-capture page, ePayco's bridge + response pages) need the PUBLIC
   * base URL of the storefront the order was actually placed on; before this,
   * they read one global env var and sent every tenant's shopper to a single
   * storefront. See `packages/payments/src/index.ts`'s
   * `OrderForPayment.storefrontBaseUrl`.
   *
   * Two properties worth stating explicitly, because the redirect's safety
   * rests on them:
   *  - This is the DB's own value (`row.domain`), not the raw request header.
   *    A host that matches no `TenantDomain` row resolves to `null` and the
   *    request 404s at `PublicTenantGuard`, so a value here is always a domain
   *    the platform has registered FOR THIS TENANT — an attacker cannot steer
   *    a redirect anywhere by forging `Host`/`x-tenant-domain`, they can only
   *    fail to resolve a tenant at all.
   *  - It is the domain the shopper actually arrived on, not a canonical
   *    "primary" one. For a tenant with several domains that is the desired
   *    behavior: the shopper returns to the same storefront they left. */
  domain: string;
  // Optional (not `theme: unknown`): kept off older call sites that build a
  // ResolvedTenant by hand (e.g. tenant-middleware.test.ts fixtures) so this
  // addition doesn't force an unrelated update there. Real resolves always
  // populate it from the tenant row.
  theme?: unknown;
}

export function normalizeHost(host: string | undefined): string | null {
  if (!host) return null;
  return host.split(':')[0]!.trim().toLowerCase() || null;
}

export class DomainResolver {
  constructor(
    private readonly redis: Redis,
    private readonly db: PrismaClient,
    private readonly ttlSeconds = 60,
  ) {}

  async resolve(host: string): Promise<ResolvedTenant | null> {
    const key = `tenant:domain:${host}`;
    const cached = await this.redis.get(key);
    if (cached !== null) {
      if (cached === 'null') return null;
      const parsed = JSON.parse(cached) as Partial<ResolvedTenant>;
      // `domain` was added to this shape after entries were already being
      // cached in production, so an in-flight entry written by the previous
      // deploy can lack it. Treat that as a cache MISS and re-read from the DB
      // rather than handing a `ResolvedTenant` with `domain: undefined` to the
      // checkout path, which would build a redirect URL reading
      // `http://undefined/...`. Self-healing within the 60s TTL, and free
      // afterwards.
      if (typeof parsed.domain === 'string' && parsed.domain.length > 0) {
        return parsed as ResolvedTenant;
      }
    }

    const row = await this.db.tenantDomain.findUnique({
      where: { domain: host },
      include: { tenant: true },
    });
    const resolved: ResolvedTenant | null = row
      ? {
          tenantId: row.tenantId,
          slug: row.tenant.slug,
          name: row.tenant.name,
          status: row.tenant.status,
          theme: row.tenant.theme,
          // The DB's own value, not the request-supplied `host` — see the
          // field's doc comment on why that distinction is load-bearing.
          domain: row.domain,
        }
      : null;
    await this.redis.set(key, resolved ? JSON.stringify(resolved) : 'null', 'EX', this.ttlSeconds);
    return resolved;
  }
}
