/** Shape needed to compute display status for a pending staff invite — a
 * subset of `GET /v1/admin/staff`'s `invites[]` entries (see
 * services/api/src/staff/staff.service.ts#listStaff), whose `expiresAt`
 * arrives as an ISO string over JSON but may already be a `Date` for a
 * caller that constructs one directly (e.g. a test). */
export interface InviteExpiry {
  expiresAt: string | Date;
}

export type InviteDisplayStatus = 'pendiente' | 'expirada';

/** Maps a pending invite's `expiresAt` to an es-CO display status for the
 * equipo page's invites table.
 *
 * `GET /v1/admin/staff` already filters to "still redeemable" invites at
 * READ time (`pendingInviteWhere`: acceptedAt/revokedAt null AND
 * expiresAt > now-at-fetch) — every invite this helper ever sees is
 * therefore pending as of the last fetch. But a merchant can leave this page
 * open past that moment, so this is a pure, client-side re-check against
 * `now` that lets a since-expired invite read as "Expirada" without waiting
 * for a refetch. On the exact boundary (`expiresAt === now`) this reads as
 * expired — matching the server's own `expiresAt: { gt: now }` pending
 * check, where equality is NOT "still pending".
 *
 * `now` defaults to `new Date()` for real call sites; tests pin it
 * explicitly to avoid a racy clock. */
export function inviteStatus(invite: InviteExpiry, now: Date = new Date()): InviteDisplayStatus {
  const expiresAt = invite.expiresAt instanceof Date ? invite.expiresAt : new Date(invite.expiresAt);
  return expiresAt.getTime() <= now.getTime() ? 'expirada' : 'pendiente';
}
