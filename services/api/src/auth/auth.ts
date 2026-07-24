import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { PrismaClient } from '@ventia/db';
import { ConsoleMailer, type Mailer } from '../mailer/mailer';

export function createAuth(db: PrismaClient, opts: { secret: string; baseURL: string; mailer?: Mailer }) {
  // Defaults to ConsoleMailer so callers that don't care about verification
  // email delivery (test/auth.ts, test/admin-helpers.ts — separate auth
  // instances built for fixture setup, not the app's own DI-wired one) still
  // get a working sender rather than a required constructor argument. The
  // real app instance (services/api/src/admin/admin.module.ts's AUTH_INSTANCE
  // factory) passes the DI-resolved MAILER through here instead.
  const mailer = opts.mailer ?? new ConsoleMailer();

  return betterAuth({
    database: prismaAdapter(db, { provider: 'postgresql' }),
    secret: opts.secret,
    baseURL: opts.baseURL,
    basePath: '/v1/auth',
    emailAndPassword: {
      enabled: true,
      // Email verification is wired (sender below) but not required to sign
      // in in P0/P1b. M1's launch gate (Task 6) enforces verification before
      // a store can launch instead of gating sign-in itself.
      requireEmailVerification: false,
    },
    // `sendOnSignUp: true` is required alongside `requireEmailVerification:
    // false` — better-auth only sends the verification email automatically
    // on signup when `emailVerification.sendOnSignUp` is true OR
    // `emailAndPassword.requireEmailVerification` is true (see the installed
    // better-auth@1.6.25 sources, dist/api/routes/sign-up.mjs); with
    // requireEmailVerification staying false, sendOnSignUp is the only knob
    // that gets signup to trigger a send at all.
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.send({
          to: user.email,
          subject: 'Verifica tu correo — Ventia',
          text: `Hola,\n\nVerifica tu correo haciendo clic en el siguiente enlace:\n${url}\n\nSi no creaste esta cuenta, ignora este mensaje.`,
        });
      },
    },
    // Verified against the installed better-auth@1.6.25 sources
    // (dist/context/create-context.mjs, @better-auth/core dist/db/adapter/get-id-field.mjs):
    // `generateId: false` makes the adapter's `id` field default resolve to `undefined`,
    // so the field is omitted from the write and Prisma's `@default(uuid())` generates it.
    advanced: { database: { generateId: false } },
  });
}
