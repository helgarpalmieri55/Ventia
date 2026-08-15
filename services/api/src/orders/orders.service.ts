import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Prisma, platformDb, tenantDb, type CartSource, type OrderStatus, type PaymentStatus } from '@ventia/db';
import { ShippingService } from '../checkout/shipping.service';
import { MAILER, type Mailer } from '../mailer/mailer';
import {
  sendOrderConfirmedEmail,
  sendOrderDeliveredEmail,
  sendOrderShippedEmail,
} from '../mailer/order-emails';
import {
  ACTION_TARGET_STATUS,
  ALLOWED_ACTIONS,
  isBlockedByPendingOnlinePayment,
  type OrderAction,
} from './transitions';

export interface ShippedPayload {
  carrier: string;
  trackingNumber: string;
}

export interface CancelPayload {
  reason: string;
}

export interface OrderItemDTO {
  id: string;
  tenantId: string;
  orderId: string;
  productId: string | null;
  variantId: string | null;
  nameSnapshot: string;
  priceCentsSnapshot: number;
  qty: number;
  taxRateSnapshot: string;
}

export interface OrderEventDTO {
  id: string;
  tenantId: string;
  orderId: string;
  type: string;
  actor: string;
  data: Prisma.JsonValue | null;
  createdAt: Date;
}

// Explicit, hand-written DTO (rather than an inferred Prisma payload type) —
// same reasoning as products.service.ts's ProductDTO doc comment: tsc
// otherwise needs to reference the generated Prisma client's private runtime
// types to name these methods' return types (TS2742).
export interface OrderDTO {
  id: string;
  tenantId: string;
  number: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentProvider: string | null;
  customerId: string | null;
  email: string;
  phone: string;
  shippingAddress: Prisma.JsonValue;
  billingFields: Prisma.JsonValue | null;
  shippingMethod: string | null;
  shippingCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  source: CartSource;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderDetail extends OrderDTO {
  items: OrderItemDTO[];
  events: OrderEventDTO[];
  // The tenant's CURRENT label for `shippingMethod` (an opaque id — see
  // ShippingService.findMethodLabel's doc comment), resolved fresh on every
  // read rather than snapshotted at checkout time: unlike OrderItem's price/
  // tax snapshot (which must stay frozen at the value the shopper actually
  // paid), a shipping method's label is cosmetic display text, and showing
  // the merchant's current name for it is more useful than a frozen one —
  // `null` when the id no longer matches any configured method (deleted
  // since the order was placed), so the admin UI can render a graceful
  // fallback instead of a raw, meaningless id. Only populated on `OrderDetail`
  // (findOne/transition), not on the plain `OrderDTO` list rows, since the
  // admin orders list doesn't display it and resolving it per-row would be
  // an unnecessary extra read per list item.
  shippingMethodLabel: string | null;
}

export interface OrderListQuery {
  status?: string;
  page?: string;
  pageSize?: string;
}

export interface OrderListResult {
  items: OrderDTO[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const ORDER_STATUSES = new Set<OrderStatus>([
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
]);

function isOrderStatus(value: string | undefined): value is OrderStatus {
  return typeof value === 'string' && ORDER_STATUSES.has(value as OrderStatus);
}

const ORDER_DETAIL_INCLUDE = {
  items: true,
  events: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.OrderInclude;

type OrderWithDetail = Prisma.OrderGetPayload<{ include: typeof ORDER_DETAIL_INCLUDE }>;

function toOrderDetail(order: OrderWithDetail, shippingMethodLabel: string | null): OrderDetail {
  return { ...order, shippingMethodLabel };
}

// Restockable subset of OrderStatus: stock was decremented on `confirm`
// (PENDING -> CONFIRMED), so cancelling from any of these three later states
// has something to give back. Cancelling straight from PENDING never
// decremented anything, so it skips the restock step entirely (see
// transition()'s `cancel` branch below).
const RESTOCKABLE_STATUSES = new Set<OrderStatus>(['CONFIRMED', 'PREPARING', 'SHIPPED']);

/** One `OrderItem`'s worth of the fields adjustStockLine needs — narrower
 * than the full Prisma OrderItem so call sites don't need to load more than
 * this. */
interface StockAdjustableItem {
  productId: string | null;
  variantId: string | null;
  qty: number;
}

/**
 * Atomically adjusts one order line's Product/ProductVariant stock and
 * writes the matching InventoryMovement row, copying stock.controller.ts's
 * exact `UPDATE ... SET stock = stock + delta WHERE ... AND stock + delta >=
 * 0 RETURNING stock` shape (see that file's doc comment for why the floor
 * check must be one atomic statement rather than a read-then-write: two
 * concurrent adjustments each individually validated against a stale read
 * can otherwise race into a lost update, whereas Postgres's row-level
 * locking makes a single conditional UPDATE atomic regardless of isolation
 * level).
 *
 * Called from inside transition()'s platformDb.$transaction, so a thrown
 * STOCK_BELOW_ZERO here rolls back every earlier line's already-applied
 * decrement in the same loop automatically — no hand-rolled compensation
 * needed.
 *
 * Exported (was module-private) for Task 5's checkout.service.ts `wompi`
 * branch, which reuses this exact atomic primitive to reserve stock at
 * checkout time (P3a design decision 2: an online-payment order actually
 * decrements stock immediately, using the new `'order_reserved'`
 * InventoryMovement reason below, rather than a separate reservation
 * ledger).
 *
 * `'order_expired'` (Task 6) is a fourth, distinct reason: a restock caused
 * by `stock-reservation.worker.ts`'s automatic TTL sweep, not by this
 * method's own `cancel` branch (which keeps writing `'order_cancelled'`,
 * even for the widened reserved-PENDING case below) — the InventoryMovement
 * audit trail should distinguish "a merchant/shopper cancelled this order"
 * from "nobody ever paid and the 15-minute hold lapsed automatically",
 * since they're different real-world events even though both restock the
 * same way.
 */
export async function adjustStockLine(
  tx: Prisma.TransactionClient,
  tenantId: string,
  item: StockAdjustableItem,
  delta: number,
  reason: 'order_confirmed' | 'order_cancelled' | 'order_reserved' | 'order_expired',
  orderId: string,
  actorUserId: string,
): Promise<void> {
  // OrderItem.productId is nullable in the schema, but every line
  // CheckoutService writes always carries the productId its own stock read
  // was checked against (checkout.service.ts's CheckoutLine never omits it)
  // — a null here means a corrupt row from outside that code path, treated
  // as a hard failure rather than silently skipping the stock movement.
  const productId = item.productId;
  if (!productId) {
    throw new HttpException({ error: 'ORDER_ITEM_MISSING_PRODUCT' }, 500);
  }
  const variantId = item.variantId;

  // ProductVariant has no `trackInventory` flag of its own (schema.prisma) —
  // same "always defers to the parent product's flag" rule
  // checkout.service.ts's own stock check already documents. A merchant who
  // turned inventory tracking off has no reason to ever touch this product's
  // `stock` column away from its schema default (0), so gating this
  // decrement/restock on the SAME flag checkout.service.ts already gates its
  // own INSUFFICIENT_STOCK check on (`if (product.trackInventory && stock <
  // item.qty)`) is required for consistency — without it, confirming ANY
  // order for an untracked-inventory product at its default stock=0 hit a
  // false-positive STOCK_BELOW_ZERO here (reproduced empirically in this
  // task's review), permanently blocking that order from ever being
  // confirmed. No InventoryMovement is written either in this branch: there
  // is no real stock change to audit when inventory isn't tracked.
  const product = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: { trackInventory: true },
  });
  if (!product?.trackInventory) {
    return;
  }

  const rows = variantId
    ? await tx.$queryRaw<{ stock: number }[]>`
        UPDATE "ProductVariant" SET stock = stock + ${delta}
        WHERE id = ${variantId}::uuid AND "tenantId" = ${tenantId}::uuid
          AND stock + ${delta} >= 0
        RETURNING stock`
    : await tx.$queryRaw<{ stock: number }[]>`
        UPDATE "Product" SET stock = stock + ${delta}
        WHERE id = ${productId}::uuid AND "tenantId" = ${tenantId}::uuid
          AND stock + ${delta} >= 0
        RETURNING stock`;

  // A restock (positive delta) can never fail this floor check; it only
  // ever bites the confirm-time decrement (negative delta) — the shared
  // shape is kept for both call sites purely for consistency with
  // stock.controller.ts's pattern.
  if (rows.length === 0) {
    throw new HttpException({ error: 'STOCK_BELOW_ZERO', details: { productId } }, 422);
  }

  await tx.inventoryMovement.create({
    data: { tenantId, productId, variantId, delta, reason, orderId, actor: actorUserId },
  });
}

// Everything transition()'s post-commit email step needs, on top of the
// public OrderDetail — computed once inside the transaction (the tenant name
// read below is the only extra field, mirroring checkout.service.ts's
// CheckoutTransactionResult/CheckoutResult split) rather than re-queried
// after commit. The actual method return type stays exactly `OrderDetail` —
// `tenantName` never leaks into it.
interface TransitionTransactionResult extends OrderDetail {
  tenantName: string;
}

@Injectable()
export class OrdersService {
  // Explicit @Inject: esbuild (vitest's TS transform) doesn't emit
  // `design:paramtypes` metadata, so Nest's implicit constructor-injection by
  // type alone can't resolve MAILER (a Symbol token, never resolvable by type
  // alone in the first place) here — same caution as checkout.service.ts's
  // constructor. ShippingService needs the same explicit @Inject for the
  // identical reason (esbuild drops the metadata implicit injection relies
  // on regardless of the token type).
  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ShippingService) private readonly shippingService: ShippingService,
  ) {}

  async list(tenantId: string, query: OrderListQuery): Promise<OrderListResult> {
    const db = tenantDb(tenantId);

    // Mirrors ProductsService.list()'s exact pagination clamping (see
    // products.service.ts): page < 1 clamps to 1, pageSize is clamped into
    // [1, MAX_PAGE_SIZE], and a non-numeric page/pageSize falls back to the
    // defaults rather than rejecting the request.
    const page = Math.max(1, Math.trunc(Number(query.page)) || 1);
    const rawPageSize = Math.trunc(Number(query.pageSize));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawPageSize || DEFAULT_PAGE_SIZE));

    const where: Prisma.OrderWhereInput = {};
    // An invalid/garbage status value is silently ignored (falls back to no
    // filter), matching ProductsService.list()'s established behavior for
    // its own `status` query param (see products.service.ts: only the three
    // real ProductStatus values are ever assigned into `where.status`, any
    // other string is a no-op rather than a 400).
    if (isOrderStatus(query.status)) {
      where.status = query.status;
    }

    const [items, total] = await Promise.all([
      db.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.order.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  async findOne(tenantId: string, orderId: string): Promise<OrderDetail> {
    const order = await tenantDb(tenantId).order.findFirst({
      where: { id: orderId },
      include: ORDER_DETAIL_INCLUDE,
    });
    if (!order) throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);
    const shippingMethodLabel = order.shippingMethod
      ? await this.shippingService.findMethodLabel(tenantId, order.shippingMethod)
      : null;
    return toOrderDetail(order, shippingMethodLabel);
  }

  /**
   * The single entry point for confirm/preparing/shipped/delivered/cancel,
   * all funneled through the `ALLOWED_ACTIONS` state machine (transitions.ts).
   *
   * Runs inside one manual-RLS `platformDb.$transaction` — mirroring
   * checkout.service.ts's and stock.controller.ts's existing pattern (`SET
   * LOCAL ROLE ventia_app` + `set_config('app.tenant_id', ...)` once, every
   * read/write on `tx` with explicit tenantId) — because this method spans
   * multiple tenant-scoped writes (Order, OrderItem-driven stock adjustments,
   * InventoryMovement, Shipment, OrderEvent) that must all commit or roll
   * back together; tenantDb's Prisma extension opens a fresh transaction per
   * call, so it can't span all of these atomically on its own.
   */
  async transition(
    tenantId: string,
    orderId: string,
    action: OrderAction,
    payload: ShippedPayload | CancelPayload | undefined,
    actorUserId: string,
  ): Promise<OrderDetail> {
    const result = await platformDb.$transaction(async (tx): Promise<TransitionTransactionResult> => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      // Serializes every transition on this SAME order — mirrors
      // order-number.ts's advisory lock (there keyed on tenantId, here on
      // orderId), for the identical reason: the order read right below is a
      // plain SELECT under Postgres's default READ COMMITTED, so without
      // this lock, two concurrent transitions on the same order (e.g. two
      // admin tabs both clicking "cancel", or a double-click before the
      // first response lands) can both read the same pre-mutation status,
      // both pass the ALLOWED_ACTIONS check below, and both commit their own
      // branch — reproduced empirically in this task's review as a genuine
      // double-restock (two concurrent cancels from CONFIRMED) and a worse,
      // silent stock-loss bug (confirm racing cancel from PENDING). This
      // lock also closes the identical race in the `shipped` branch's
      // find-then-create-or-update on `Shipment` (no unique constraint on
      // orderId exists to catch a duplicate row otherwise). Held for the
      // remainder of this transaction; the losing concurrent call blocks
      // here until the winner commits, then re-reads the now-updated status
      // and correctly fails ALLOWED_ACTIONS with INVALID_TRANSITION instead
      // of corrupting stock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`;

      const order = await tx.order.findFirst({ where: { id: orderId, tenantId }, include: { items: true } });
      if (!order) throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);

      if (!ALLOWED_ACTIONS[order.status].includes(action)) {
        throw new HttpException({ error: 'INVALID_TRANSITION', details: { from: order.status, action } }, 409);
      }

      // The COD scoping of `confirm` (P3 wave-2 FIX 2) — see
      // `isBlockedByPendingOnlinePayment`'s doc comment for the reproduced
      // damage this prevents. Its own error code rather than a second
      // `INVALID_TRANSITION`: the status transition IS legal here, it's the
      // order's payment state that isn't, and the merchant needs to be told
      // the difference ("this pedido is waiting on its online payment") to
      // act on it. Same 409 + `{error, details}` envelope as its neighbor,
      // and checked INSIDE the advisory lock on freshly-read state, so a
      // webhook confirming payment concurrently can't be raced past it.
      if (isBlockedByPendingOnlinePayment(action, order)) {
        throw new HttpException(
          {
            error: 'ONLINE_PAYMENT_PENDING',
            details: { paymentProvider: order.paymentProvider, paymentStatus: order.paymentStatus },
          },
          409,
        );
      }

      // Stock was already decremented at checkout time for any order still
      // holding a reservation (`stockReservedUntil !== null` is exactly the
      // signal `checkout.service.ts` sets for that — the same one the `cancel`
      // branch below already keys its restock off). Decrementing again here
      // is the double-decrement FIX 2 is about. The guard above stops the one
      // reachable route into this state today; this makes the invariant
      // ("never decrement stock twice for one order") hold structurally,
      // independent of which precondition some future caller checks.
      if (action === 'confirm' && order.stockReservedUntil === null) {
        // Decrement each line's stock by exactly its ordered qty. Any
        // line's floor check failing throws STOCK_BELOW_ZERO, which aborts
        // this whole $transaction callback — Prisma rolls back every
        // earlier line's already-applied decrement in this same loop, so a
        // partial decrement across lines can never be observed.
        for (const item of order.items) {
          await adjustStockLine(tx, tenantId, item, -item.qty, 'order_confirmed', orderId, actorUserId);
        }
      }

      // Widened per P3a design decision 4: a COD order in PENDING never had
      // any stock decremented (RESTOCKABLE_STATUSES alone correctly says
      // "no restock" for it), but an online-payment (`wompi`) order CAN sit
      // in PENDING with real, already-decremented stock — checkout.service.ts's
      // `wompi` branch reserves stock (adjustStockLine(..., -qty,
      // 'order_reserved', ...)) and stamps `stockReservedUntil` at
      // order-creation time (Task 5), before any webhook has confirmed
      // payment. Without this `|| order.stockReservedUntil !== null` clause,
      // a merchant cancelling that reserved PENDING order (e.g. because the
      // shopper asked to cancel before paying) would silently skip the
      // restock — the concrete bug this closes: real stock stays
      // permanently decremented against a CANCELLED order that was never
      // paid for. `stockReservedUntil !== null` is exactly the signal
      // checkout.service.ts already uses to mean "this order actually holds
      // reserved stock" (null for every COD order and for any order past
      // the pending/reserved stage), so it's the correct, minimal condition
      // to add — no new state, no new column.
      if (action === 'cancel' && (RESTOCKABLE_STATUSES.has(order.status) || order.stockReservedUntil !== null)) {
        // Stock was decremented at some earlier point — either by an
        // earlier `confirm` (order.status is CONFIRMED/PREPARING/SHIPPED),
        // or by checkout's own `wompi` reservation (order.status is still
        // PENDING but stockReservedUntil is set) — restock every line
        // either way. This is still a merchant/shopper-initiated CANCEL, not
        // an automatic expiry, so the InventoryMovement reason stays
        // 'order_cancelled' (see 'order_expired'`'s doc comment on
        // adjustStockLine above for why the two are kept distinct). No floor
        // check is meaningfully at risk for a positive delta; adjustStockLine's
        // shared shape is used anyway for consistency.
        for (const item of order.items) {
          await adjustStockLine(tx, tenantId, item, item.qty, 'order_cancelled', orderId, actorUserId);
        }
      }

      if (action === 'shipped') {
        const shippedPayload = payload as ShippedPayload;
        // Shipment has no unique constraint on orderId in the current
        // schema, so this is an explicit find-then-create-or-update rather
        // than a Prisma `upsert({where: {orderId}})`. One Shipment row per
        // order in the normal flow (the state machine only allows `shipped`
        // once, from PREPARING) — the update branch is defensive for a
        // re-ship edge case, not something the happy path exercises.
        const existingShipment = await tx.shipment.findFirst({ where: { orderId, tenantId } });
        if (existingShipment) {
          await tx.shipment.update({
            where: { id: existingShipment.id },
            data: {
              provider: shippedPayload.carrier,
              trackingNumber: shippedPayload.trackingNumber,
              status: 'shipped',
            },
          });
        } else {
          await tx.shipment.create({
            data: {
              tenantId,
              orderId,
              provider: shippedPayload.carrier,
              trackingNumber: shippedPayload.trackingNumber,
              status: 'shipped',
            },
          });
        }
      }

      const targetStatus = ACTION_TARGET_STATUS[action];
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: targetStatus,
          // A cancel must also record that the payment is not coming.
          //
          // Until now `transition()` never wrote `paymentStatus` at all, so a
          // merchant cancelling an unpaid online order left it
          // CANCELLED/PENDING — while the automatic 15-minute expiry of the
          // very same order writes CANCELLED/EXPIRED
          // (stock-reservation.worker.ts). Two representations of one
          // real-world end state: cancelled, no money arrived. The merchant's
          // own order list reads the second of those as "still waiting on
          // payment", on an order they just cancelled.
          //
          // EXPIRED rather than a new enum value, because `paymentStatus`
          // answers only "what happened to the money", and the answer here is
          // identical to the expiry worker's: the window closed and nothing
          // arrived. WHO closed it and WHY is already recorded, distinctly, in
          // two other places — the `OrderEvent` (`'status_changed'` by
          // `'staff'` here vs `'reservation_expired'` by `'system'` there) and
          // the `InventoryMovement` reason (`'order_cancelled'` vs
          // `'order_expired'`). Encoding it a third time in `paymentStatus`
          // would duplicate what those already say and give a reader two
          // fields that could disagree.
          //
          // Narrowed to PENDING/FAILED, which is what makes this safe:
          //  - PAID is never touched. A cancel after payment is a refund
          //    situation, and the money DID arrive — overwriting that would be
          //    the same class of lie `markFailed`'s precondition exists to
          //    prevent (see payments.service.ts).
          //  - COD is never touched. A cash order's payment state is not a
          //    gateway outcome and means nothing about a window closing.
          //  - FAILED IS mapped, matching the expiry worker, which overwrites
          //    it the same way (its sweep filters on `status`/
          //    `stockReservedUntil` only, never on `paymentStatus`). "An
          //    attempt was declined" stays on the record as the OrderEvent
          //    history; the current-state field says where it ended up.
          ...(action === 'cancel' && (order.paymentStatus === 'PENDING' || order.paymentStatus === 'FAILED')
            ? { paymentStatus: 'EXPIRED' as const }
            : {}),
          // P3 wave-2 FIX 2 widened this from `cancel`-only to EVERY action.
          // `stockReservedUntil` means "this order is an unpaid online order
          // still holding a 15-minute stock hold", and that is false the
          // instant the order leaves `PENDING` by ANY route — yet only
          // `cancel` cleared it, so a `confirm` left a CONFIRMED order
          // carrying a live-looking reservation that neither
          // `expireReservations()` (it filters `status: 'PENDING'`) nor
          // anything else could ever release. Clearing it on every action is
          // a no-op for the ones that can't have it set (`preparing`/
          // `shipped`/`delivered` all come from `CONFIRMED`, where it is
          // already null; every COD order has it null throughout), so this
          // adds no new behavior beyond closing that leak.
          stockReservedUntil: null,
          // Original (Task 6) reasoning, still the motivating case: a
          // cancelled reserved-PENDING wompi order's `stockReservedUntil` is
          // functionally inert once `status` is CANCELLED —
          // stock-reservation.worker.ts's own sweep query filters on
          // `status = 'PENDING'` — but a future reader of the Order table (an
          // admin, a support engineer, a later migration/report) should never
          // see a CANCELLED order that still *looks* like it is holding an
          // active 15-minute reservation deadline. Note the happy path for an
          // online order still clears this in `PaymentsService.markPaid`, not
          // here (design decision 3); this method is the merchant-driven path.
        },
      });

      await tx.orderEvent.create({
        data: {
          tenantId,
          orderId,
          type: 'status_changed',
          actor: 'staff',
          data: { from: order.status, to: targetStatus, ...(payload ?? {}) } as Prisma.InputJsonValue,
        },
      });

      // Re-read on `tx` (same transaction, so this reflects everything just
      // written above) rather than assembling by hand — simplest way to
      // guarantee the returned shape matches findOne()'s OrderDetail exactly.
      const updated = await tx.order.findFirst({ where: { id: orderId, tenantId }, include: ORDER_DETAIL_INCLUDE });
      // Cannot be null: this is the same row just updated inside this same
      // transaction, by its own primary key.

      // Only needed for the post-commit email step below — one cheap extra
      // read inside the same transaction (matching checkout.service.ts's
      // identical `tx.tenant.findUniqueOrThrow` precedent) rather than a
      // second round trip after commit.
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });

      // ShippingService.findMethodLabel runs on plain tenantDb (a read of
      // Tenant.settings, independent of this transaction) — calling it from
      // inside our transaction is safe for the identical reason
      // checkout.service.ts's own isCodAllowed/priceFor calls already
      // document: it doesn't need transactional consistency with the writes
      // above and never touches Order/OrderItem/Shipment rows itself. Kept
      // in sync with findOne()'s identical resolution so the admin UI's
      // "re-set state directly from the mutation's own response" pattern
      // (see orders.controller.ts's doc comment) never shows a stale/missing
      // label after an action, only after a fresh GET.
      const shippingMethodLabel = updated!.shippingMethod
        ? await this.shippingService.findMethodLabel(tenantId, updated!.shippingMethod)
        : null;

      return { ...toOrderDetail(updated!, shippingMethodLabel), tenantName: tenant.name };
    });

    const { tenantName, ...detail } = result;

    // Shopper-facing emails, fired here AFTER the transaction above has
    // committed — fire-and-forget (`.catch(console.error)`, never awaited),
    // same post-commit pattern as checkout.service.ts's sendOrderEmails call:
    // confirm/shipped/delivered each send a matching sendOrder*Email;
    // preparing/cancel send nothing (no spec-required template for either).
    // `payload` is still in scope here as the original function parameter —
    // no need to carry it through the transaction's return value.
    if (action === 'confirm') {
      sendOrderConfirmedEmail(this.mailer, { orderNumber: detail.number, email: detail.email, tenantName }).catch(
        (err: unknown) => {
          console.error('[orders] confirmed email failed', err);
        },
      );
    } else if (action === 'shipped') {
      const shippedPayload = payload as ShippedPayload;
      sendOrderShippedEmail(this.mailer, {
        orderNumber: detail.number,
        email: detail.email,
        tenantName,
        carrier: shippedPayload.carrier,
        trackingNumber: shippedPayload.trackingNumber,
      }).catch((err: unknown) => {
        console.error('[orders] shipped email failed', err);
      });
    } else if (action === 'delivered') {
      sendOrderDeliveredEmail(this.mailer, { orderNumber: detail.number, email: detail.email, tenantName }).catch(
        (err: unknown) => {
          console.error('[orders] delivered email failed', err);
        },
      );
    }

    return detail;
  }
}
