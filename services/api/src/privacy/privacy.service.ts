import { HttpException, Injectable } from '@nestjs/common';
import {
  ANON_MESSAGE_BODY,
  ANON_NAME,
  ANON_PHONE,
  anonymizedEmailFor,
  isAnonymizedValue,
  type AnonymizeCustomerInput,
  type CustomerListQuery,
} from '@ventia/core';
import { Prisma, platformDb, tenantDb } from '@ventia/db';
import { writeAudit } from '../catalog/audit';
import type { AdminSessionContext } from '../admin/roles.decorator';
import { anonymizeAddress, buildRedactor, phoneDigits, type Redactor } from './redact';

export interface CustomerListItem {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  ordersCount: number;
  totalSpentCents: number;
  /** True when this row already holds the sentinels — the admin list renders
   * it as "Anonimizado" and hides the action, and the API still accepts a
   * second anonymize call on it (it is a no-op). */
  anonymized: boolean;
}

export interface CustomerListResult {
  items: CustomerListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CustomerOrderSummary {
  id: string;
  number: number;
  status: string;
  paymentStatus: string;
  totalCents: number;
  createdAt: Date;
}

export interface CustomerDetail extends CustomerListItem {
  orders: CustomerOrderSummary[];
}

/** Rows rewritten, per table. Every number is rows CHANGED, never rows
 * matched — which is what makes a second run observably a no-op (all zeroes)
 * rather than merely harmless. */
export interface AnonymizeCounts {
  customer: number;
  orders: number;
  orderEvents: number;
  conversations: number;
  messages: number;
  notifications: number;
  auditLogs: number;
  webhookEvents: number;
}

export interface AnonymizeResult {
  customerId: string;
  /** True when the run changed nothing at all. */
  alreadyAnonymized: boolean;
  counts: AnonymizeCounts;
}

const EMPTY_COUNTS: AnonymizeCounts = {
  customer: 0,
  orders: 0,
  orderEvents: 0,
  conversations: 0,
  messages: 0,
  notifications: 0,
  auditLogs: 0,
  webhookEvents: 0,
};

/** Shortest phone fragment used to match a `Conversation.shopperRef`. A
 * Colombian mobile is 10 digits; below 7 the match stops being an identity. */
const MIN_PHONE_MATCH = 7;

/**
 * Serializes a JSON value with object keys sorted, recursively.
 *
 * Plain `JSON.stringify` is not usable for the before/after comparison this
 * service relies on. Postgres stores these columns as `jsonb`, which does NOT
 * preserve insertion order — it re-orders keys by length then bytes. So a
 * value read back is almost never in the order it was written, and any
 * comparison against a freshly-built object (`anonymizeAddress`'s output, in
 * particular) reports a difference on every run even when the stored jsonb is
 * byte-identical. That is not a cosmetic problem: it would make the flow
 * rewrite the same rows forever and report non-zero counts on every re-run,
 * i.e. destroy the idempotency this whole design turns on. Found by the
 * idempotency test, not by reading.
 */
function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) out[key] = walk(src[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** Two JSON values differ iff their key-order-independent serialization
 * differs — see {@link canonicalJson}. */
function jsonChanged(before: unknown, after: unknown): boolean {
  return canonicalJson(before) !== canonicalJson(after);
}

/** Every non-empty string leaf of a JSON value — how `billingFields`
 * (documento / razón social, no schema in `@ventia/core` yet) contributes its
 * contents to the secret set before being dropped. */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringLeaves(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) stringLeaves(v, out);
  }
  return out;
}

/**
 * SPEC §9, Ley 1581 de 2012 — the *derecho de supresión*.
 *
 * ## Why anonymize instead of delete
 *
 * The data subject's right to erasure and the merchant's obligation to retain
 * transaction records both bind at once. The only reconciliation is to keep
 * every row and every number and destroy every person: totals, subtotals,
 * tax, shipping, currency, dates, status, `number` and `reference` are never
 * touched; `InventoryMovement`, `AgentUsage` and `Payment` (the accounting
 * ledger) are never touched; `Order`/`OrderItem` row counts never change.
 *
 * ## Why one `platformDb.$transaction` and not `tenantDb`
 *
 * `tenantDb(...)`'s Prisma extension wraps EVERY call in its own transaction
 * (see packages/db/src/tenant-client.ts), so it cannot span these eight tables
 * atomically, and calling it from inside an already-open transaction demands a
 * second pool connection while holding the first — the deadlock documented on
 * `ShippingConfig` in checkout/shipping.service.ts. So this method takes the
 * same manual-RLS shape as `OrdersService.transition`: one interactive
 * transaction, `SET LOCAL ROLE ventia_app` + `set_config('app.tenant_id')`
 * once at the top, and an explicit `tenantId` on every single read and write.
 * Nothing in here calls `tenantDb`, and nothing in here reads outside `tx`.
 *
 * Two tables — `AuditLog` and `WebhookEvent` — are REVOKED from `ventia_app`
 * (migration 20260723205801), so the transaction drops back to the owner role
 * with `RESET ROLE` for exactly those two steps, after every tenant-owned
 * table is done. They still carry an explicit `tenantId` predicate; the role
 * change removes the database's backstop, not the scoping.
 *
 * ## Idempotency
 *
 * Every write is "set to a value derived from the row id", and the secret set
 * that drives free-text redaction has the sentinels filtered out of it
 * (`isAnonymizedValue`). A second run therefore computes the identical target
 * state, finds every row already there, and updates nothing — `counts` comes
 * back all zeroes and `alreadyAnonymized` is true. It is not an error, and a
 * customer who has placed a NEW order since the first run gets that order
 * cleaned by the second.
 */
@Injectable()
export class PrivacyService {
  async list(tenantId: string, query: CustomerListQuery): Promise<CustomerListResult> {
    const q = query.q?.trim();
    const where: Prisma.CustomerWhereInput = q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
          ],
        }
      : {};

    const db = tenantDb(tenantId);
    const [rows, total] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: [{ totalSpentCents: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      db.customer.count({ where }),
    ]);

    return {
      items: rows.map(toListItem),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** 404 (never 403) for another tenant's customer id, matching this
   * codebase's no-existence-oracle posture everywhere else — see
   * catalog/uuid.ts's `assertUuidOr404` doc comment. */
  async findOne(tenantId: string, customerId: string): Promise<CustomerDetail> {
    const customer = await tenantDb(tenantId).customer.findFirst({ where: { id: customerId } });
    if (!customer) throw new HttpException({ error: 'CUSTOMER_NOT_FOUND' }, 404);

    const orders = await tenantDb(tenantId).order.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        status: true,
        paymentStatus: true,
        totalCents: true,
        createdAt: true,
      },
    });

    return { ...toListItem(customer), orders };
  }

  async anonymize(
    session: AdminSessionContext,
    customerId: string,
    input: AnonymizeCustomerInput,
  ): Promise<AnonymizeResult> {
    const tenantId = session.tenantId;

    const counts = await platformDb.$transaction(async (tx): Promise<AnonymizeCounts> => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      // Serializes concurrent anonymize calls for the SAME customer — two
      // admin tabs, or a retry racing the original. Without it both runs read
      // the pre-anonymization state, both build the same secret set, and both
      // write; harmless for the typed columns (same target value) but the
      // reported counts would double-count. Same device and same reasoning as
      // OrdersService.transition's per-order lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${customerId}))`;

      const customer = await tx.customer.findFirst({ where: { id: customerId, tenantId } });
      if (!customer) throw new HttpException({ error: 'CUSTOMER_NOT_FOUND' }, 404);

      const orders = await tx.order.findMany({
        where: { tenantId, customerId },
        select: { id: true, email: true, phone: true, shippingAddress: true, billingFields: true },
      });
      const orderIds = orders.map((o) => o.id);

      // ---- secrets ------------------------------------------------------
      // Collected BEFORE anything is rewritten, from the typed columns only,
      // and stripped of sentinels so a second run has an empty set and
      // therefore rewrites no free text. See the class doc on idempotency.
      const rawSecrets: string[] = [customer.email, customer.phone, customer.name].filter(
        (v): v is string => typeof v === 'string',
      );
      for (const order of orders) {
        rawSecrets.push(order.email, order.phone);
        const address = order.shippingAddress;
        if (address && typeof address === 'object' && !Array.isArray(address)) {
          for (const key of ['nombreCompleto', 'telefono', 'direccion', 'complemento', 'barrio', 'notas']) {
            const value = (address as Record<string, unknown>)[key];
            if (typeof value === 'string') rawSecrets.push(value);
          }
        }
        rawSecrets.push(...stringLeaves(order.billingFields));
      }

      const secrets = new Set<string>();
      for (const raw of rawSecrets) {
        const value = raw.trim();
        if (value.length === 0 || isAnonymizedValue(value)) continue;
        secrets.add(value);
        // Phone-shaped secrets also get their digits-only and last-10 forms,
        // because that is how the same human is written in a WhatsApp
        // `shopperRef` (`573001234567`) versus a checkout field
        // (`+57 300 123 4567`).
        const digits = phoneDigits(value);
        if (digits.length >= MIN_PHONE_MATCH && /^[\s+()\-\d]+$/.test(value)) {
          secrets.add(digits);
          if (digits.length > 10) secrets.add(digits.slice(-10));
        }
      }
      const redact = buildRedactor([...secrets]);

      const anonEmail = anonymizedEmailFor(customerId);
      const result: AnonymizeCounts = { ...EMPTY_COUNTS };

      // ---- Customer -----------------------------------------------------
      if (customer.email !== anonEmail || customer.phone !== ANON_PHONE || customer.name !== ANON_NAME) {
        await tx.customer.update({
          where: { id: customerId },
          // `ordersCount` / `totalSpentCents` are untouched: they are the
          // aggregate the merchant's reporting runs on, and they name nobody.
          data: { email: anonEmail, phone: ANON_PHONE, name: ANON_NAME },
        });
        result.customer = 1;
      }

      // ---- Order --------------------------------------------------------
      for (const order of orders) {
        const address = anonymizeAddress(order.shippingAddress);
        const emailChanged = order.email !== anonEmail;
        const phoneChanged = order.phone !== ANON_PHONE;
        const addressChanged = jsonChanged(order.shippingAddress, address);
        // `billingFields` is dropped wholesale rather than redacted: the
        // column exists only to hold documento (CC/NIT/CE) + razón social for
        // DIAN readiness (SPEC §6 M4), i.e. it is identity end to end. There
        // is no accounting figure in it to preserve.
        const billingChanged = order.billingFields !== null;
        if (!emailChanged && !phoneChanged && !addressChanged && !billingChanged) continue;

        await tx.order.update({
          where: { id: order.id },
          data: {
            email: anonEmail,
            phone: ANON_PHONE,
            shippingAddress: address as Prisma.InputJsonValue,
            billingFields: Prisma.DbNull,
          },
        });
        result.orders += 1;
      }

      // ---- OrderEvent ---------------------------------------------------
      result.orderEvents = await redactJsonColumn(
        await tx.orderEvent.findMany({
          where: { tenantId, orderId: { in: orderIds } },
          select: { id: true, data: true },
        }),
        (row) => row.data,
        redact,
        (id, data) => tx.orderEvent.update({ where: { id }, data: { data } }),
      );

      // ---- Conversation / Message ---------------------------------------
      // Conversations carry no `customerId` (they start before anyone is a
      // customer), so they are matched on `shopperRef`: for WhatsApp that IS
      // the shopper's phone in digits-only form, and for the web widget it is
      // whatever identified them, if anything. Best-effort and documented as
      // such — an unidentified web conversation cannot be tied to a person by
      // this service or by anything else.
      const shopperRefMatchers: Prisma.ConversationWhereInput[] = [];
      const phones = [...secrets].map(phoneDigits).filter((d) => d.length >= MIN_PHONE_MATCH);
      for (const digits of new Set(phones)) {
        shopperRefMatchers.push({ shopperRef: { contains: digits.slice(-10) } });
      }
      for (const secret of secrets) shopperRefMatchers.push({ shopperRef: secret });

      const conversations =
        shopperRefMatchers.length === 0
          ? []
          : await tx.conversation.findMany({
              where: { tenantId, OR: shopperRefMatchers },
              select: { id: true, shopperRef: true },
            });

      for (const conversation of conversations) {
        if (conversation.shopperRef === null) continue;
        await tx.conversation.update({ where: { id: conversation.id }, data: { shopperRef: null } });
        result.conversations += 1;
      }

      const conversationIds = conversations.map((c) => c.id);
      if (conversationIds.length > 0) {
        const messages = await tx.message.findMany({
          where: { tenantId, conversationId: { in: conversationIds } },
          select: { id: true, role: true, content: true, toolCalls: true },
        });
        for (const message of messages) {
          // The shopper's own words are replaced wholesale, not scanned. Free
          // prose cannot be pattern-matched for personal data with any
          // honesty — "vivo al lado de la panadería de mi tía" is an address —
          // and SPEC §9 puts agent conversations under the same policy as the
          // rest. Assistant/tool turns are redacted rather than blanked so the
          // merchant keeps a usable record of what their own agent promised.
          const content =
            message.role === 'user' && message.content !== ANON_MESSAGE_BODY
              ? ANON_MESSAGE_BODY
              : (redact(message.content) as string);
          const toolCalls = message.toolCalls === null ? null : redact(message.toolCalls);
          if (content === message.content && !jsonChanged(message.toolCalls, toolCalls)) continue;
          await tx.message.update({
            where: { id: message.id },
            data: {
              content,
              ...(toolCalls === null ? {} : { toolCalls: toolCalls as Prisma.InputJsonValue }),
            },
          });
          result.messages += 1;
        }
      }

      // ---- NotificationLog ----------------------------------------------
      // `recipient` is the raw address a message was sent to. No writer exists
      // yet (SPEC §6 M10 is unbuilt), so this is normally a zero-row update —
      // it is here so the flow does not silently start leaking the day the
      // mailer begins logging.
      const emailRecipients = [...secrets].filter((s) => s.includes('@'));
      const phoneRecipients = [...secrets].filter((s) => !s.includes('@') && phoneDigits(s).length >= MIN_PHONE_MATCH);
      if (emailRecipients.length > 0) {
        const updated = await tx.notificationLog.updateMany({
          where: { tenantId, recipient: { in: emailRecipients } },
          data: { recipient: anonEmail },
        });
        result.notifications += updated.count;
      }
      if (phoneRecipients.length > 0) {
        const updated = await tx.notificationLog.updateMany({
          where: { tenantId, recipient: { in: phoneRecipients } },
          data: { recipient: ANON_PHONE },
        });
        result.notifications += updated.count;
      }

      // ---- owner-role tail ----------------------------------------------
      // `AuditLog` and `WebhookEvent` have every privilege REVOKED from
      // `ventia_app` (migration 20260723205801), so they are unreachable until
      // the role goes back. Everything below still names `tenantId`
      // explicitly. `SET LOCAL ROLE` was transaction-scoped anyway; this just
      // ends it early, inside the same transaction and the same connection.
      await tx.$executeRawUnsafe('RESET ROLE');

      result.auditLogs = await redactJsonColumn(
        await tx.auditLog.findMany({
          where: {
            tenantId,
            OR: [
              { entity: 'Customer', entityId: customerId },
              { entity: 'Order', entityId: { in: orderIds } },
            ],
          },
          select: { id: true, data: true },
        }),
        (row) => row.data,
        redact,
        (id, data) => tx.auditLog.update({ where: { id }, data: { data } }),
      );

      // A gateway's verified payload is deliberately immutable evidence (see
      // the `WebhookEvent` doc comment in schema.prisma) — but Wompi and
      // Mercado Pago both include the payer's e-mail and name in it, and a
      // supresión request does not stop at the tables we find convenient. The
      // redaction is value/key based and structure-preserving, so every
      // amount, status, id and timestamp the evidence exists for survives
      // byte-for-byte. Rows the handler could not resolve to an order
      // (`orderId` null — an unparseable reference, or a pre-migration row)
      // are NOT reachable from a customer and are a known gap.
      result.webhookEvents =
        orderIds.length === 0
          ? 0
          : await redactJsonColumn(
              await tx.webhookEvent.findMany({
                where: { tenantId, orderId: { in: orderIds } },
                select: { id: true, payload: true },
              }),
              (row) => row.payload,
              redact,
              (id, payload) => tx.webhookEvent.update({ where: { id }, data: { payload } }),
            );

      return result;
    });

    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    // Written AFTER the transaction commits and through `platformDb` — the
    // house rule from catalog/audit.ts (audit failures must never roll back a
    // mutation the merchant has been told succeeded) and from
    // orders.controller.ts (never log a mutation that did not happen).
    //
    // Critically: this row is written after the AuditLog redaction pass above,
    // so it cannot be scrubbed by its own run, and it contains NO personal
    // data by construction — ids, integers, an enum, and the operator's user
    // id (which `writeAudit` supplies). That is why `requestChannel` is a
    // closed enum and there is no free-text note field (see
    // packages/core/src/privacy-schemas.ts).
    await writeAudit(session, 'privacy.customer_anonymized', 'Customer', customerId, {
      requestChannel: input.requestChannel,
      alreadyAnonymized: total === 0,
      counts,
    });

    return { customerId, alreadyAnonymized: total === 0, counts };
  }
}

function toListItem(customer: {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  ordersCount: number;
  totalSpentCents: number;
}): CustomerListItem {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    ordersCount: customer.ordersCount,
    totalSpentCents: customer.totalSpentCents,
    anonymized: isAnonymizedValue(customer.email),
  };
}

/**
 * The read-redact-compare-write loop shared by the three free-form JSON
 * columns. Rows whose redacted form serializes identically are skipped
 * entirely, which is what keeps a second run at zero writes.
 */
async function redactJsonColumn<T extends { id: string }>(
  rows: T[],
  read: (row: T) => Prisma.JsonValue | null,
  redact: Redactor,
  write: (id: string, value: Prisma.InputJsonValue) => Promise<unknown>,
): Promise<number> {
  let changed = 0;
  for (const row of rows) {
    const before = read(row);
    if (before === null) continue;
    const after = redact(before);
    if (!jsonChanged(before, after)) continue;
    await write(row.id, after as Prisma.InputJsonValue);
    changed += 1;
  }
  return changed;
}
