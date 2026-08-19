import { createHash, randomBytes } from 'node:crypto';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { platformDb, tenantDb } from '@ventia/db';
import { staffAcceptSchema, staffInviteSchema } from '@ventia/core';
import type { AdminSessionContext } from '../admin/roles.decorator';
import type { SessionContext } from '../auth/session-context';
import { parseOr400 } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';
import { MAILER, type Mailer } from '../mailer/mailer';
import { assertPlanQuota } from '../common/plan-limits';

const INVITE_TOKEN_BYTES = 24; // -> 48 hex characters
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Where clause fragment for "this invite is still redeemable" — same three
 * conditions repeated at every call site that needs "pending" invites
 * (seat-counting, duplicate-invite check, the admin list). */
function pendingInviteWhere(now: Date) {
  return { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } };
}

@Injectable()
export class StaffService {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve MAILER by type alone (same caution
  // as AdminSessionGuard/AuthenticatedGuard's constructors).
  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  async createInvite(session: AdminSessionContext, body: unknown) {
    const input = parseOr400(staffInviteSchema, body);
    const tenantId = session.tenantId;
    const db = tenantDb(tenantId);
    const now = new Date();

    // The seat quota, via the shared enforcement in common/plan-limits.ts —
    // same 402 body as every other plan limit, so the admin UI renders one
    // upgrade prompt. Only the COUNT is staff-specific.
    await assertPlanQuota({
      tenantId,
      quota: 'staffSeats',
      // Membership is NOT in TENANT_MODELS/RLS (packages/db/src/tenant-models.ts)
      // — it has no tenantId-scoped policy at all (ventia_app's privileges on
      // it are explicitly revoked, see the revoke_ventia_app_system_tables
      // migration) — so counting staff members must go through platformDb,
      // filtered by tenantId explicitly. This is a system-context read,
      // justified by the @Roles('owner') guard upstream of this handler.
      //
      // A pending invite occupies a seat exactly like an accepted member: the
      // alternative lets an owner mail out unlimited invites and only discover
      // the limit when the last one to accept is bounced.
      count: async () => {
        const [staffCount, pendingCount] = await Promise.all([
          platformDb.membership.count({ where: { tenantId, role: 'staff' } }),
          db.staffInvite.count({ where: pendingInviteWhere(now) }),
        ]);
        return staffCount + pendingCount;
      },
      // Pre-existing behaviour, preserved deliberately: no `TenantLimits` row
      // means unlimited seats here (pinned by test/staff.test.ts). See the
      // note on `assertPlanQuota` for why it is not flipped in this change.
      whenUnprovisioned: 'allow',
    });

    const existingUser = await platformDb.user.findUnique({ where: { email: input.email } });
    if (existingUser) {
      const membership = await platformDb.membership.findFirst({
        where: { userId: existingUser.id, tenantId },
      });
      if (membership) throw new HttpException({ error: 'ALREADY_MEMBER' }, 409);
    }

    const existingInvite = await db.staffInvite.findFirst({
      where: { email: input.email, ...pendingInviteWhere(now) },
    });
    if (existingInvite) throw new HttpException({ error: 'INVITE_EXISTS' }, 409);

    const raw = randomBytes(INVITE_TOKEN_BYTES).toString('hex');
    const tokenHash = hashToken(raw);
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

    const created = await db.staffInvite.create({
      data: { tenantId, email: input.email, tokenHash, role: 'staff', expiresAt },
    });

    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    // The admin app's client-rendered accept page, NOT the API's own
    // `/v1/staff/accept` endpoint: that endpoint is POST-only (see
    // acceptInvite below), so a browser GET-ing it 404s. `/aceptar-invitacion`
    // reads the token off the query string and issues the real POST itself.
    // Same env var (and same fallback) as admin.module.ts's trustedOrigins.
    const adminUrl = process.env.ADMIN_URL ?? 'http://admin.ventia.localhost';
    await this.mailer.send({
      to: input.email,
      subject: `Invitación a ${tenant.name} — Ventia`,
      text: `Te invitaron a unirte a ${tenant.name} en Ventia como parte del equipo.\n\nAcepta la invitación aquí:\n${adminUrl}/aceptar-invitacion?token=${raw}\n\nEste enlace vence en 7 días.`,
    });

    await writeAudit(session, 'staff.invite', 'StaffInvite', created.id, { email: input.email });

    return { id: created.id, email: created.email, expiresAt: created.expiresAt };
  }

  async listStaff(session: AdminSessionContext) {
    const tenantId = session.tenantId;

    // Membership read via platformDb — same system-context justification as
    // createInvite's seat count above (Membership carries no RLS policy at
    // all; @Roles('owner') on the controller is what makes this safe).
    const memberships = await platformDb.membership.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });

    // User is better-auth's own table and is NOT tenant-scoped (no tenantId
    // column, not in TENANT_MODELS) — a tenantDb(...) call would just reject
    // it as an unscoped model for no benefit, so the join is done directly
    // against platformDb by the id set gathered above. The membership list
    // itself still came from a tenant-filtered query, so this doesn't leak
    // cross-tenant membership rows, only resolves email/name for the ids we
    // already know belong to this tenant.
    const users = await platformDb.user.findMany({ where: { id: { in: memberships.map((m) => m.userId) } } });
    const usersById = new Map(users.map((u) => [u.id, u]));

    const members = memberships.map((m) => {
      const user = usersById.get(m.userId);
      return {
        userId: m.userId,
        email: user?.email ?? '',
        name: user?.name ?? '',
        role: m.role,
        createdAt: m.createdAt,
      };
    });

    const db = tenantDb(tenantId);
    const pending = await db.staffInvite.findMany({
      where: pendingInviteWhere(new Date()),
      orderBy: { createdAt: 'asc' },
    });
    const invites = pending.map((i) => ({ id: i.id, email: i.email, expiresAt: i.expiresAt, createdAt: i.createdAt }));

    return { members, invites };
  }

  async revokeInvite(session: AdminSessionContext, id: string): Promise<void> {
    const db = tenantDb(session.tenantId);
    // findUnique first: RLS scopes it to this tenant, so an id belonging to
    // another tenant resolves to null here (the cross-tenant 404 case) —
    // same backstop pattern as tenant-client.test.ts's "RLS backstop on
    // unscoped-where operations".
    const invite = await db.staffInvite.findUnique({ where: { id } });
    if (!invite) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    await db.staffInvite.update({ where: { id }, data: { revokedAt: new Date() } });
    await writeAudit(session, 'staff.invite_revoke', 'StaffInvite', id);
  }

  async removeStaff(session: AdminSessionContext, userId: string): Promise<void> {
    // System-context read/write via platformDb — same justification as
    // listStaff's membership query (Membership has no RLS policy at all).
    const membership = await platformDb.membership.findFirst({
      where: { userId, tenantId: session.tenantId },
    });
    if (!membership) throw new HttpException({ error: 'NOT_FOUND' }, 404);
    if (membership.role === 'owner') {
      throw new HttpException({ error: 'CANNOT_REMOVE_OWNER' }, 400);
    }

    await platformDb.membership.delete({ where: { id: membership.id } });
    await writeAudit(session, 'staff.remove', 'Membership', membership.id, { userId });
  }

  async acceptInvite(session: SessionContext, body: unknown) {
    const input = parseOr400(staffAcceptSchema, body);
    const tokenHash = hashToken(input.token);

    // We don't know the tenantId yet — that's exactly what this lookup
    // determines — so there is no tenantId to scope a tenantDb(...) call
    // with; this is necessarily a system-context read via platformDb, mirroring
    // onboarding.service.ts#provisionTenant's "tenant creation precedes tenant
    // scope" reasoning for tenant lookup rather than mutation.
    const invite = await platformDb.staffInvite.findUnique({ where: { tokenHash } });
    const now = new Date();
    // Single opaque error for every invalid reason (not found, expired,
    // already accepted, revoked) — deliberately no oracle that would let a
    // caller distinguish "wrong token" from "right token, wrong state".
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= now) {
      throw new HttpException({ error: 'INVITE_INVALID' }, 400);
    }

    const existingMembership = await platformDb.membership.findFirst({ where: { userId: session.userId } });
    if (existingMembership) {
      throw new HttpException({ error: 'ALREADY_HAS_TENANT' }, 409);
    }

    // Email match is deliberately NOT required between the invite's `email`
    // and the accepting session's own email: the 48-hex-char token itself
    // (unguessable, delivered only to the invited address) is the
    // credential. Requiring an exact email match would break the very
    // common case of an invitee signing up with a different address than
    // the one the owner typed in the invite form.
    await platformDb.$transaction([
      platformDb.membership.create({ data: { userId: session.userId, tenantId: invite.tenantId, role: 'staff' } }),
      platformDb.staffInvite.update({ where: { id: invite.id }, data: { acceptedAt: now } }),
    ]);

    await writeAudit(
      { userId: session.userId, email: session.email, tenantId: invite.tenantId, role: 'staff' },
      'staff.accept',
      'Membership',
      invite.tenantId,
      { inviteId: invite.id },
    );

    return { tenantId: invite.tenantId, role: 'staff' as const };
  }
}
