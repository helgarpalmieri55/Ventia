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
});
