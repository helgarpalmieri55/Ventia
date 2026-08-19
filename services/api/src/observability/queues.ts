/**
 * The queues this platform runs, as an explicit registry.
 *
 * BullMQ has no "list every queue" primitive that is safe to trust — the only
 * way to enumerate is to scan Redis for `bull:*:meta` keys, which reports
 * queues that no longer exist, misses queues that have never had a job (i.e.
 * exactly the broken state an operator is looking for: "the sweep never
 * registered"), and would happily surface keys written by anything else
 * sharing the Redis instance. A hand-maintained list is dull and correct.
 *
 * Each name is a copy of the `QUEUE_NAME` constant in the worker file named
 * in `source`. Those constants are module-private and the worker files belong
 * to other modules, so this is a genuine duplication — and
 * `test/observability-queues.test.ts` reads each worker's source and asserts
 * the literals still match, so the copy cannot drift silently.
 */
export interface ManagedQueue {
  /** BullMQ queue name — must equal the worker's own `QUEUE_NAME`. */
  readonly name: string;
  /** Worker source file, relative to `services/api`. */
  readonly source: string;
  /** What a failure here means for the business, in one line: an operator
   * reading an alert at 2am should not have to open the source to find out
   * whether this is urgent. */
  readonly meaning: string;
}

export const MANAGED_QUEUES: readonly ManagedQueue[] = [
  {
    name: 'stock-reservation-expiry',
    source: 'src/payments/stock-reservation.worker.ts',
    meaning: 'Releases stock held by unpaid checkouts. Stalled ⇒ sellable inventory stays locked.',
  },
  {
    name: 'payment-reconciliation',
    source: 'src/payments/reconciliation.worker.ts',
    meaning: 'Re-checks payments whose webhook never arrived. Stalled ⇒ paid orders stay PENDING.',
  },
  {
    name: 'conversation-retention',
    source: 'src/agent/conversation-retention.worker.ts',
    meaning: 'Ley 1581 purge of old conversations. Stalled ⇒ personal data kept past its retention window.',
  },
  {
    name: 'subscription-sweep',
    source: 'src/platform/subscription-sweep.worker.ts',
    meaning: 'Auto-suspends unpaid tenants and sends warning emails. Stalled ⇒ unpaid stores stay live.',
  },
];
