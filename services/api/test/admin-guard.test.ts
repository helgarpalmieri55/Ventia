import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import { startTestDb } from './helpers';
import type { signUpAndGetCookie as SignUpAndGetCookie, signUpWithTenant as SignUpWithTenant } from './admin-helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpAndGetCookie: typeof SignUpAndGetCookie;
let signUpWithTenant: typeof SignUpWithTenant;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // platformDb (exported by @ventia/db) and the admin-helpers' fresh PrismaClient
  // are both constructed at module-evaluation time from process.env.DATABASE_URL,
  // so env vars must be set BEFORE the first import (static or dynamic) of
  // @ventia/db, ../src/main, or ./admin-helpers.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpAndGetCookie, signUpWithTenant } = await import('./admin-helpers'));
});

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

describe('GET /v1/admin/me', () => {
  it('401 without a session', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('403 NO_TENANT with session but no membership', async () => {
    const cookie = await signUpAndGetCookie('nomember@demo.co');
    const res = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NO_TENANT');
  });

  it('returns the admin session with membership', async () => {
    const { cookie, tenantId, userId } = await signUpWithTenant('owner1@demo.co', 'owner');
    const res = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId, tenantId, role: 'owner', email: 'owner1@demo.co' });
  });
});
