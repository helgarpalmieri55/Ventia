import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, platformDb, tenantDb, type CartSource, type OrderStatus, type PaymentStatus } from '@ventia/db';
import { ACTION_TARGET_STATUS, ALLOWED_ACTIONS, type OrderAction } from './transitions';

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

function toOrderDetail(order: OrderWithDetail): OrderDetail {
  return order;
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
 */
async function adjustStockLine(
  tx: Prisma.TransactionClient,
  tenantId: string,
  item: StockAdjustableItem,
  delta: number,
  reason: 'order_confirmed' | 'order_cancelled',
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

@Injectable()
export class OrdersService {
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
    return toOrderDetail(order);
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
    const detail = await platformDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      const order = await tx.order.findFirst({ where: { id: orderId, tenantId }, include: { items: true } });
      if (!order) throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);

      if (!ALLOWED_ACTIONS[order.status].includes(action)) {
        throw new HttpException({ error: 'INVALID_TRANSITION', details: { from: order.status, action } }, 409);
      }

      if (action === 'confirm') {
        // Decrement each line's stock by exactly its ordered qty. Any
        // line's floor check failing throws STOCK_BELOW_ZERO, which aborts
        // this whole $transaction callback — Prisma rolls back every
        // earlier line's already-applied decrement in this same loop, so a
        // partial decrement across lines can never be observed.
        for (const item of order.items) {
          await adjustStockLine(tx, tenantId, item, -item.qty, 'order_confirmed', orderId, actorUserId);
        }
      }

      if (action === 'cancel' && RESTOCKABLE_STATUSES.has(order.status)) {
        // Stock was decremented at some earlier point (order.status is
        // CONFIRMED/PREPARING/SHIPPED, never PENDING here) — restock every
        // line. No floor check is meaningfully at risk for a positive delta;
        // adjustStockLine's shared shape is used anyway for consistency.
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
      await tx.order.update({ where: { id: orderId }, data: { status: targetStatus } });

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
      return toOrderDetail(updated!);
    });

    // Task 2 wires in the shopper-facing emails here, AFTER this transaction
    // has committed (fire-and-forget, `.catch(console.error)`, same
    // post-commit pattern as checkout.service.ts's sendOrderEmails call):
    // confirm/shipped/delivered each send a matching sendOrder*Email;
    // preparing/cancel send nothing (no spec-required template for either).
    // Not implemented in this task — out of scope per the brief.

    return detail;
  }
}
