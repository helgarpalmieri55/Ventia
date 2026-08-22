import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { sweepExpiredShopperCredentials as SweepFn } from '../src/shopper/shopper-session.worker';

/**
 * The sweep that stops credential material accumulating forever.
 *
 * The rows it removes are already inert — `resolveSession` and `consumeToken`
 * both filter on expiry, so nothing here changes what authenticates. What it
 * must NOT do is remove anything still in use, which is the whole risk: a
 * sweep with a wrong comparison signs every shopper out.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let tenantId: string;
let accountId: string;
let sweepExpiredShopperCredentials: typeof SweepFn;
let SPENT_TOKEN_GRACE_MS: number;

const HOUR = 60 * 60_000;

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  // Imported HERE, not at the top of the file: `platformDb` is constructed at
  // module-evaluation time from `process.env.DATABASE_URL`, and the worker
  // module imports `@ventia/db` statically. A static import at the top would
  // therefore build a client against an unset URL before the line above runs —
  // which surfaces as `Environment variable not found: DATABASE_URL` buried
  // under an unrelated testcontainers "Failed to connect to Reaper" message.
  // Same pattern, and the same reason, as every other DB-backed test here.
  ({ platformDb: prisma } = await import('@ventia/db'));
  ({ sweepExpiredShopperCredentials, SPENT_TOKEN_GRACE_MS } = await import(
    '../src/shopper/shopper-session.worker'
  ));

  const tenant = await prisma.tenant.create({
    data: { slug: `sweep-${Date.now().toString(36)}`, name: 'Sweep', status: 'live' },
  });
  tenantId = tenant.id;
  const account = await prisma.shopperAccount.create({
    data: { tenantId, email: 'ana@example.com' },
  });
  accountId = account.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.stop();
});

async function session(tokenHash: string, expiresInMs: number) {
  return prisma.shopperSession.create({
    data: { tenantId, accountId, tokenHash, expiresAt: new Date(Date.now() + expiresInMs) },
  });
}

async function token(tokenHash: string, expiresInMs: number, consumedAgoMs?: number) {
  return prisma.shopperToken.create({
    data: {
      tenantId,
      accountId,
      purpose: 'magic_link',
      tokenHash,
      expiresAt: new Date(Date.now() + expiresInMs),
      consumedAt: consumedAgoMs === undefined ? null : new Date(Date.now() - consumedAgoMs),
    },
  });
}

describe('sweepExpiredShopperCredentials', () => {
  it('removes what is finished and keeps what is live', async () => {
    const live = await session('live-session', HOUR);
    const dead = await session('dead-session', -HOUR);
    const liveToken = await token('live-token', HOUR);
    const expiredToken = await token('expired-token', -HOUR);

    const result = await sweepExpiredShopperCredentials();

    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(result.tokens).toBeGreaterThanOrEqual(1);
    // The property that matters: a signed-in shopper is still signed in.
    expect(await prisma.shopperSession.findUnique({ where: { id: live.id } })).not.toBeNull();
    expect(await prisma.shopperToken.findUnique({ where: { id: liveToken.id } })).not.toBeNull();
    expect(await prisma.shopperSession.findUnique({ where: { id: dead.id } })).toBeNull();
    expect(await prisma.shopperToken.findUnique({ where: { id: expiredToken.id } })).toBeNull();
  });

  it('keeps a just-spent token, so a double-click can be told apart from a bad link', async () => {
    // Deleting on use collapses "ya usaste este enlace" and "enlace inválido"
    // into the same unhelpful answer for someone who clicked twice.
    const justUsed = await token('just-used', HOUR, 60_000);
    const longUsed = await token('long-used', HOUR, SPENT_TOKEN_GRACE_MS + 60_000);

    await sweepExpiredShopperCredentials();

    expect(await prisma.shopperToken.findUnique({ where: { id: justUsed.id } })).not.toBeNull();
    expect(await prisma.shopperToken.findUnique({ where: { id: longUsed.id } })).toBeNull();
  });

  it('is safe to run when there is nothing to do', async () => {
    await sweepExpiredShopperCredentials();
    const result = await sweepExpiredShopperCredentials();
    expect(result).toEqual({ sessions: 0, tokens: 0 });
  });

  it('takes its cutoff from the clock it is given, not from wall time', async () => {
    // The worker passes no argument in production; tests pass one. A sweep
    // that ignored the parameter would be untestable at a boundary, which is
    // exactly where a wrong comparison hides.
    const soon = await session('expires-soon', 30 * 60_000);

    await sweepExpiredShopperCredentials(new Date(Date.now() + HOUR));

    expect(await prisma.shopperSession.findUnique({ where: { id: soon.id } })).toBeNull();
  });
});
