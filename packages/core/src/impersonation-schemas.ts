import { z } from 'zod';

/**
 * Contracts for operator impersonation
 * (docs/superpowers/specs/2026-08-19-impersonation-design.md, SPEC.md §6 M9).
 *
 * The mechanism itself — signing, verification, the cookie — lives in
 * `services/api/src/auth/impersonation.ts`, because it needs `AUTH_SECRET`
 * and node's crypto. What lives HERE is only what both ends of the wire have
 * to agree on: the request body, and the shape the admin shell renders its
 * banner from.
 */

/**
 * The hard ceiling on a grant, in milliseconds. Thirty minutes, per SPEC §6
 * M9's acceptance criterion ("impersonation sessions expire in 30 min").
 *
 * A ceiling, NOT a sliding window: nothing refreshes it, and no request
 * extends it (design §2). Exported so a client can sanity-check its own
 * countdown against the same number the server signed, never so a client can
 * ask for a different one — the value is applied server-side and is not an
 * input to any endpoint.
 */
export const IMPERSONATION_TTL_MS = 30 * 60 * 1000;

/**
 * `POST /v1/platform/tenants/:id/impersonate` body.
 *
 * Optional, and an absent body is fine — the audit row is written either way
 * (design §3), so a `reason` improves the record rather than gating it. This
 * matches `reactivateTenantSchema`'s posture rather than
 * `suspendTenantSchema`'s required reason: suspension takes a merchant
 * offline and must be explained; entering a store to look at it is already
 * fully described by "who, which store, when", which the audit row carries
 * without any help from the operator.
 */
export const impersonateTenantSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export type ImpersonateTenantInput = z.infer<typeof impersonateTenantSchema>;

/**
 * What the server reports about an in-flight impersonation — on
 * `POST .../impersonate`, and (the one that matters) on `GET /v1/admin/me`.
 *
 * Design §5: the banner's source of truth is the server. The admin shell must
 * render its banner from THIS object as returned by `/v1/admin/me`, never
 * from a client-side flag, a route param, or the presence of a cookie it
 * cannot read anyway (the grant cookie is HttpOnly).
 *
 * `expiresAt` is an ISO-8601 instant rather than a remaining-seconds number:
 * a duration computed server-side goes stale the moment it is serialized,
 * and the countdown in the banner has to tick anyway.
 */
export interface ImpersonationContext {
  /** The Ventia operator acting. NOT a merchant user — this is the id every
   * audit row written during the impersonation carries. */
  operatorId: string;
  /** The operator's allowlisted address, so the banner can name a person
   * rather than a uuid. */
  operatorEmail: string;
  /** The tenant being acted inside. */
  tenantId: string;
  /** Display name of that tenant, so the banner can say WHICH store without a
   * second round trip. */
  tenantName: string;
  /** ISO-8601. Hard deadline; never extended. */
  expiresAt: string;
}
