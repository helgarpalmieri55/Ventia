import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** Env var holding the shared secret the OPS application authenticates with. */
export const OPS_TOKEN_ENV = 'OPS_METRICS_TOKEN';

/** Shortest token this guard will accept. A short secret on an unauthenticated
 * internet endpoint is brute-forceable, and the failure is silent — the OPS
 * feed exposes every tenant's cost and health at once, so it is worth refusing
 * to start rather than accepting a weak one. */
export const MIN_TOKEN_LENGTH = 32;

/**
 * Authenticates the **OPS application** — a machine, not a person.
 *
 * ## Why a bearer token and not `PlatformAdminGuard`
 *
 * Every other cross-tenant surface in this codebase (`/v1/platform/*`,
 * `/v1/observability/*`) sits behind `PlatformAdminGuard`, which requires a
 * better-auth session, a verified email, and `User.isPlatformAdmin`. That is
 * exactly right for a human at a console and unusable for a monitoring daemon:
 * it would have to hold a login session, refresh it, and survive password
 * changes — and giving a background poller a human's credentials is how those
 * credentials end up in a config file forever.
 *
 * A dedicated machine credential is the honest shape. It is rotatable on its
 * own, revocable without touching anyone's account, and it grants strictly
 * less: read-only metrics, no mutation route anywhere in this module.
 *
 * ## Fails closed
 *
 * Unset, blank, or shorter than {@link MIN_TOKEN_LENGTH} means NOBODY gets in,
 * including the OPS app — the same direction `PLATFORM_ADMIN_EMAILS` fails.
 * A metrics endpoint that opens up when its secret goes missing is worse than
 * one that goes dark: the outage is visible, the leak is not.
 *
 * ## Constant-time comparison
 *
 * `===` on a secret leaks its prefix through timing. The compare below is
 * length-safe (it hashes nothing, so it pads to equal length first) and uses
 * `timingSafeEqual`, which is the only reason this is a class and not a
 * one-line middleware.
 */
@Injectable()
export class OpsTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const configured = configuredToken();
    if (configured === null) {
      // 503, not 401: nothing the caller can present would work, and the
      // operator reading their OPS app's logs should see "this side is not
      // configured" rather than "your token is wrong".
      throw new HttpException({ error: 'OPS_FEED_NOT_CONFIGURED' }, 503);
    }

    const request = context.switchToHttp().getRequest<Request>();
    const presented = bearerToken(request.header('authorization'));
    if (presented === null || !constantTimeEquals(presented, configured)) {
      throw new HttpException({ error: 'UNAUTHORIZED' }, 401);
    }
    return true;
  }
}

/** The configured token, or `null` when it is absent or too short to be one. */
export function configuredToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[OPS_TOKEN_ENV] ?? '').trim();
  return raw.length >= MIN_TOKEN_LENGTH ? raw : null;
}

/** Extracts the credential from `Authorization: Bearer <token>`. Case-insensitive
 * on the scheme, because HTTP says it is. */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * `timingSafeEqual` throws on a length mismatch — which would itself be a
 * timing oracle for the length — so both sides are compared at a fixed width
 * and the real length difference is folded in as a boolean afterwards.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  const width = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(width);
  const padB = Buffer.alloc(width);
  bufA.copy(padA);
  bufB.copy(padB);
  return timingSafeEqual(padA, padB) && bufA.length === bufB.length;
}
