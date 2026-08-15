import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { PrismaClient } from '@ventia/db';
import { startTestDb } from './helpers';
import { DomainResolver, normalizeHost } from '../src/tenants/domain-resolver';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let redis: Redis;
let prisma: PrismaClient;
let resolver: DomainResolver;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new Redis({ host: redisContainer.getHost(), port: redisContainer.getMappedPort(6379) });
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  const tenant = await prisma.tenant.create({ data: { slug: 'demo', name: 'Demo', status: 'live' } });
  await prisma.tenantDomain.create({ data: { tenantId: tenant.id, domain: 'demo.ventia.localhost', isPrimary: true } });
  resolver = new DomainResolver(redis, prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
  await redisContainer.stop();
  await db.stop();
});

describe('normalizeHost', () => {
  it('strips port and lowercases', () => {
    expect(normalizeHost('Demo.Ventia.localhost:3000')).toBe('demo.ventia.localhost');
  });
  it('returns null for undefined', () => {
    expect(normalizeHost(undefined)).toBeNull();
  });
});

describe('DomainResolver', () => {
  it('resolves a known domain', async () => {
    const t = await resolver.resolve('demo.ventia.localhost');
    expect(t?.slug).toBe('demo');
    expect(t?.status).toBe('live');
  });

  it('includes the tenant theme in the resolved (and cached) result', async () => {
    const themed = await prisma.tenant.create({
      data: { slug: 'themed', name: 'Themed', status: 'live', theme: { primary: '#123456' } },
    });
    await prisma.tenantDomain.create({ data: { tenantId: themed.id, domain: 'themed.ventia.localhost', isPrimary: true } });

    const fresh = await resolver.resolve('themed.ventia.localhost');
    expect(fresh?.theme).toEqual({ primary: '#123456' });

    // Same value must survive the Redis round trip (JSON.stringify/parse),
    // not just the first, DB-backed resolve.
    const cached = await resolver.resolve('themed.ventia.localhost');
    expect(cached?.theme).toEqual({ primary: '#123456' });
  });

  // --- Multi-tenancy payment-redirect fix: the resolved tenant now carries
  // the DOMAIN it was resolved through, which is what checkout turns into the
  // per-tenant storefront base URL the Wompi/ePayco adapters redirect to.
  it('carries the TenantDomain row it resolved through, and it survives the Redis round trip', async () => {
    const t = await prisma.tenant.create({ data: { slug: 'domained', name: 'Domained', status: 'live' } });
    await prisma.tenantDomain.create({
      data: { tenantId: t.id, domain: 'domained.ventia.localhost', isPrimary: true },
    });

    const fresh = await resolver.resolve('domained.ventia.localhost');
    expect(fresh?.domain).toBe('domained.ventia.localhost');

    const cached = await resolver.resolve('domained.ventia.localhost');
    expect(cached?.domain).toBe('domained.ventia.localhost');
  });

  it('gives two tenants their OWN domains, never a shared one', async () => {
    const one = await prisma.tenant.create({ data: { slug: 'dr-one', name: 'One', status: 'live' } });
    const two = await prisma.tenant.create({ data: { slug: 'dr-two', name: 'Two', status: 'live' } });
    await prisma.tenantDomain.create({ data: { tenantId: one.id, domain: 'dr-one.ventia.localhost', isPrimary: true } });
    // Deliberately a fully CUSTOM domain, not a `*.ventia.localhost` subdomain:
    // proves the value comes from the TenantDomain table and is not derivable
    // from PLATFORM_ROOT_DOMAIN + slug.
    await prisma.tenantDomain.create({ data: { tenantId: two.id, domain: 'tienda-dos.example.com', isPrimary: true } });

    const a = await resolver.resolve('dr-one.ventia.localhost');
    const b = await resolver.resolve('tienda-dos.example.com');
    expect(a?.domain).toBe('dr-one.ventia.localhost');
    expect(b?.domain).toBe('tienda-dos.example.com');
    expect(a?.domain).not.toBe(b?.domain);
  });

  it('treats a cached entry written before `domain` existed as a MISS and re-reads the DB', async () => {
    // Simulates an in-flight Redis entry from the previous deploy. Without the
    // re-read, checkout would build `http://undefined/pago/...` for the 60s
    // TTL window.
    const t = await prisma.tenant.create({ data: { slug: 'stale', name: 'Stale', status: 'live' } });
    await prisma.tenantDomain.create({ data: { tenantId: t.id, domain: 'stale.ventia.localhost', isPrimary: true } });
    await redis.set(
      'tenant:domain:stale.ventia.localhost',
      JSON.stringify({ tenantId: t.id, slug: 'stale', name: 'Stale', status: 'live', theme: null }),
      'EX',
      60,
    );

    const resolved = await resolver.resolve('stale.ventia.localhost');
    expect(resolved?.domain).toBe('stale.ventia.localhost');
    expect(resolved?.slug).toBe('stale');
  });

  it('returns null for unknown domain and caches the miss', async () => {
    expect(await resolver.resolve('nope.ventia.localhost')).toBeNull();
    expect(await redis.get('tenant:domain:nope.ventia.localhost')).toBe('null');
  });

  it('serves from cache after first hit (db row deleted, still resolves)', async () => {
    await resolver.resolve('demo.ventia.localhost');
    await prisma.tenantDomain.deleteMany({ where: { domain: 'demo.ventia.localhost' } });
    const t = await resolver.resolve('demo.ventia.localhost');
    expect(t?.slug).toBe('demo');
  });
});
