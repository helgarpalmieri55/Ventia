/** Structural (duck-typed) counterpart to a zod `ZodError` — deliberately
 * avoids importing zod's own types by name: apps/admin doesn't depend on
 * `zod` directly (only transitively, through `@ventia/core`'s built
 * `dist/*.d.ts`, which resolves `zod` from *that* package's own
 * node_modules under pnpm's non-hoisted layout — a bare `import type {
 * ZodError } from 'zod'` here would fail to resolve from this package's
 * own node_modules). Both a real `ZodError` and this structural type expose
 * `.flatten()` with the same shape, so passing a real one through just
 * works via structural typing. */
interface FlattenableError {
  flatten: () => { fieldErrors: Record<string, string[] | undefined> };
}

/** Client-side counterpart to `lib/errors.ts`'s `fieldErrors`: extracts a
 * `{ field: message }` map from a failed `schema.safeParse(...)` call's
 * `.error`, using the same first-message-per-field convention. Like
 * `fieldErrors`, this surfaces zod's own message text as-is (no translation
 * layer over zod's built-in English messages) — consistent with how the
 * server's VALIDATION_FAILED responses are already surfaced verbatim
 * through `fieldErrors` elsewhere in this app. For a nested field (e.g.
 * `seo.title`), zod's `.flatten()` keys the error by only the first path
 * segment (`seo`), not the full dotted path — callers should account for
 * that when wiring up per-field error display. */
export function zodIssuesToFieldErrors(error: FlattenableError): Record<string, string> {
  const flat = error.flatten();
  const result: Record<string, string> = {};
  for (const [field, messages] of Object.entries(flat.fieldErrors)) {
    if (Array.isArray(messages) && typeof messages[0] === 'string') {
      result[field] = messages[0];
    }
  }
  return result;
}
