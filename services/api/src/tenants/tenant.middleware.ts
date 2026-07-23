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
    req.tenant = host ? await this.resolver.resolve(host) : null;
    next();
  }
}
