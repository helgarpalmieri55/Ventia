import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/**
 * The identity guaranteed inside every handler behind `PlatformAdminGuard`.
 *
 * Deliberately not shaped like `AdminSessionContext` (see
 * `../admin/roles.decorator.ts`): a Ventia operator has no `tenantId` and no
 * `MembershipRole`, because platform authority in this codebase is not a
 * membership at all — it is an environment allowlist checked against a
 * verified email. See `PlatformAdminGuard`'s doc comment for the reasoning.
 * The two context types must never be made interchangeable; the whole point
 * is that a merchant session can never be widened into this one.
 *
 * There is no `role` field for the same reason: within the platform surface
 * every operator is equal in v1. When that stops being true (read-only
 * support vs. full operator), it belongs here, granted the same way.
 */
export interface PlatformOperatorContext {
  userId: string;
  /** Normalized (trimmed, lowercased) — the same form matched against the
   * allowlist, so audit rows record what was actually compared. */
  email: string;
}

export const PlatformOperator = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().platformOperator as PlatformOperatorContext;
});
