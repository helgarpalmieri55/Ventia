import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';

/** `PATCH /v1/storefront/checkout/:orderNumber/provider-ref-hint` (P3c Task 2).
 *
 * The endpoint is deliberately UNAUTHENTICATED (class-level
 * `PublicTenantGuard` only, no `CartCookieGuard`) — the shopper's browser
 * returning from Wompi's/ePayco's redirect has no cart cookie left (checkout
 * cleared it) and no session of any kind. What makes that safe is NOT this
 * endpoint: it's the fact that the value it stores is never trusted on its
 * own, only fed into a later AUTHENTICATED gateway call whose response's own
 * `reference` must then match the order's number
 * (`TransactionStatusResult`, packages/payments/src/index.ts).
 *
 * So the security properties this file pins are exactly the ones that make
 * that arrangement hold: this endpoint writes `Order.providerRef` and
 * NOTHING else (never `paymentStatus`/`status`), and it can never reach
 * another tenant's order.
 */

const HINT_TEST_DOMAINS = ['hint-a.ventia.localhost', 'hint-b.ventia.localhost'];

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;

let tenantAId: string;
let tenantBId: string;

const ADDRESS = {
  nombreCompleto: 'Ana Ejemplo',
  telefono: '3001234567',
  departamentoCode: '11',
  municipioName: 'Bogotá, D.C.',
  direccion: 'Calle 1 # 2-34',
};

/** Seeds a PENDING/PENDING online-payment order — the exact state the
 * reconciliation job (and therefore this hint endpoint) exists to serve. */
async function seedOrder(
  tenantId: string,
  number: number,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  return prisma.order.create({
    data: {
      tenantId,
      number,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      paymentProvider: 'wompi',
      email: 'ana@example.com',
      phone: ADDRESS.telefono,
      shippingAddress: ADDRESS,
      shippingMethod: 'flat-1',
      shippingCents: 12000,
      subtotalCents: 91800,
      taxCents: 14657,
      totalCents: 118457,
      source: 'web',
      ...overrides,
    },
    select: { id: true },
  });
}

function patchHint(orderNumber: string | number, domain: string, body: unknown) {
  return request(app.getHttpServer())
    .patch(`/v1/storefront/checkout/${orderNumber}/provider-ref-hint`)
    .set('x-tenant-domain', domain)
    .send(body as object);
}

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';

  // Same DomainResolver cache-busting as checkout-confirmation.test.ts — a
  // stale 60s entry from a previous local run would otherwise point at a
  // tenantId that doesn't exist in this run's fresh Postgres container.
  const cacheBuster = new Redis(process.env.REDIS_URL);
  await cacheBuster.del(...HINT_TEST_DOMAINS.map((d) => `tenant:domain:${d}`));
  await cacheBuster.quit();

  const { PrismaClient } = (await import('@ventia/db')) as { PrismaClient: typeof PrismaClientType };
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });

  const tenantA = await prisma.tenant.create({ data: { slug: 'hint-a', name: 'Hint A', status: 'live' } });
  tenantAId = tenantA.id;
  await prisma.tenantDomain.create({
    data: { tenantId: tenantAId, domain: 'hint-a.ventia.localhost', isPrimary: true },
  });

  const tenantB = await prisma.tenant.create({ data: { slug: 'hint-b', name: 'Hint B', status: 'live' } });
  tenantBId = tenantB.id;
  await prisma.tenantDomain.create({
    data: { tenantId: tenantBId, domain: 'hint-b.ventia.localhost', isPrimary: true },
  });

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

describe('PATCH /v1/storefront/checkout/:orderNumber/provider-ref-hint — happy path', () => {
  it('stores providerRef and returns {ok:true}, without any cart cookie', async () => {
    const order = await seedOrder(tenantAId, 101);

    const res = await patchHint(101, 'hint-a.ventia.localhost', { providerRef: '01-1531231271-19365' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.providerRef).toBe('01-1531231271-19365');
  });

  it('NEVER touches paymentStatus/status (or any other order field) — the whole safety premise of an unauthenticated endpoint', async () => {
    const order = await seedOrder(tenantAId, 102);
    const before = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

    const res = await patchHint(102, 'hint-a.ventia.localhost', { providerRef: 'txn-abc' });
    expect(res.status).toBe(200);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.providerRef).toBe('txn-abc');

    // Everything else byte-identical. Compared as a whole record (minus the
    // one field this endpoint is allowed to write, and `updatedAt` which
    // Prisma maintains) so a future accidental write to ANY other column —
    // not just the two named in the requirement — fails here too.
    const strip = (o: Record<string, unknown>) => {
      const rest = { ...o };
      delete rest.providerRef;
      delete rest.updatedAt;
      return rest;
    };
    expect(strip(after as unknown as Record<string, unknown>)).toEqual(
      strip(before as unknown as Record<string, unknown>),
    );
    expect(after.paymentStatus).toBe('PENDING');
    expect(after.status).toBe('PENDING');
  });

  it('overwrites an existing non-null providerRef unconditionally (a later source wins; this hint is advisory either way)', async () => {
    const order = await seedOrder(tenantAId, 103, { providerRef: 'old-value' });

    const res = await patchHint(103, 'hint-a.ventia.localhost', { providerRef: 'new-value' });
    expect(res.status).toBe(200);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.providerRef).toBe('new-value');
  });
});

describe('PATCH /v1/storefront/checkout/:orderNumber/provider-ref-hint — not found', () => {
  it('404s with ORDER_NOT_FOUND for a nonexistent order number', async () => {
    const res = await patchHint(999999, 'hint-a.ventia.localhost', { providerRef: 'txn-abc' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ORDER_NOT_FOUND');
  });

  it("404s with ORDER_NOT_FOUND for a non-numeric order number (parses to NaN — Prisma's query engine THROWS on a literal NaN where-value rather than matching zero rows, so this needs its own guard, exactly like the confirmacion route's)", async () => {
    const res = await patchHint('not-a-number', 'hint-a.ventia.localhost', { providerRef: 'txn-abc' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ORDER_NOT_FOUND');
  });

  it('404s (not 500) for an order number that is numeric-ish but unparseable as an integer', async () => {
    const res = await patchHint('%20', 'hint-a.ventia.localhost', { providerRef: 'txn-abc' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ORDER_NOT_FOUND');
  });
});

describe('PATCH /v1/storefront/checkout/:orderNumber/provider-ref-hint — body validation', () => {
  it.each([
    ['an empty body', {}],
    ['an empty-string providerRef', { providerRef: '' }],
    ['a whitespace-only providerRef', { providerRef: '   ' }],
    ['a non-string providerRef (number)', { providerRef: 12345 }],
    ['a non-string providerRef (null)', { providerRef: null }],
    ['a non-string providerRef (object)', { providerRef: { id: 'x' } }],
  ])('400s with VALIDATION_FAILED for %s', async (_label, body) => {
    const order = await seedOrder(tenantAId, 200 + Math.floor(Math.random() * 100000));

    const res = await patchHint(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).number,
      'hint-a.ventia.localhost',
      body,
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');

    // A rejected body must never have written anything.
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.providerRef).toBeNull();
  });

  it('validates the body BEFORE the order lookup, so a bad body on a nonexistent order still 400s (cheap, and never leaks order existence to a malformed request)', async () => {
    const res = await patchHint(999999, 'hint-a.ventia.localhost', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('PATCH /v1/storefront/checkout/:orderNumber/provider-ref-hint — cross-tenant isolation', () => {
  it('the SAME order number on two tenants: writing on tenant A never touches tenant B\'s order', async () => {
    const orderA = await seedOrder(tenantAId, 500);
    const orderB = await seedOrder(tenantBId, 500); // colliding number on purpose

    const res = await patchHint(500, 'hint-a.ventia.localhost', { providerRef: 'a-only' });
    expect(res.status).toBe(200);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } })).providerRef).toBe('a-only');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderB.id } })).providerRef).toBeNull();
  });

  it("a tenant that doesn't have the order 404s rather than reaching across tenants", async () => {
    await seedOrder(tenantAId, 501);

    const res = await patchHint(501, 'hint-b.ventia.localhost', { providerRef: 'should-not-land' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ORDER_NOT_FOUND');
  });
});
