import type { PrismaClient } from '@ventia/db';
import type { createAuth } from './auth';

export interface SessionContext {
  userId: string;
  email: string;
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
  const membership = await db.membership.findFirst({ where: { userId: session.user.id } });
  return {
    userId: session.user.id,
    email: session.user.email,
    tenantId: membership?.tenantId ?? null,
    role: membership?.role ?? null,
  };
}
