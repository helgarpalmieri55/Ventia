import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DomainResolver, normalizeHost, type ResolvedTenant } from './domain-resolver';

declare module 'express-serve-static-core' {
  interface Request {
    tenant?: ResolvedTenant | null;
  }
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve DomainResolver by type alone.
  constructor(@Inject(DomainResolver) private readonly resolver: DomainResolver) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const host = normalizeHost(req.headers.host);
    try {
      req.tenant = host ? await this.resolver.resolve(host) : null;
    } catch (err) {
      // Express 4 does not catch rejections thrown from async middleware, so
      // an unguarded await here would become an unhandled rejection and crash
      // the whole process for every tenant. Catch, log, and hand the error to
      // Express so it becomes a 500 for THIS request only.
      console.error('[tenant-middleware]', err);
      next(err);
      return;
    }
    next();
  }
}
