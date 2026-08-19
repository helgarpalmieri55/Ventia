import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { ANON_MESSAGE_BODY, ANON_NAME, ANON_PHONE, generateOrderReference } from '@ventia/core';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let prisma: PrismaClientType;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env before the first import of @ventia/db / ../src/main / ./admin-helpers,
  // same pattern as orders-transitions.test.ts.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });
}, 180_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

let orderNumberSeq = 1;

/** One shopper's worth of personal data, unique per test so the
 * whole-database PII scan below cannot be confused by a neighbouring test's
 * fixture. Deliberately free of `%` and `_` — the scan uses ILIKE. */
interface Pii {
  name: string;
  email: string;
  phone: string;
  direccion: string;
  barrio: string;
  complemento: string;
  notas: string;
  documento: string;
  razonSocial: string;
}

let piiSeq = 10_000;

/** `tag` must be alphabetic; the numeric parts are drawn from a counter so
 * phones and documento numbers are digits-only and realistic (the service
 * treats a phone-shaped secret differently from a free string — see
 * `PrivacyService.anonymize`'s secret collection). */
function makePii(tag: string): Pii {
  const n = piiSeq++;
  return {
    name: `Ana ${tag} Gómez`,
    email: `ana.${tag}@correo.co`,
    phone: `300${n}98`,
    direccion: `Carrera 7 # 45-${n}`,
    barrio: `Barrio ${tag}`,
    complemento: `Apto ${n}`,
    notas: `Dejar con el portero ${tag}`,
    documento: `102030${n}`,
    razonSocial: `Ana ${tag} Gómez SAS`,
  };
}

/** Every value that must be gone from the database afterwards. */
function needles(pii: Pii): string[] {
  return [
    pii.name,
    pii.email,
    pii.phone,
    pii.direccion,
    pii.barrio,
    pii.complemento,
    pii.notas,
    pii.documento,
    pii.razonSocial,
  ];
}

/**
 * THE verification that matters: scans EVERY table in the `public` schema by
 * casting each row to its text representation and matching the needle, rather
 * than reading back the same columns the service claims to have written
 * through the same ORM that wrote them. If a PII string survives anywhere —
 * a column nobody thought of, a JSON blob, a table added by another feature —
 * this finds it.
 */
async function scanDatabaseFor(needle: string): Promise<string[]> {
  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const hits: string[] = [];
  for (const { table_name } of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${table_name}" t WHERE t::text ILIKE $1`,
      `%${needle}%`,
    );
    if ((rows[0]?.n ?? 0) > 0) hits.push(`${table_name}(${rows[0]!.n})`);
  }
  return hits;
}

interface Seeded {
  customerId: string;
  orderId: string;
  secondOrderId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  orderEventId: string;
  auditLogId: string;
  webhookEventId: string;
  notificationId: string;
  inventoryMovementId: string;
  paymentId: string;
  reference: string;
  number: number;
}

/**
 * Seeds one customer with everything SPEC §9 says must be cleaned, plus the
 * accounting rows that must NOT be: an InventoryMovement, an AgentUsage row
 * and a Payment ledger entry.
 */
async function seedCustomer(tenantId: string, pii: Pii): Promise<Seeded> {
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      email: pii.email,
      phone: pii.phone,
      name: pii.name,
      ordersCount: 2,
      totalSpentCents: 4_590_000,
    },
  });

  const address = {
    nombreCompleto: pii.name,
    telefono: pii.phone,
    departamentoCode: '05',
    departamentoName: 'Antioquia',
    municipioName: 'Medellín',
    direccion: pii.direccion,
    complemento: pii.complemento,
    barrio: pii.barrio,
    notas: pii.notas,
  };

  const number = orderNumberSeq++;
  const reference = generateOrderReference();
  const order = await prisma.order.create({
    data: {
      tenantId,
      number,
      reference,
      status: 'DELIVERED',
      paymentStatus: 'PAID',
      paymentProvider: 'wompi',
      customerId: customer.id,
      email: pii.email,
      phone: pii.phone,
      shippingAddress: address,
      billingFields: { documento: { tipo: 'CC', numero: pii.documento }, razonSocial: pii.razonSocial },
      shippingMethod: 'flat',
      shippingCents: 900_000,
      subtotalCents: 3_000_000,
      taxCents: 690_000,
      totalCents: 4_590_000,
    },
  });

  const secondOrder = await prisma.order.create({
    data: {
      tenantId,
      number: orderNumberSeq++,
      reference: generateOrderReference(),
      status: 'CANCELLED',
      paymentStatus: 'COD',
      customerId: customer.id,
      email: pii.email,
      phone: pii.phone,
      shippingAddress: address,
      subtotalCents: 1_000_000,
      taxCents: 0,
      totalCents: 1_000_000,
    },
  });

  await prisma.orderItem.create({
    data: {
      tenantId,
      orderId: order.id,
      nameSnapshot: 'Camiseta azul',
      priceCentsSnapshot: 3_000_000,
      qty: 1,
      taxRateSnapshot: 'NINETEEN',
    },
  });

  const orderEvent = await prisma.orderEvent.create({
    data: {
      tenantId,
      orderId: order.id,
      type: 'status_changed',
      actor: 'staff',
      data: { from: 'CONFIRMED', to: 'CANCELLED', reason: `${pii.name} no contesta`, email: pii.email },
    },
  });

  const conversation = await prisma.conversation.create({
    data: { tenantId, channel: 'whatsapp', shopperRef: `57${pii.phone}`, status: 'resolved' },
  });
  const userMessage = await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      role: 'user',
      content: `Hola, soy ${pii.name} y vivo en ${pii.direccion}`,
      inputTokens: 12,
      outputTokens: 0,
    },
  });
  const assistantMessage = await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      role: 'assistant',
      content: `Claro ${pii.name}, enviamos a ${pii.direccion}.`,
      toolCalls: [{ name: 'get_order_status', input: { email: pii.email, phone: pii.phone } }],
      inputTokens: 0,
      outputTokens: 20,
    },
  });

  const notification = await prisma.notificationLog.create({
    data: {
      tenantId,
      channel: 'email',
      template: 'order_confirmed',
      recipient: pii.email,
      idempotencyKey: randomUUID(),
      status: 'sent',
    },
  });

  const auditLog = await prisma.auditLog.create({
    data: {
      tenantId,
      action: 'order.cancel',
      entity: 'Order',
      entityId: order.id,
      data: { status: 'CANCELLED', reason: `${pii.name} pidió cancelar`, email: pii.email },
    },
  });

  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      provider: 'wompi',
      eventId: randomUUID(),
      tenantId,
      orderId: order.id,
      payload: {
        event: 'transaction.updated',
        data: {
          transaction: {
            id: 'txn-abc',
            amount_in_cents: 4_590_000,
            status: 'APPROVED',
            reference,
            customer_email: pii.email,
            customer_data: { full_name: pii.name, phone_number: pii.phone },
          },
        },
      },
    },
  });

  const inventoryMovement = await prisma.inventoryMovement.create({
    data: { tenantId, delta: -1, reason: 'sale', orderId: order.id, actor: 'system' },
  });

  const payment = await prisma.payment.create({
    data: {
      tenantId,
      orderId: order.id,
      provider: 'wompi',
      providerRef: 'txn-abc',
      amountCents: 4_590_000,
      status: 'PAID',
      raw: { source: 'webhook', eventId: 'evt-1' },
    },
  });

  return {
    customerId: customer.id,
    orderId: order.id,
    secondOrderId: secondOrder.id,
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    orderEventId: orderEvent.id,
    auditLogId: auditLog.id,
    webhookEventId: webhookEvent.id,
    notificationId: notification.id,
    inventoryMovementId: inventoryMovement.id,
    paymentId: payment.id,
    reference,
    number,
  };
}

function anonymize(cookie: string, customerId: string, body: unknown = { requestChannel: 'correo', confirm: 'ANONIMIZAR' }) {
  return request(app.getHttpServer())
    .post(`/v1/admin/customers/${customerId}/anonymize`)
    .set('cookie', cookie)
    .send(body as object);
}

describe('POST /v1/admin/customers/:id/anonymize — Ley 1581 supresión (SPEC §9)', () => {
  it('erases every trace of the shopper from the whole database while every amount, date and row survives', async () => {
    const { cookie, tenantId } = await signUpWithTenant('privacy-happy-owner@demo.co', 'owner');
    const pii = makePii('happy');
    const seeded = await seedCustomer(tenantId, pii);

    const orderCountBefore = await prisma.order.count({ where: { tenantId } });
    const itemCountBefore = await prisma.orderItem.count({ where: { tenantId } });
    const eventCountBefore = await prisma.orderEvent.count({ where: { tenantId } });
    const messageCountBefore = await prisma.message.count({ where: { tenantId } });

    const res = await anonymize(cookie, seeded.customerId);
    expect(res.status).toBe(201);
    expect(res.body.alreadyAnonymized).toBe(false);
    expect(res.body.counts).toMatchObject({
      customer: 1,
      orders: 2,
      orderEvents: 1,
      conversations: 1,
      messages: 2,
      notifications: 1,
      auditLogs: 1,
      webhookEvents: 1,
    });

    // ---- the load-bearing assertion: nothing anywhere in Postgres ----
    for (const needle of needles(pii)) {
      const hits = await scanDatabaseFor(needle);
      expect(hits, `PII "${needle}" still present in: ${hits.join(', ')}`).toEqual([]);
    }

    // ---- nothing was deleted ----
    expect(await prisma.order.count({ where: { tenantId } })).toBe(orderCountBefore);
    expect(await prisma.orderItem.count({ where: { tenantId } })).toBe(itemCountBefore);
    expect(await prisma.orderEvent.count({ where: { tenantId } })).toBe(eventCountBefore);
    expect(await prisma.message.count({ where: { tenantId } })).toBe(messageCountBefore);

    // ---- the money and the identifiers are untouched ----
    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.subtotalCents).toBe(3_000_000);
    expect(order.taxCents).toBe(690_000);
    expect(order.shippingCents).toBe(900_000);
    expect(order.totalCents).toBe(4_590_000);
    expect(order.number).toBe(seeded.number);
    expect(order.reference).toBe(seeded.reference);
    expect(order.status).toBe('DELIVERED');
    expect(order.paymentStatus).toBe('PAID');

    // ---- aggregate geography survives; street-level does not ----
    const address = order.shippingAddress as Record<string, unknown>;
    expect(address.departamentoCode).toBe('05');
    expect(address.departamentoName).toBe('Antioquia');
    expect(address.municipioName).toBe('Medellín');
    expect(address.nombreCompleto).toBe(ANON_NAME);
    expect(address.telefono).toBe(ANON_PHONE);
    expect(address.barrio).toBeUndefined();
    expect(address.complemento).toBeUndefined();
    expect(address.notas).toBeUndefined();
    expect(order.billingFields).toBeNull();

    // ---- the customer row keeps its aggregates ----
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: seeded.customerId } });
    expect(customer.name).toBe(ANON_NAME);
    expect(customer.phone).toBe(ANON_PHONE);
    expect(customer.email).toBe(`anon-${seeded.customerId}@anonimizado.invalid`);
    expect(customer.ordersCount).toBe(2);
    expect(customer.totalSpentCents).toBe(4_590_000);

    // ---- conversations: shopperRef gone, the shopper's own words gone ----
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: seeded.conversationId } });
    expect(conversation.shopperRef).toBeNull();
    const userMessage = await prisma.message.findUniqueOrThrow({ where: { id: seeded.userMessageId } });
    expect(userMessage.content).toBe(ANON_MESSAGE_BODY);
    expect(userMessage.inputTokens).toBe(12);
    const assistantMessage = await prisma.message.findUniqueOrThrow({ where: { id: seeded.assistantMessageId } });
    expect(assistantMessage.content).toContain('[dato eliminado]');
    expect(assistantMessage.content).toContain('Claro');

    // ---- the webhook evidence keeps its amounts and status ----
    const webhookEvent = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: seeded.webhookEventId } });
    const payload = webhookEvent.payload as { data: { transaction: Record<string, unknown> } };
    expect(payload.data.transaction.amount_in_cents).toBe(4_590_000);
    expect(payload.data.transaction.status).toBe('APPROVED');
    expect(payload.data.transaction.reference).toBe(seeded.reference);
    expect(payload.data.transaction.customer_email).toBe('[dato eliminado]');

    // ---- accounting rows untouched ----
    const movement = await prisma.inventoryMovement.findUniqueOrThrow({ where: { id: seeded.inventoryMovementId } });
    expect(movement.delta).toBe(-1);
    expect(movement.reason).toBe('sale');
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: seeded.paymentId } });
    expect(payment.amountCents).toBe(4_590_000);
    expect(payment.status).toBe('PAID');
    expect(payment.providerRef).toBe('txn-abc');
  });

  it('records an audit entry that names the customer and the counts but contains none of the erased PII', async () => {
    const { cookie, tenantId } = await signUpWithTenant('privacy-audit-owner@demo.co', 'owner');
    const pii = makePii('audit');
    const seeded = await seedCustomer(tenantId, pii);

    await anonymize(cookie, seeded.customerId, { requestChannel: 'whatsapp', confirm: 'ANONIMIZAR' });

    const audits = await prisma.auditLog.findMany({
      where: { tenantId, action: 'privacy.customer_anonymized' },
    });
    expect(audits.length).toBe(1);
    const audit = audits[0]!;
    expect(audit.entity).toBe('Customer');
    expect(audit.entityId).toBe(seeded.customerId);
    expect(audit.actorUserId).toBeTruthy();

    const data = audit.data as Record<string, unknown>;
    expect(data.requestChannel).toBe('whatsapp');
    expect(data.alreadyAnonymized).toBe(false);
    expect(data.counts).toMatchObject({ customer: 1, orders: 2 });

    // The audit row must not re-create what it just destroyed.
    const serialized = JSON.stringify(audit);
    for (const needle of needles(pii)) {
      expect(serialized).not.toContain(needle);
    }
  });

  it('is idempotent: a second run changes nothing and is not an error', async () => {
    const { cookie, tenantId } = await signUpWithTenant('privacy-idem-owner@demo.co', 'owner');
    const pii = makePii('idem');
    const seeded = await seedCustomer(tenantId, pii);

    const first = await anonymize(cookie, seeded.customerId);
    expect(first.status).toBe(201);
    expect(first.body.alreadyAnonymized).toBe(false);

    const snapshot = async () =>
      JSON.stringify({
        customer: await prisma.customer.findUnique({ where: { id: seeded.customerId } }),
        orders: await prisma.order.findMany({ where: { customerId: seeded.customerId }, orderBy: { number: 'asc' } }),
        events: await prisma.orderEvent.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
        messages: await prisma.message.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
        conversations: await prisma.conversation.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
        webhooks: await prisma.webhookEvent.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
        notifications: await prisma.notificationLog.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
      });

    const before = await snapshot();
    const second = await anonymize(cookie, seeded.customerId);
    expect(second.status).toBe(201);
    expect(second.body.alreadyAnonymized).toBe(true);
    expect(second.body.counts).toEqual({
      customer: 0,
      orders: 0,
      orderEvents: 0,
      conversations: 0,
      messages: 0,
      notifications: 0,
      auditLogs: 0,
      webhookEvents: 0,
    });
    expect(await snapshot()).toBe(before);

    // Both runs are recorded — the second one flagged as a no-op.
    const audits = await prisma.auditLog.findMany({
      where: { tenantId, action: 'privacy.customer_anonymized' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.length).toBe(2);
    expect((audits[1]!.data as Record<string, unknown>).alreadyAnonymized).toBe(true);
  });

  it('cleans an order placed AFTER an earlier anonymization, rather than short-circuiting on a flag', async () => {
    const { cookie, tenantId } = await signUpWithTenant('privacy-again-owner@demo.co', 'owner');
    const pii = makePii('againA');
    const seeded = await seedCustomer(tenantId, pii);
    await anonymize(cookie, seeded.customerId);

    const laterPii = makePii('againB');
    await prisma.order.create({
      data: {
        tenantId,
        number: orderNumberSeq++,
        reference: generateOrderReference(),
        customerId: seeded.customerId,
        email: laterPii.email,
        phone: laterPii.phone,
        shippingAddress: { nombreCompleto: laterPii.name, telefono: laterPii.phone, direccion: laterPii.direccion },
        subtotalCents: 500_000,
        taxCents: 0,
        totalCents: 500_000,
      },
    });

    const res = await anonymize(cookie, seeded.customerId);
    expect(res.status).toBe(201);
    expect(res.body.alreadyAnonymized).toBe(false);
    expect(res.body.counts.orders).toBe(1);
    for (const needle of [laterPii.name, laterPii.email, laterPii.phone, laterPii.direccion]) {
      expect(await scanDatabaseFor(needle)).toEqual([]);
    }
  });
});

describe('tenant scoping and authorization', () => {
  it("404s (never 403) on another tenant's customer and leaves that customer's data completely intact", async () => {
    const { tenantId: tenantA } = await signUpWithTenant('privacy-victim-owner@demo.co', 'owner');
    const { cookie: attackerCookie } = await signUpWithTenant('privacy-attacker-owner@demo.co', 'owner');

    const pii = makePii('crosst');
    const seeded = await seedCustomer(tenantA, pii);

    const res = await anonymize(attackerCookie, seeded.customerId);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'CUSTOMER_NOT_FOUND' });

    // Untouched: the whole point of the check.
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: seeded.customerId } });
    expect(customer.email).toBe(pii.email);
    expect(customer.name).toBe(pii.name);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    expect(order.email).toBe(pii.email);
    expect((order.shippingAddress as Record<string, unknown>).direccion).toBe(pii.direccion);
    const message = await prisma.message.findUniqueOrThrow({ where: { id: seeded.userMessageId } });
    expect(message.content).toContain(pii.name);

    // And no audit row was written against the victim tenant.
    expect(
      await prisma.auditLog.count({ where: { tenantId: tenantA, action: 'privacy.customer_anonymized' } }),
    ).toBe(0);

    // A GET is scoped the same way.
    const get = await request(app.getHttpServer())
      .get(`/v1/admin/customers/${seeded.customerId}`)
      .set('cookie', attackerCookie);
    expect(get.status).toBe(404);
  });

  it('staff may read the customer list but not anonymize (403 FORBIDDEN_ROLE)', async () => {
    const { cookie: ownerCookie, tenantId } = await signUpWithTenant('privacy-roles-owner@demo.co', 'owner');
    const pii = makePii('roles');
    const seeded = await seedCustomer(tenantId, pii);

    const staffUser = await signUpWithTenant('privacy-roles-staffowner@demo.co', 'owner');
    // Move the staff user into the SAME tenant with role staff.
    await prisma.membership.updateMany({
      where: { userId: staffUser.userId },
      data: { tenantId, role: 'staff' },
    });

    const list = await request(app.getHttpServer()).get('/v1/admin/customers').set('cookie', staffUser.cookie);
    expect(list.status).toBe(200);
    expect(list.body.items.some((c: { id: string }) => c.id === seeded.customerId)).toBe(true);

    const forbidden = await anonymize(staffUser.cookie, seeded.customerId);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ error: 'FORBIDDEN_ROLE' });

    // Still intact after the refused attempt.
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: seeded.customerId } });
    expect(customer.email).toBe(pii.email);

    // The owner can.
    expect((await anonymize(ownerCookie, seeded.customerId)).status).toBe(201);
  });

  it('rejects a request without the typed confirmation, and a malformed id 404s', async () => {
    const { cookie, tenantId } = await signUpWithTenant('privacy-validation-owner@demo.co', 'owner');
    const pii = makePii('valid');
    const seeded = await seedCustomer(tenantId, pii);

    const noConfirm = await anonymize(cookie, seeded.customerId, { requestChannel: 'correo' });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error).toBe('VALIDATION_FAILED');

    const badChannel = await anonymize(cookie, seeded.customerId, { requestChannel: 'paloma', confirm: 'ANONIMIZAR' });
    expect(badChannel.status).toBe(400);

    const malformed = await anonymize(cookie, 'not-a-uuid');
    expect(malformed.status).toBe(404);

    // Nothing happened on any of the three.
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: seeded.customerId } });
    expect(customer.email).toBe(pii.email);
  });
});

describe('GET /v1/admin/customers', () => {
  it('lists and searches the tenant\'s own customers only, flagging anonymized ones', async () => {
    const { cookie, tenantId } = await signUpWithTenant('privacy-list-owner@demo.co', 'owner');
    const { tenantId: otherTenant } = await signUpWithTenant('privacy-list-other@demo.co', 'owner');

    const mine = makePii('listme');
    const theirs = makePii('listot');
    const seeded = await seedCustomer(tenantId, mine);
    await seedCustomer(otherTenant, theirs);

    const all = await request(app.getHttpServer()).get('/v1/admin/customers').set('cookie', cookie);
    expect(all.status).toBe(200);
    const ids = all.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(seeded.customerId);
    expect(all.body.items.every((c: { email: string }) => c.email !== theirs.email)).toBe(true);

    const search = await request(app.getHttpServer())
      .get(`/v1/admin/customers?q=${encodeURIComponent(theirs.email)}`)
      .set('cookie', cookie);
    expect(search.status).toBe(200);
    expect(search.body.items).toEqual([]);

    const found = await request(app.getHttpServer())
      .get(`/v1/admin/customers?q=${encodeURIComponent(mine.email)}`)
      .set('cookie', cookie);
    expect(found.body.items.length).toBe(1);
    expect(found.body.items[0].anonymized).toBe(false);

    await anonymize(cookie, seeded.customerId);
    const after = await request(app.getHttpServer()).get('/v1/admin/customers').set('cookie', cookie);
    const row = after.body.items.find((c: { id: string }) => c.id === seeded.customerId);
    expect(row.anonymized).toBe(true);
    expect(row.ordersCount).toBe(2);
  });
});
