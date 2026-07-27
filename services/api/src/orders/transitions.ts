import type { OrderStatus } from '@ventia/db';

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
