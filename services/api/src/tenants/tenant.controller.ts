import { Controller, Get, HttpException, NotFoundException, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ResolvedTenant } from './domain-resolver';

@Controller('v1/tenant')
export class TenantController {
  @Get()
  // Explicit return type: without it, tsc infers a type that names
  // Prisma's generated runtime library module path directly (from
  // `platformDb.tenant.findUnique`'s result), which `tsc --noEmit` accepts
  // but a declaration-emitting `tsc` build (this package's `build` script)
  // rejects with TS2742 ("not portable") since that path isn't part of this
  // package's own public API surface.
  //
  // Cross-phase fix (final P2 review): this route predates PublicTenantGuard
  // (storefront/public-tenant.guard.ts, added in P2a) and was never updated
  // to match its two invariants — (1) a `draft` tenant must be
  // indistinguishable from an unresolved one, (2) a `suspended` tenant must
  // fail closed with a real 503 — even though this is the exact same public,
  // unauthenticated, host-keyed lookup PublicTenantGuard exists to protect.
  // Before this fix, any caller could hit this endpoint directly (it's
  // reverse-proxied publicly at api.ventia.*, per docker/Caddyfile — not
  // merely an internal-only route) with an arbitrary `x-tenant-domain`
  // header and enumerate pre-launch tenants (name, internal tenantId, saved
  // theme, real `status`) months before they ever go live, and get a plain
  // 200 for a suspended tenant instead of a 503. Worse, the storefront's own
  // page components (app/page.tsx et al.) only ever check `if (!tenant)
  // notFound()` — never `tenant.status` — trusting this endpoint to already
  // enforce the same rules PublicTenantGuard enforces on every other public
  // route; because it didn't, a draft tenant's real store name rendered
  // publicly on its own not-yet-launched subdomain (reproduced in
  // test/tenant-endpoint.test.ts). Mirrors PublicTenantGuard's exact
  // behavior now: `middleware.ts` (which uses this route specifically to
  // detect `suspended` ahead of the route tree) is updated in the same
  // commit to key off the resulting 503 instead of a 200-with-status-field
  // body.
  current(@Req() req: Request): ResolvedTenant & { theme: unknown } {
    if (!req.tenant || req.tenant.status === 'draft') {
      throw new NotFoundException({ error: 'TENANT_NOT_FOUND' });
    }
    if (req.tenant.status === 'suspended') {
      throw new HttpException({ error: 'TENANT_SUSPENDED' }, 503);
    }

    // `req.tenant` is `DomainResolver`'s Redis-cached resolve (60s TTL),
    // which now includes `theme` (see domain-resolver.ts) — reading it here
    // used to issue a second, uncached `platformDb.tenant.findUnique` on
    // every call, defeating the cache for the storefront's own bootstrap
    // endpoint. `?? null` guards only the `theme?: unknown` optional-field
    // widening on `ResolvedTenant`, not a real runtime gap: every resolve
    // through `DomainResolver.resolve()` sets it from the tenant row.
    return { ...req.tenant, theme: req.tenant.theme ?? null };
  }
}
