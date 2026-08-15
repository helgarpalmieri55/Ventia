/**
 * Timeout wrapper for every outbound call this package makes to a payment
 * gateway.
 *
 * ## Why this exists
 *
 * `fetch` has no default timeout. Node's undici will wait on a connected but
 * silent socket indefinitely, so a gateway that accepts a connection and then
 * stalls — the classic failure mode of an overloaded API, and one that does
 * NOT produce a connection error — hangs the caller forever. Every caller in
 * this system is somewhere that cannot afford that:
 *
 *  - `createCheckoutSession` runs inside a shopper's checkout request, which
 *    holds an open HTTP connection AND (for the Mercado Pago/ePayco paths) a
 *    checkout transaction that has already decremented stock.
 *  - `getTransactionStatus` runs inside the reconciliation worker's repeatable
 *    job. A hung call there stops the worker processing any further orders,
 *    silently, for as long as the socket stays open — the sweep just stops.
 *  - ePayco's `verifyAndParseWebhook` calls the gateway back mid-verification
 *    (its confirmation signature covers neither the status nor the reference,
 *    so the values are re-read from ePayco's own record). A hang there holds a
 *    webhook request open and, because that request is what settles an order,
 *    delays the settle indefinitely.
 *
 * A bounded failure is strictly better than an unbounded wait in all three:
 * the gateway retries the webhook, the worker sweeps again in two minutes, and
 * the shopper gets an error they can act on instead of a spinner.
 *
 * ## Why the error is rewritten
 *
 * `AbortSignal.timeout()` rejects with a bare `TimeoutError` DOMException
 * whose message is "The operation was aborted" — no URL, no provider, no
 * duration. That is the message an operator would find in the logs of a
 * payment that did not go through, and it says nothing about which gateway
 * failed or why. So the timeout is caught and re-thrown naming the provider,
 * the endpoint and the bound, matching how every other error in this package
 * is phrased (`wompi getTransactionStatus: HTTP 500`).
 *
 * Non-timeout failures (DNS, connection refused, TLS) are re-thrown untouched:
 * they already carry a specific cause, and wrapping them would bury it.
 */

/**
 * One bound for every gateway call, rather than a per-endpoint table.
 *
 * These APIs answer in well under a second in normal operation, so 10s is not
 * a latency budget — it is the point past which "slow" has become "not coming
 * back", and waiting longer only converts one stuck request into two. It also
 * sits comfortably under the timeouts that would otherwise fire around it (a
 * typical 30–60s ingress/proxy read timeout), so THIS bound is the one that
 * trips first and produces the specific error above, instead of a generic 504
 * from something upstream that knows nothing about payments.
 */
export const GATEWAY_TIMEOUT_MS = 10_000;

/**
 * Calls `fetchImpl` with a timeout attached, converting a timeout into an
 * error that names what timed out.
 *
 * `label` is the caller's own method name (`'wompi getTransactionStatus'`),
 * used verbatim so a timeout error reads like every other error that method
 * can throw.
 *
 * An `init.signal` supplied by the caller is respected and composed with the
 * timeout via `AbortSignal.any`, so whichever fires first wins. Nothing passes
 * one today; composing rather than overwriting means a future caller that
 * wants its own cancellation does not silently lose the timeout — or, worse,
 * silently lose its own signal.
 *
 * `timeoutMs` exists so the timeout path can be tested at a real, short
 * duration instead of with a faked clock — `AbortSignal.timeout` schedules on
 * the platform's own timer, which vitest's fake timers do not intercept, so
 * the alternative is a test that genuinely sleeps ten seconds. No caller
 * overrides it; the single bound above is still the policy.
 */
export async function fetchGateway(
  fetchImpl: typeof fetch,
  label: string,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = GATEWAY_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (err) {
    // Identify the timeout by the signal itself, not by the error's name or
    // message: a caller-supplied signal aborting also produces an
    // AbortError/TimeoutError here, and blaming our timeout for someone
    // else's cancellation would send an operator looking for a slow gateway
    // that was never slow.
    if (timeout.aborted) {
      throw new Error(
        `${label}: request to ${redactUrl(url)} timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  }
}

/**
 * Drops the query string before a URL reaches an error message.
 *
 * Gateway URLs in this package carry ids in the PATH, which are useful in an
 * error and not secret. Query strings are where credentials would appear if a
 * future endpoint ever took one (ePayco's older validation endpoints did), and
 * an error message is a thing that gets logged, aggregated and pasted into
 * issues. Keeping the path and dropping the rest costs nothing diagnostically.
 */
function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : `${url.slice(0, queryStart)}?…`;
}
