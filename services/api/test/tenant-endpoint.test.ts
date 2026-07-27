import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // platformDb (exported by @ventia/db) is constructed at module-evaluation
  // time from process.env.DATABASE_URL, so env vars must be set BEFORE the
  // first import (static or dynamic) of @ventia/db or ../src/main.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { PrismaClient } = (await import('@ventia/db')) as { PrismaClient: typeof PrismaClientType };
  const prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  const tenant = await prisma.tenant.create({ data: { slug: 'demo', name: 'Demo', status: 'live' } });
  await prisma.tenantDomain.create({ data: { tenantId: tenant.id, domain: 'demo.ventia.localhost', isPrimary: true } });
  const draftTenant = await prisma.tenant.create({ data: { slug: 'draftco', name: 'DraftCo Secret', status: 'draft' } });
  await prisma.tenantDomain.create({ data: { tenantId: draftTenant.id, domain: 'draftco.ventia.localhost', isPrimary: true } });
  const suspendedTenant = await prisma.tenant.create({ data: { slug: 'suspendedco', name: 'SuspendedCo', status: 'suspended' } });
  await prisma.tenantDomain.create({ data: { tenantId: suspendedTenant.id, domain: 'suspendedco.ventia.localhost', isPrimary: true } });
  await prisma.$disconnect();

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

describe('GET /v1/tenant', () => {
  it('resolves by Host header', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/tenant')
      .set('Host', 'demo.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('demo');
    // No theme saved yet for this tenant (created with `theme` left at its
    // Prisma default of null) — the response still carries the key.
    expect(res.body).toHaveProperty('theme');
    expect(res.body.theme).toBeNull();
  });

  it('404s for unknown host', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/tenant')
      .set('Host', 'unknown.ventia.localhost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TENANT_NOT_FOUND');
  });

  it('resolves by x-tenant-domain, taking precedence over a different/absent Host', async () => {
    // No .set('Host', ...) at all — supertest/superagent will still send some
    // Host header for the underlying HTTP request (pointing at the test
    // server), which is deliberately NOT 'demo.ventia.localhost'. This proves
    // x-tenant-domain wins over whatever Host actually arrives.
    const res = await request(app.getHttpServer())
      .get('/v1/tenant')
      .set('x-tenant-domain', 'demo.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('demo');
  });

  // Cross-phase regression (final P2 review): this route predates
  // PublicTenantGuard (added in P2a for /v1/storefront/*) and, until this
  // fix, never enforced the same two invariants — verified to actually leak
  // before the fix: a draft tenant came back 200 with its real name/
  // tenantId/theme (indistinguishable-from-unresolved violated), and a
  // suspended tenant came back a plain 200 (not 503) carrying `status:
  // 'suspended'` for the storefront's own middleware.ts to translate — an
  // external caller hitting the API directly (it's publicly reverse-proxied,
  // not internal-only — see docker/Caddyfile's `api.ventia.*` block) got a
  // 200, not the 503 M1's AC requires.
  it('404s a draft tenant exactly like an unresolved one — no name/id/theme leak', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/tenant')
      .set('Host', 'draftco.ventia.localhost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TENANT_NOT_FOUND');
    expect(res.body).not.toHaveProperty('name');
    expect(res.body).not.toHaveProperty('tenantId');
  });

  it('503s a suspended tenant at the API layer itself, not just a 200 with a status field', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/tenant')
      .set('Host', 'suspendedco.ventia.localhost');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TENANT_SUSPENDED');
  });
});
