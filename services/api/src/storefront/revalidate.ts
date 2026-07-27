/**
 * Fire-and-forget on-demand ISR revalidation. Never awaited by callers and
 * never throws: a storefront that's down (e.g. a dev session that only ran
 * the API) must not slow down or fail an otherwise-successful admin mutation.
 * The page's own `revalidate` + tag config is the fallback if this is missed.
 */
export function revalidateStorefrontTag(tag: string): void {
  const url = process.env.STOREFRONT_INTERNAL_URL ?? 'http://localhost:3000';
  const secret = process.env.REVALIDATE_SECRET ?? 'dev-revalidate-secret';
  fetch(`${url}/api/revalidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag, secret }),
  }).catch((err: unknown) => {
    console.warn('[revalidate] storefront unreachable', err instanceof Error ? err.message : err);
  });
}
