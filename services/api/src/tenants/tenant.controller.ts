import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
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
  current(@Req() req: Request): ResolvedTenant & { theme: unknown } {
    if (!req.tenant) throw new NotFoundException({ error: 'TENANT_NOT_FOUND' });

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
