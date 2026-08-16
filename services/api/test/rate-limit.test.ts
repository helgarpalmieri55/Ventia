import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import Redis from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { clientIp, createRateLimiter } from '../src/common/rate-limit';

let redisContainer: StartedTestContainer;
let redis: Redis;

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  redis = new Redis(`redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`);
}, 120_000);

afterAll(async () => {
  await redis.quit();
  await redisContainer.stop();
});

/** A minimal app with one limited route, so these tests exercise the limiter
 * itself rather than any particular endpoint's other behaviour. */
function appWith(limiter: express.RequestHandler, path = '/thing'): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(path, limiter);
  app.all(path, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  // Some tests mount the limiter at a prefix and call sub-paths under it.
  app.all(`${path}/*`, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('rate limiter — the bound', () => {
  it('allows up to the limit and rejects past it', async () => {
    const app = appWith(
      createRateLimiter(redis, {
        name: `bound-${Date.now()}`,
        limit: 3,
        windowSeconds: 60,
        key: clientIp,
        errorCode: 'TOO_MANY_REQUESTS',
      }),
    );

    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/thing')).status).toBe(200);
    }

    const blocked = await request(app).get('/thing');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('TOO_MANY_REQUESTS');
  });

  it('tells the caller when to come back, in the response and the header', async () => {
    // A 429 with no Retry-After leaves a well-behaved client guessing, and the
    // usual guess is "immediately".
    const app = appWith(
      createRateLimiter(redis, {
        name: `retry-${Date.now()}`,
        limit: 1,
        windowSeconds: 60,
        key: clientIp,
        errorCode: 'TOO_MANY_REQUESTS',
      }),
    );

    await request(app).get('/thing');
    const blocked = await request(app).get('/thing');

    expect(blocked.status).toBe(429);
    const headerSeconds = Number(blocked.headers['retry-after']);
    expect(headerSeconds).toBeGreaterThan(0);
    expect(headerSeconds).toBeLessThanOrEqual(60);
    expect(blocked.body.details.retryAfterSeconds).toBe(headerSeconds);
  });

  it('counts each key separately, so one caller cannot spend another budget', async () => {
    // The property that makes this a rate limiter rather than a global switch.
    const name = `perkey-${Date.now()}`;
    const app = appWith(
      createRateLimiter(redis, {
        name,
        limit: 1,
        windowSeconds: 60,
        key: (req) => String(req.headers['x-test-subject'] ?? 'anon'),
        errorCode: 'TOO_MANY_REQUESTS',
      }),
    );

    expect((await request(app).get('/thing').set('x-test-subject', 'a')).status).toBe(200);
    expect((await request(app).get('/thing').set('x-test-subject', 'a')).status).toBe(429);
    // Different subject, untouched budget.
    expect((await request(app).get('/thing').set('x-test-subject', 'b')).status).toBe(200);
  });

  it('keeps separate counters per limiter name', async () => {
    // Otherwise the checkout limiter and the auth limiter would share one
    // budget and a shopper checking out could lock someone out of signing in.
    const suffix = Date.now();
    const key = () => 'shared-subject';
    const authApp = appWith(
      createRateLimiter(redis, {
        name: `auth-${suffix}`,
        limit: 1,
        windowSeconds: 60,
        key,
        errorCode: 'TOO_MANY_REQUESTS',
      }),
    );
    const checkoutApp = appWith(
      createRateLimiter(redis, {
        name: `checkout-${suffix}`,
        limit: 1,
        windowSeconds: 60,
        key,
        errorCode: 'TOO_MANY_REQUESTS',
      }),
    );

    expect((await request(authApp).get('/thing')).status).toBe(200);
    expect((await request(authApp).get('/thing')).status).toBe(429);
    // Same subject, different limiter — its own budget.
    expect((await request(checkoutApp).get('/thing')).status).toBe(200);
  });

  it('sets a TTL so a counter cannot strand a caller forever', async () => {
    // Without an expiry, a key that reached the limit would stay at the limit
    // permanently — a rate limiter that turns into a permanent ban.
    const name = `ttl-${Date.now()}`;
    const app = appWith(
      createRateLimiter(redis, {
        name,
        limit: 1,
        windowSeconds: 60,
        key: () => 'ttl-subject',
        errorCode: 'TOO_MANY_REQUESTS',
      }),
    );

    await request(app).get('/thing');

    const [key] = await redis.keys(`ratelimit:${name}:*`);
    expect(key).toBeDefined();
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('lets the window roll over', async () => {
    // A 1-second window, so this observes a real rollover rather than trusting
    // the arithmetic.
    const app = appWith(
      createRateLimiter(redis, {
        name: `rollover-${Date.now()}`,
        limit: 1,
        windowSeconds: 1,
        key: () => 'rollover-subject',
        errorCode: 'TOO_MANY_REQUESTS',
      }),
    );

    expect((await request(app).get('/thing')).status).toBe(200);
    expect((await request(app).get('/thing')).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect((await request(app).get('/thing')).status).toBe(200);
  });
});

describe('rate limiter — fails open', () => {
  it('allows the request when Redis is unreachable', async () => {
    // The most important behaviour in this file. This limiter guards the
    // payment webhook endpoint, where a rejected request is a settle that did
    // not happen — so a Redis outage must never become lost payments. It is
    // abuse control, not authorization: nothing here decides whether a caller
    // MAY act, only whether they are acting too fast.
    const dead = new Redis('redis://127.0.0.1:6390', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    dead.on('error', () => {});
    await dead.connect().catch(() => {});

    const app = appWith(
      createRateLimiter(dead, {
        name: 'failopen',
        limit: 1,
        windowSeconds: 60,
        key: clientIp,
        errorCode: 'TOO_MANY_REQUESTS',
      }),
    );

    // Well past the limit — every one still gets through.
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/thing')).status).toBe(200);
    }

    dead.disconnect();
  });

  it('does not limit a request whose key cannot be determined', async () => {
    // A null key means "not attributable". Lumping those into one shared
    // bucket would let one unattributable caller throttle every other.
    const app = appWith(
      createRateLimiter(redis, {
        name: `nullkey-${Date.now()}`,
        limit: 1,
        windowSeconds: 60,
        key: () => null,
        errorCode: 'TOO_MANY_REQUESTS',
      }),
    );

    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/thing')).status).toBe(200);
    }
  });
});

describe('rate limiter — the webhook key', () => {
  // Mirrors main.ts's webhook keying. Gateway callbacks all come from a handful
  // of the gateway's own addresses, so keying webhooks by IP would put every
  // merchant in one bucket and let one busy store throttle every other store's
  // payments.
  const webhookKey = (req: express.Request): string | null => {
    const parts = req.path.split('/').filter(Boolean);
    return parts.length >= 3 && parts[0] === 'payments' ? `${parts[1]}:${parts[2]}` : null;
  };

  function webhookApp(name: string): express.Express {
    const app = express();
    app.set('trust proxy', 1);
    app.use(
      '/webhooks',
      createRateLimiter(redis, {
        name,
        limit: 2,
        windowSeconds: 60,
        key: webhookKey,
        errorCode: 'TOO_MANY_REQUESTS',
      }),
    );
    app.all('/webhooks/*', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    return app;
  }

  it('gives each tenant its own budget, even from one address', async () => {
    const app = webhookApp(`wh-tenant-${Date.now()}`);
    const a = '/webhooks/payments/wompi/tenant-a';
    const b = '/webhooks/payments/wompi/tenant-b';

    expect((await request(app).post(a)).status).toBe(200);
    expect((await request(app).post(a)).status).toBe(200);
    expect((await request(app).post(a)).status).toBe(429);

    // Tenant B's payments are unaffected by tenant A exhausting its budget —
    // the whole reason this is keyed by tenant rather than by IP.
    expect((await request(app).post(b)).status).toBe(200);
  });

  it('separates providers for the same tenant', async () => {
    const app = webhookApp(`wh-provider-${Date.now()}`);

    expect((await request(app).post('/webhooks/payments/wompi/t1')).status).toBe(200);
    expect((await request(app).post('/webhooks/payments/wompi/t1')).status).toBe(200);
    expect((await request(app).post('/webhooks/payments/wompi/t1')).status).toBe(429);
    expect((await request(app).post('/webhooks/payments/epayco/t1')).status).toBe(200);
  });

  it('does not limit a webhook path carrying no tenant', async () => {
    const app = webhookApp(`wh-notenant-${Date.now()}`);

    for (let i = 0; i < 4; i++) {
      expect((await request(app).post('/webhooks/payments/wompi')).status).toBe(200);
    }
  });
});
