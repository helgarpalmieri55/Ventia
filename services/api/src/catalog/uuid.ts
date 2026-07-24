import { HttpException } from '@nestjs/common';

// Matches Postgres/Prisma's canonical uuid text form (any RFC 4122 version,
// case-insensitive) — deliberately permissive on version/variant nibbles
// since the goal here isn't strict UUID validation, just filtering out
// obviously-malformed path params before they ever reach a query.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guards every `:id`/`:imageId` route param in the catalog controllers.
 *
 * A malformed uuid handed straight to Prisma throws P2023 ("invalid input
 * syntax for type uuid"), which is an unhandled 500 unless every call site
 * catches it. Since a well-formed-but-nonexistent id already 404s (tenantDb's
 * RLS scoping means a real row from another tenant is invisible, and a
 * genuinely absent id has no row), a malformed id gets the SAME typed 404
 * here — this preserves "no existence oracle" (a malformed id doesn't leak
 * any more information than a wrong-but-well-formed one) while replacing a
 * framework-level 500 with the same error shape every other not-found path
 * already returns.
 */
export function assertUuidOr404(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new HttpException({ error: 'NOT_FOUND' }, 404);
  }
}
