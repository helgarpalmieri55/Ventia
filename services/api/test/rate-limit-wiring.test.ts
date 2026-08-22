import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import { startTestDb } from './helpers';

/**
 * Proves the limiter is actually MOUNTED on the routes `main.ts` claims, which
 * `rate-limit.test.ts` cannot show — that file drives the middleware directly
 * against a throwaway Express app, so it would keep passing if the real wiring
 * were deleted.
 *
 * The limits are set to 1/minute BEFORE `createApp()` runs, since main.ts reads
 * them once while building the middleware chain. `test/setup.ts` only fills
 * these in when absent, so setting them here wins.
 */
process.env.RATE_LIMIT_AUTH_PER_MINUTE = '1';
process.env.RATE_LIMIT_CHECKOUT_PER_MINUTE = '1';
process.env.RATE_LIMIT_AGENT_PER_MINUTE = '1';
// Deliberately DIFFERENT from the auth limit above. If the shopper mount read
// the merchant budget, its second request would 429 — the tests below pin that
// it allows two and refuses the third, which only holds with its own counter.
process.env.RATE_LIMIT_SHOPPER_AUTH_PER_MINUTE = '2';
process.env.RATE_LIMIT_WEBHOOKS_PER_MINUTE = '1';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
}, 120_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

describe('rate limiting is wired onto the real routes', () => {
  it('limits /v1/auth', async () => {
    const server = app.getHttpServer();
    // Whatever better-auth answers for the first call, the SECOND must be the
    // limiter's 429 — the assertion is about who answers, not about auth.
    await request(server).post('/v1/auth/sign-in/email').send({ email: 'a@demo.co', password: 'x' });
    const second = await request(server)
      .post('/v1/auth/sign-in/email')
      .send({ email: 'a@demo.co', password: 'x' });

    expect(second.status).toBe(429);
    expect(second.body.error).toBe('TOO_MANY_REQUESTS');
    expect(second.headers['retry-after']).toBeDefined();
  });

  it('limits /v1/storefront/checkout', async () => {
    const server = app.getHttpServer();
    await request(server).post('/v1/storefront/checkout').send({});
    const second = await request(server).post('/v1/storefront/checkout').send({});

    expect(second.status).toBe(429);
    expect(second.body.error).toBe('TOO_MANY_REQUESTS');
  });

  it('limits /v1/storefront/account', async () => {
    // Shopper sign-in and the "email me a link" routes. Every attempt costs a
    // real scrypt hash, and the link routes send mail this platform pays for
    // to an address the requester does not have to own — unlimited, that is a
    // way to bill us while spamming a stranger.
    const server = app.getHttpServer();
    // Three DIFFERENT addresses, deliberately: the budget is keyed by IP alone,
    // so trying two hundred addresses from one machine must cost the same as
    // retrying one. Keying by address would make enumeration free.
    const from = (email: string) =>
      request(server)
        .post('/v1/storefront/account/magic-link')
        // Its own client address, because the budget is per-IP and the sibling
        // test below would otherwise be spending this one's.
        .set('x-forwarded-for', '203.0.113.11')
        .send({ email });

    await from('a@demo.co');
    await from('b@demo.co');
    const third = await from('c@demo.co');

    expect(third.status).toBe(429);
    expect(third.body.error).toBe('TOO_MANY_REQUESTS');
  });

  it('does not let shopper traffic exhaust the MERCHANT login budget', async () => {
    // Separate buckets. Sharing one would mean a busy storefront locking a
    // merchant out of their own panel, which is an outage caused by success.
    // The shopper budget is 2 and the merchant budget is 1. If this mount read
    // `auth`, the SECOND request here would already be refused; it is not.
    // That difference is the only way to tell one shared counter from two.
    const server = app.getHttpServer();
    const from = (email: string) =>
      request(server)
        .post('/v1/storefront/account/sign-in')
        .set('x-forwarded-for', '203.0.113.22')
        .send({ email, password: 'x' });

    const first = await from('d@demo.co');
    const second = await from('e@demo.co');
    const third = await from('f@demo.co');

    expect(first.status).not.toBe(429);
    expect(second.status).not.toBe(429);
    expect(third.status).toBe(429);
  });

  it('limits /v1/storefront/agent', async () => {
    // The route 404s without a resolvable tenant, which is fine here: the
    // question is only whether the LIMITER runs before Nest routing does, and
    // a 429 on the second call is the only way that answer can be yes.
    const server = app.getHttpServer();
    await request(server).post('/v1/storefront/agent/messages').send({ message: 'hola' });
    const second = await request(server).post('/v1/storefront/agent/messages').send({ message: 'hola' });

    expect(second.status).toBe(429);
    expect(second.body.error).toBe('TOO_MANY_REQUESTS');
  });

  it('limits /webhooks per tenant, not globally', async () => {
    const server = app.getHttpServer();
    // Tenant A burns its budget...
    await request(server).post('/webhooks/payments/wompi/tenant-a').send({});
    const aBlocked = await request(server).post('/webhooks/payments/wompi/tenant-a').send({});
    expect(aBlocked.status).toBe(429);

    // ...and tenant B's payments still get through. If webhooks were keyed by
    // IP, every gateway callback would share one bucket and one busy store
    // could stall every other store's settlements.
    const bFirst = await request(server).post('/webhooks/payments/wompi/tenant-b').send({});
    expect(bFirst.status).not.toBe(429);
  });

  it('leaves unlimited routes alone', async () => {
    // Health is deliberately outside every limiter: a limiter that can make a
    // health check fail turns load into a restart loop.
    const server = app.getHttpServer();
    for (let i = 0; i < 5; i++) {
      const res = await request(server).get('/v1/health');
      expect(res.status).not.toBe(429);
    }
  });
});
