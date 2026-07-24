import { HttpException } from '@nestjs/common';

/**
 * Structural stand-in for zod's `ZodSchema<T>` (duck-typed against its
 * `safeParse` method) rather than an `import type ... from 'zod'`. `zod` is
 * @ventia/core's dependency, not this app's — every schema this helper is
 * called with (categoryInputSchema, etc.) is built and owned there. Avoiding
 * a direct `zod` dependency here sidesteps a real pnpm peer-resolution
 * hazard: this workspace has `better-auth`/`better-call` pinned to zod v4
 * as a peer, and adding `zod` as a direct dependency of this package (to
 * satisfy a type-only import) shifted pnpm's resolution of that peer down
 * to zod v3 for this package's dependency graph — a behavioral change to
 * better-auth's own validation, not just a type-checking convenience.
 */
export interface ParsableSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } };
}

/** Parses `body` against `schema`, throwing a 400 HttpException with flattened
 * Zod issues on failure instead of returning a Result type — every catalog
 * controller wants the same "parse or reject the request" behavior. */
export function parseOr400<T>(schema: ParsableSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpException({ error: 'VALIDATION_FAILED', details: result.error.flatten() }, 400);
  }
  return result.data;
}
