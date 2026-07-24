import type { PrismaClient } from '@ventia/db';
import type { createAuth } from './auth';

export interface SessionContext {
  userId: string;
  email: string;
  emailVerified: boolean;
  tenantId: string | null;
  role: 'owner' | 'staff' | 'platform_admin' | null;
}

export async function getSessionContext(
  auth: ReturnType<typeof createAuth>,
  db: PrismaClient,
  headers: Headers,
): Promise<SessionContext | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  // Deterministic selection: a user who ends up with more than one
  // membership (e.g. invited into a second tenant) must always resolve to
  // the SAME tenant across requests. `findFirst` with no `orderBy` returns
  // whatever row order Postgres/Prisma happens to produce — an
  // implementation detail, not a guarantee — so `orderBy: createdAt: 'asc'`
  // pins the choice to the oldest membership every time.
  const membership = await db.membership.findFirst({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'asc' },
  });
  return {
    userId: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
    tenantId: membership?.tenantId ?? null,
    role: membership?.role ?? null,
  };
}
