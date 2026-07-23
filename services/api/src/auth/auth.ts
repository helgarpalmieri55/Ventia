import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { PrismaClient } from '@ventia/db';

export function createAuth(db: PrismaClient, opts: { secret: string; baseURL: string }) {
  return betterAuth({
    database: prismaAdapter(db, { provider: 'postgresql' }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    basePath: '/v1/auth',
    emailAndPassword: {
      enabled: true,
      // Email verification is wired (sender logs in dev) but not required to sign in in P0.
      // M1 (P1) enforces verification before a store can launch.
      requireEmailVerification: false,
    },
    // Verified against the installed better-auth@1.6.25 sources
    // (dist/context/create-context.mjs, @better-auth/core dist/db/adapter/get-id-field.mjs):
    // `generateId: false` makes the adapter's `id` field default resolve to `undefined`,
    // so the field is omitted from the write and Prisma's `@default(uuid())` generates it.
    advanced: { database: { generateId: false } },
  });
}
