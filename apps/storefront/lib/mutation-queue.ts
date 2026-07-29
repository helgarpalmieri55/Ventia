/** A tiny FIFO queue that runs one async task at a time, in the order
 * `enqueue` was called — used by `cart-context.tsx` to serialize cart
 * mutations (add/update/remove) so two overlapping requests (e.g. a shopper
 * changing a quantity twice before the first PATCH's response arrives) can
 * never have their responses applied out of order. Network timing gives no
 * guarantee two concurrent requests resolve in the order they were sent;
 * queuing removes the race entirely (only one request is ever in flight)
 * rather than picking a "winner" after the fact, which would still leave the
 * wrong value persisted server-side.
 *
 * Pulled out of `cart-context.tsx` as its own pure, DOM-free module so it can
 * be unit-tested directly — this app's vitest config runs under Node, not
 * jsdom, and has no component-rendering test infrastructure, so the
 * serialization behavior itself (not a React hook wrapping it) is what's
 * actually testable here. */
export function createMutationQueue() {
  let tail: Promise<unknown> = Promise.resolve();

  return function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run, run);
    // Swallow here so one failed task doesn't permanently poison the queue
    // for every task enqueued after it — the actual error still propagates
    // to THIS call's own caller via the returned (un-caught) `result`.
    tail = result.catch(() => undefined);
    return result;
  };
}
