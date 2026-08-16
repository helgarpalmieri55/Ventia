import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DomainResolver, normalizeHost, type ResolvedTenant } from './domain-resolver';

declare module 'express-serve-static-core' {
  interface Request {
    tenant?: ResolvedTenant | null;
    // Set by PublicTenantGuard once req.tenant is confirmed resolved and
    // live; storefront route handlers read it via @StorefrontTenantId().
    storefrontTenantId?: string;
    // Set by PublicTenantGuard alongside storefrontTenantId: the
    // `TenantDomain.domain` row this request's tenant was resolved through.
    // Read via @StorefrontTenantDomain() by routes that need the tenant's
    // PUBLIC base URL (checkout, for the payment adapters' return URLs).
    storefrontTenantDomain?: string;
    // Set by CartCookieGuard: the `ventia_cart` cookie value IF it resolves
    // to a real Cart row for this tenant, else null (stale/tampered cookie,
    // no cookie at all, or another tenant's cookie value replayed against
    // this one). Never thrown on — an absent/invalid cart is normal state,
    // handled per-route via @CartCookieKey().
    cartCookieKey?: string | null;
  }
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve DomainResolver by type alone.
  constructor(@Inject(DomainResolver) private readonly resolver: DomainResolver) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    // Node's fetch (undici) ignores caller-set Host headers, so the storefront
    // forwards the visitor's subdomain via this internal header instead. Fall
    // back to Host for direct calls (e.g. curl, browsers) that never sent it,
    // and also when the header is present but empty (`''` or `[]`) — `??`
    // alone only catches undefined/null, so an empty value would otherwise
    // short-circuit straight to "no tenant" instead of falling back.
    const domainHeader = req.headers['x-tenant-domain'];
    const rawHost = (Array.isArray(domainHeader) ? domainHeader[0] : domainHeader) || req.headers.host;
    const host = normalizeHost(rawHost);
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
