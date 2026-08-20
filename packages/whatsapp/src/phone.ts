/**
 * Digits only.
 *
 * Strips Evolution's `@s.whatsapp.net`/`@c.us` JID suffix, a leading `+`, and
 * any spacing or punctuation a provider might include, so the same human is
 * the same `Conversation.shopperRef` no matter which adapter saw them — and so
 * an outbound send never carries a character the provider will reject.
 *
 * A leaf module rather than a helper on `index.ts`: both adapters need it at
 * RUNTIME, and `index.ts` re-exports both adapters, so importing a value from
 * there would be a real ESM cycle (`index` → `cloud` → `index`) that leaves
 * the class undefined at construction time. Type-only imports from `index.ts`
 * are fine and are what the adapters use — same split `@ventia/payments` makes
 * with `http.ts` and `storefront-base.ts`.
 */
export function normalizePhone(raw: string): string {
  return raw.split('@')[0]!.replace(/\D/g, '');
}
