import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import type { Request } from 'express';
import { platformDb } from '@ventia/db';
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
  async current(@Req() req: Request): Promise<ResolvedTenant & { theme: unknown }> {
    if (!req.tenant) throw new NotFoundException({ error: 'TENANT_NOT_FOUND' });

    // `req.tenant` comes from `DomainResolver`'s Redis-cached
    // `{tenantId, slug, name, status}` shape (tenant.middleware.ts) — that
    // cache backs *every* request (including non-storefront ones), so it
    // deliberately doesn't carry the theme JSON blob. This is the one route
    // that needs it (the storefront layout reads `theme` to build its CSS
    // vars — see apps/storefront/app/layout.tsx), so it's read directly
    // here instead of growing the shared cache entry. Same read
    // `AdminMeController`/`SettingsController` already expose to the
    // merchant's own admin session, just surfaced on this public endpoint
    // too — theme is not sensitive data.
    const tenant = await platformDb.tenant.findUnique({
      where: { id: req.tenant.tenantId },
      select: { theme: true },
    });

    return { ...req.tenant, theme: tenant?.theme ?? null };
  }
}
