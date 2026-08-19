import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import { captureError } from './sentry';

/**
 * Reports unhandled request errors, then hands the exception straight back to
 * Nest's own handling.
 *
 * ## Why it extends `BaseExceptionFilter` instead of formatting a response
 *
 * A global filter REPLACES Nest's default exception handling for everything
 * it catches, and `@Catch()` with no argument catches everything. Every error
 * response shape in this API — `{ error: 'UNAUTHENTICATED' }`, the 400s from
 * `parseOr400`, the 429s from the rate limiters — would then be this file's
 * responsibility, and any drift would be a silent API change across ~60 test
 * files. `BaseExceptionFilter` is the very class Nest's own
 * `ExceptionsHandler` extends, so `super.catch()` produces byte-identical
 * responses. This filter's entire contribution is the `captureError` call in
 * front of it.
 *
 * ## What is reported
 *
 * Only what an operator should be woken for: unknown exceptions (which become
 * 500s) and `HttpException`s carrying a 5xx status. A 401 from
 * `PlatformAdminGuard`, a 400 from a bad body, a 404, a 429 — those are the
 * API working correctly, and reporting them would bury the real ones.
 *
 * ## Context attached
 *
 * Tenant id, HTTP method and route; nothing about the human making the
 * request. The tenant id comes from `req.tenant` (set by `TenantMiddleware`)
 * or `req.storefrontTenantId` (set by `PublicTenantGuard`), both opaque
 * uuids. It is the field that answers the only question worth asking first:
 * is one store broken, or all of them.
 *
 * Every value here still passes through `scrub.ts` on the way out.
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    // Wrapped: a bug in reporting must never change what the caller receives.
    try {
      this.report(exception, host);
    } catch (err) {
      console.error('[observability] failed to report an exception', err instanceof Error ? err.message : err);
    }
    super.catch(exception, host);
  }

  private report(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    if (exception instanceof HttpException && exception.getStatus() < 500) return;

    const req = host.switchToHttp().getRequest<Request>();
    captureError(exception, {
      tenantId: req.tenant?.tenantId ?? req.storefrontTenantId ?? null,
      source: 'http',
      // `req.route?.path` is the route TEMPLATE (`/v1/orders/:id`) where Nest
      // matched one; `req.path` is the concrete URL, used only as a fallback
      // and scrubbed like everything else.
      operation: `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`,
      extra: { statusCode: exception instanceof HttpException ? exception.getStatus() : 500 },
    });
  }
}
