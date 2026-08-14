import type { OrderStatus, PaymentStatus } from '@ventia/db';

export type OrderAction = 'confirm' | 'preparing' | 'shipped' | 'delivered' | 'cancel';

/** The status each action moves an order TO, once `ALLOWED_ACTIONS` confirms
 * the action is valid from the order's current status. */
export const ACTION_TARGET_STATUS: Record<OrderAction, OrderStatus> = {
  confirm: 'CONFIRMED',
  preparing: 'PREPARING',
  shipped: 'SHIPPED',
  delivered: 'DELIVERED',
  cancel: 'CANCELLED',
};

// Every key is a FROM status; its value is the set of actions valid from
// there. The natural reading of the spec's linear happy path (PENDING ->
// CONFIRMED -> PREPARING -> SHIPPED -> DELIVERED) plus `cancel` reachable
// from every non-terminal status (spec doesn't scope cancellation to
// only-after-confirm — a PENDING order can still be cancelled, it just has
// no stock to restock, see orders.service.ts's transition()). DELIVERED and
// CANCELLED are terminal: no action is valid from either.
export const ALLOWED_ACTIONS: Record<OrderStatus, OrderAction[]> = {
  PENDING: ['confirm', 'cancel'],
  CONFIRMED: ['preparing', 'cancel'],
  PREPARING: ['shipped', 'cancel'],
  SHIPPED: ['delivered', 'cancel'],
  DELIVERED: [],
  CANCELLED: [],
};

/** The payment-side facts `isBlockedByPendingOnlinePayment` needs — narrower
 * than a full `Order` so callers (and tests) don't have to build one. */
export interface PaymentGateFields {
  paymentStatus: PaymentStatus;
  paymentProvider: string | null;
}

/**
 * A SECOND gate, on top of `ALLOWED_ACTIONS`: `confirm` is scoped to
 * cash-on-delivery orders, and this is what enforces it (P3 wave-2 FIX 2).
 *
 * `docs/SPEC.md` scopes the merchant's manual "Confirmar pedido" to COD, but
 * nothing in code did — `ALLOWED_ACTIONS` allows `confirm` from `PENDING`
 * with no payment-side condition at all, and `transition()` then decrements
 * stock unconditionally. On an online-payment order that stock was ALREADY
 * decremented at checkout time (`checkout.service.ts`'s reservation, see
 * `adjustStockLine`'s `'order_reserved'` reason), so pressing the button was
 * reproduced live doing real damage:
 *
 * ```
 * qty-3 order, stock reserved at checkout → 97
 * after confirm  → stock 94 (DOUBLE decrement), order CONFIRMED/PENDING,
 *                  stockReservedUntil still set
 * every 2-min reconciliation sweep thereafter: 1 gateway call, 1 settle
 *                  attempt, stock stays 94 — forever
 * expireReservations() → 0 (it filters status:'PENDING', so the reservation
 *                  is never released either)
 * ```
 *
 * The condition is `paymentStatus === 'PENDING' && paymentProvider != null`,
 * i.e. exactly "an online-payment order whose payment hasn't resolved yet":
 *  - A COD order has `paymentStatus: 'COD'` and a null `paymentProvider`, so
 *    it is unaffected — the merchant's normal flow keeps working.
 *  - A PAID online order is confirmed by `markPaid`, not by this button, and
 *    isn't `PENDING` anyway.
 *  - A FAILED online order is deliberately NOT blocked: its stock is still
 *    reserved, but its payment has resolved (unsuccessfully), and a merchant
 *    who has arranged payment out of band should still be able to proceed
 *    without the double decrement — `transition()`'s `confirm` branch skips
 *    the decrement whenever the order is already holding a reservation.
 */
export function isBlockedByPendingOnlinePayment(action: OrderAction, order: PaymentGateFields): boolean {
  return action === 'confirm' && order.paymentStatus === 'PENDING' && order.paymentProvider !== null;
}
