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
