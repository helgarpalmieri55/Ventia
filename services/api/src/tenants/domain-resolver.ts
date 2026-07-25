import type Redis from 'ioredis';
import type { PrismaClient } from '@ventia/db';

export interface ResolvedTenant {
  tenantId: string;
  slug: string;
  name: string;
  status: 'draft' | 'live' | 'suspended';
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
    if (cached !== null) return cached === 'null' ? null : (JSON.parse(cached) as ResolvedTenant);

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
        }
      : null;
    await this.redis.set(key, resolved ? JSON.stringify(resolved) : 'null', 'EX', this.ttlSeconds);
    return resolved;
  }
}
