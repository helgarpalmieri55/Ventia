import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { WhatsAppNumbersService as WhatsAppNumbersServiceType } from '../src/whatsapp/whatsapp-numbers.service';

/**
 * The inbound WhatsApp path, end to end through real HTTP.
 *
 * The property this file exists for is routing: Meta delivers ONE webhook per
 * app covering every number registered under it, so this single URL receives
 * every tenant's traffic and the only discriminator is a value inside an
 * unauthenticated payload. Getting that wrong is not a 500 — it is one store's
 * customers reaching another store's agent.
 */

const APP_SECRET = 'meta-app-secret';
const CLOUD_PHONE_ID = '106540352242922';
const OTHER_PHONE_ID = '999000111222333';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let numbers: WhatsAppNumbersServiceType;

let tenantId: string;
let otherTenantId: string;

/** Replaces the real Anthropic call so a delivery exercises the whole route
 * without a model. */
let scripted: unknown[] = [];

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-used';
  process.env.PAYMENTS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

  const { ANTHROPIC_CLIENT } = await import('../src/agent/agent.service');
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ANTHROPIC_CLIENT)
    .useValue({
      messages: {
        create: vi.fn(async () => {
          const next = scripted.shift();
          if (!next) throw new Error('fake anthropic client: no scripted response left');
          return next;
        }),
      },
    })
    .compile();

  app = moduleRef.createNestApplication();
  // The raw-body middleware `main.ts` mounts for /webhooks is what Cloud's
  // signature verification needs; a testing module does not get it, so it is
  // applied here for the same reason and in the same shape.
  const express = (await import('express')).default;
  app.use('/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
  await app.init();

  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });
  const { WhatsAppNumbersService } = await import('../src/whatsapp/whatsapp-numbers.service');
  numbers = app.get(WhatsAppNumbersService);

  const tenant = await prisma.tenant.create({
    data: {
      slug: `wa-${Date.now()}`,
      name: 'Tienda WhatsApp',
      status: 'live',
      limits: { create: { productsMax: 100, aiCreditsMonth: 500, staffSeats: 2, whatsappChannel: true } },
    },
  });
  tenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId, domain: 'wa-tienda.ventia.localhost', isPrimary: true } });

  const other = await prisma.tenant.create({
    data: {
      slug: `wa-other-${Date.now()}`,
      name: 'Otra Tienda',
      status: 'live',
      limits: { create: { productsMax: 100, aiCreditsMonth: 500, staffSeats: 2, whatsappChannel: true } },
    },
  });
  otherTenantId = other.id;
  await prisma.tenantDomain.create({
    data: { tenantId: otherTenantId, domain: 'wa-otra.ventia.localhost', isPrimary: true },
  });

  await numbers.connect({
    tenantId,
    provider: 'cloud',
    externalId: CLOUD_PHONE_ID,
    displayPhone: '+573001112233',
    credentials: { token: 'cloud-token', appSecret: APP_SECRET, verifyToken: 'verify-me' },
  });
  await numbers.connect({
    tenantId: otherTenantId,
    provider: 'cloud',
    externalId: OTHER_PHONE_ID,
    displayPhone: '+573009998877',
    credentials: { token: 'other-token', appSecret: 'other-secret', verifyToken: 'other-verify' },
  });
}, 240_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

beforeEach(() => {
  scripted = [];
});

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 5, output_tokens: 5 },
    stop_reason: 'end_turn',
  };
}

function cloudPayload(opts: { phoneNumberId?: string; text?: string; messageId?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '573001112233', phone_number_id: opts.phoneNumberId ?? CLOUD_PHONE_ID },
              contacts: [{ profile: { name: 'Juana' }, wa_id: '573007654321' }],
              messages: [
                {
                  from: '573007654321',
                  id: opts.messageId ?? `wamid.${Math.random().toString(36).slice(2)}`,
                  timestamp: '1749416383',
                  type: 'text',
                  text: { body: opts.text ?? '¿tienen camisas?' },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

/** POSTs a payload signed with `secret`, the way Meta would. */
function post(payload: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
  return request(app.getHttpServer())
    .post('/webhooks/whatsapp/cloud')
    .set('content-type', 'application/json')
    .set('x-hub-signature-256', signature)
    .send(raw);
}

/** The inbound handler is fire-and-forget, so a test asserting on its effects
 * has to let it finish. */
async function settle(ms = 400) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drops the agent's repeated-identical-message cool-down keys, so a test can
 * isolate a mechanism the cool-down would otherwise mask. */
async function clearThrottleCooldown(): Promise<void> {
  const Redis = (await import('ioredis')).default;
  const redis = new Redis(process.env.REDIS_URL!);
  const keys = await redis.keys('agent:dup:*');
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
}

describe('POST /webhooks/whatsapp/cloud — routing', () => {
  it('answers the tenant that owns the phone_number_id', async () => {
    scripted = [textResponse('¡Claro! Tenemos varias.')];

    const res = await post(cloudPayload());
    expect(res.status).toBe(200);
    await settle();

    const conversation = await prisma.conversation.findFirst({
      where: { tenantId, channel: 'whatsapp', shopperRef: '573007654321' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.messages.map((m) => m.content)).toContain('¿tienen camisas?');
  });

  it('NEVER routes a delivery to a tenant that does not own the number', async () => {
    // The failure this whole design exists to prevent. The payload names the
    // other store's number and is signed with THEIR secret — so it is a
    // perfectly valid delivery, just not ours.
    scripted = [textResponse('no debería usarse')];

    await post(cloudPayload({ phoneNumberId: OTHER_PHONE_ID, text: 'mensaje ajeno' }), 'other-secret');
    await settle();

    const leaked = await prisma.message.findFirst({ where: { tenantId, content: 'mensaje ajeno' } });
    expect(leaked).toBeNull();
    const landed = await prisma.message.findFirst({ where: { tenantId: otherTenantId, content: 'mensaje ajeno' } });
    expect(landed).not.toBeNull();
  });

  it('drops a payload signed with the WRONG secret, without answering', async () => {
    scripted = [textResponse('no debería enviarse')];

    const res = await post(cloudPayload({ text: 'firma falsa' }), 'forged-secret');
    expect(res.status).toBe(200);
    await settle();

    expect(await prisma.message.findFirst({ where: { content: 'firma falsa' } })).toBeNull();
  });

  it('200s an unknown number rather than revealing it is unknown', async () => {
    // A 404 would tell an unauthenticated caller which numbers this platform
    // serves, and would make Meta retry a delivery that can never become
    // valid.
    const res = await post(cloudPayload({ phoneNumberId: '000000000000' }));
    expect(res.status).toBe(200);
  });

  it('200s malformed and empty bodies', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/whatsapp/cloud')
      .set('content-type', 'application/json')
      .send('not json');
    expect(res.status).toBe(200);
  });

  it('404s an unknown provider', async () => {
    const res = await request(app.getHttpServer()).post('/webhooks/whatsapp/telegram').send({});
    expect(res.status).toBe(404);
  });
});

describe('POST /webhooks/whatsapp/cloud — retries and plan', () => {
  it('answers a retried delivery exactly once, and calls the model once', async () => {
    // Both providers retry with the SAME message id. Without dedupe the
    // merchant is billed twice and the shopper is answered twice.
    //
    // Two things about the shape of this test, both learned the hard way when
    // mutation testing showed an earlier version passing with dedupe REMOVED:
    //
    //  1. It asserts the MODEL was not called again, not just that one row
    //     exists. The row count alone proves nothing — the unique index would
    //     reject the second insert anyway, AFTER a model call the merchant has
    //     already paid for. The turn being skipped is the property worth
    //     having.
    //  2. The agent's repeated-identical-message cool-down (30s, in Redis)
    //     also swallows a same-text retry, and it was what made the earlier
    //     version pass. It is cleared between the two deliveries here so the
    //     only thing that can absorb the second one is the dedupe under test.
    //     A real retry arriving after the cool-down expires is exactly the
    //     case this covers.
    const messageId = `wamid.RETRY-${Date.now()}`;
    scripted = [textResponse('primera y única'), textResponse('esto no debe enviarse')];

    await post(cloudPayload({ messageId, text: 'reintento' }));
    await settle();
    expect(scripted).toHaveLength(1); // one model call consumed

    await clearThrottleCooldown();
    await post(cloudPayload({ messageId, text: 'reintento' }));
    await settle();

    // Still one consumed: the retry never reached the model.
    expect(scripted).toHaveLength(1);
    const stored = await prisma.message.findMany({ where: { tenantId, content: 'reintento' } });
    expect(stored).toHaveLength(1);
    expect(stored[0].externalId).toBe(messageId);
  });

  it('lets a genuinely NEW message through after a retry was dropped', async () => {
    // The failure the dedupe must not cause: a shopper's real follow-up being
    // mistaken for a retry and silently ignored.
    scripted = [textResponse('respuesta al seguimiento')];

    await post(cloudPayload({ messageId: `wamid.NEW-${Date.now()}`, text: 'otra pregunta distinta' }));
    await settle();

    expect(scripted).toHaveLength(0);
    const stored = await prisma.message.findMany({ where: { tenantId, content: 'otra pregunta distinta' } });
    expect(stored).toHaveLength(1);
  });

  it('does not answer a store whose plan no longer includes WhatsApp', async () => {
    // A downgraded store keeps its number registered and Meta keeps
    // delivering. Without this check it keeps spending AI budget through a
    // channel it no longer pays for.
    await prisma.tenantLimits.update({ where: { tenantId }, data: { whatsappChannel: false } });
    scripted = [textResponse('no debería enviarse')];

    await post(cloudPayload({ text: 'plan revocado' }));
    await settle();

    expect(await prisma.message.findFirst({ where: { tenantId, content: 'plan revocado' } })).toBeNull();
    await prisma.tenantLimits.update({ where: { tenantId }, data: { whatsappChannel: true } });
  });

  it('does not answer through a DISABLED number', async () => {
    const [number] = await numbers.listForTenant(tenantId);
    await numbers.setStatus(tenantId, number.id, 'disabled');
    scripted = [textResponse('no debería enviarse')];

    await post(cloudPayload({ text: 'numero apagado' }));
    await settle();

    expect(await prisma.message.findFirst({ where: { tenantId, content: 'numero apagado' } })).toBeNull();
    await numbers.setStatus(tenantId, number.id, 'connected');
  });
});

describe('GET /webhooks/whatsapp/cloud — Meta handshake', () => {
  it('echoes the challenge as plain text for the right verify token', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/whatsapp/cloud')
      .query({
        number: CLOUD_PHONE_ID,
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-me',
        'hub.challenge': '1158201444',
      });

    expect(res.status).toBe(200);
    // Plain text, not JSON — Meta compares the body byte for byte.
    expect(res.text).toBe('1158201444');
  });

  it('403s a wrong verify token', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/whatsapp/cloud')
      .query({
        number: CLOUD_PHONE_ID,
        'hub.mode': 'subscribe',
        'hub.verify_token': 'guessed',
        'hub.challenge': '1158201444',
      });

    expect(res.status).toBe(403);
  });

  it('403s another tenant\'s verify token against this number', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/whatsapp/cloud')
      .query({
        number: CLOUD_PHONE_ID,
        'hub.mode': 'subscribe',
        'hub.verify_token': 'other-verify',
        'hub.challenge': '1',
      });

    expect(res.status).toBe(403);
  });
});

describe('WhatsAppNumbersService — ownership', () => {
  it('refuses to let a tenant claim a number another tenant already holds', async () => {
    // The unique constraint is the routing guarantee: two rows with one
    // externalId would make an inbound delivery ambiguous.
    await expect(
      numbers.connect({
        tenantId,
        provider: 'cloud',
        externalId: OTHER_PHONE_ID,
        displayPhone: '+573001112233',
        credentials: { token: 'stolen', appSecret: 'x' },
      }),
    ).rejects.toThrow();
  });

  it('lets a tenant re-connect its OWN number, rotating the token', async () => {
    const before = await numbers.listForTenant(tenantId);
    await numbers.connect({
      tenantId,
      provider: 'cloud',
      externalId: CLOUD_PHONE_ID,
      displayPhone: '+573001112233',
      credentials: { token: 'rotated-token', appSecret: APP_SECRET, verifyToken: 'verify-me' },
    });
    const after = await numbers.listForTenant(tenantId);

    expect(after).toHaveLength(before.length);
    expect(after[0].status).toBe('connected');
  });

  it('never exposes credentials through the list view', async () => {
    const view = await numbers.listForTenant(tenantId);
    expect(JSON.stringify(view)).not.toContain('rotated-token');
    expect(JSON.stringify(view)).not.toContain(APP_SECRET);
    expect(JSON.stringify(view)).not.toContain('verify-me');
  });

  it('cannot disable another tenant\'s number', async () => {
    const [foreign] = await numbers.listForTenant(otherTenantId);
    const result = await numbers.setStatus(tenantId, foreign.id, 'disabled');

    expect(result).toBeNull();
    const [unchanged] = await numbers.listForTenant(otherTenantId);
    expect(unchanged.status).toBe('connected');
  });
});
