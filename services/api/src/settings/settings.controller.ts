import { Body, Controller, Get, Patch, Put, UseGuards } from '@nestjs/common';
import { Prisma, tenantDb } from '@ventia/db';
import { paymentsSettingsSchema, shippingSettingsSchema, storeSettingsSchema, themeSchema } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';

type JsonRecord = Record<string, unknown>;

function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/**
 * Owner-only: every route here is behind both AdminSessionGuard (requires a
 * tenant-scoped session) and @Roles('owner') at the controller level, so
 * staff sessions get 403 FORBIDDEN_ROLE before any handler runs (M8's
 * "staff cannot reach settings" acceptance criterion).
 */
@Controller('v1/admin/settings')
@UseGuards(AdminSessionGuard)
@Roles('owner')
export class SettingsController {
  @Get()
  async get(@AdminSession() session: AdminSessionContext) {
    const tenant = await tenantDb(session.tenantId).tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
    return this.toResponse(tenant.name, tenant.slug, tenant.status, tenant.settings, tenant.theme);
  }

  @Patch('store')
  async updateStore(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const input = parseOr400(storeSettingsSchema, body);
    const db = tenantDb(session.tenantId);

    // Read-modify-write of the single `settings` JSON column, same pattern
    // as onboarding.service.ts's patchOnboarding: merge storeInfo in rather
    // than replace it, so this endpoint stays compatible with whatever keys
    // the onboarding wizard (settings.onboarding, settings.storeInfo) has
    // already written for this tenant.
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
    const settings = { ...asRecord(tenant.settings) };
    if (input.storeInfo !== undefined) {
      settings.storeInfo = { ...asRecord(settings.storeInfo as Prisma.JsonValue | undefined), ...input.storeInfo };
    }

    const updated = await db.tenant.update({
      where: { id: session.tenantId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        settings: settings as Prisma.InputJsonValue,
      },
    });

    await writeAudit(session, 'settings.store', 'Tenant', session.tenantId, input);

    return this.toResponse(updated.name, updated.slug, updated.status, updated.settings, updated.theme);
  }

  @Put('theme')
  async replaceTheme(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const input = parseOr400(themeSchema, body);
    const db = tenantDb(session.tenantId);

    // PUT, not PATCH: `theme` is replaced wholesale (spec's storefront theme
    // has no partial-update concept — every render needs colors/fontPair/
    // radius present), unlike settings.storeInfo/payments's merge-in-place.
    const updated = await db.tenant.update({
      where: { id: session.tenantId },
      data: { theme: input as Prisma.InputJsonValue },
    });

    await writeAudit(session, 'settings.theme', 'Tenant', session.tenantId, input);

    return this.toResponse(updated.name, updated.slug, updated.status, updated.settings, updated.theme);
  }

  @Patch('payments')
  async updatePayments(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const input = parseOr400(paymentsSettingsSchema, body);
    const db = tenantDb(session.tenantId);

    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
    const settings = { ...asRecord(tenant.settings) };
    settings.payments = { ...asRecord(settings.payments as Prisma.JsonValue | undefined), ...input };

    const updated = await db.tenant.update({
      where: { id: session.tenantId },
      data: { settings: settings as Prisma.InputJsonValue },
    });

    await writeAudit(session, 'settings.payments', 'Tenant', session.tenantId, input);

    return this.toResponse(updated.name, updated.slug, updated.status, updated.settings, updated.theme);
  }

  @Patch('shipping')
  async updateShipping(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const input = parseOr400(shippingSettingsSchema, body);
    const db = tenantDb(session.tenantId);

    // PATCH, but `settings.shipping` is replaced wholesale (like `theme`'s
    // PUT, not payments/storeInfo's merge-in-place) — a methods array has no
    // meaningful partial-update semantics: there's no sensible way to "merge"
    // one array of shipping methods into another key-by-key.
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
    const settings = { ...asRecord(tenant.settings) };
    settings.shipping = input;

    const updated = await db.tenant.update({
      where: { id: session.tenantId },
      data: { settings: settings as Prisma.InputJsonValue },
    });

    await writeAudit(session, 'settings.shipping', 'Tenant', session.tenantId, input);

    return this.toResponse(updated.name, updated.slug, updated.status, updated.settings, updated.theme);
  }

  private toResponse(
    name: string,
    slug: string,
    status: string,
    settingsJson: Prisma.JsonValue | null,
    themeJson: Prisma.JsonValue | null,
  ) {
    const settings = asRecord(settingsJson);
    const storeInfo = asRecord(settings.storeInfo as Prisma.JsonValue | undefined);
    const payments = asRecord(settings.payments as Prisma.JsonValue | undefined);
    const shipping = asRecord(settings.shipping as Prisma.JsonValue | undefined);
    const theme = asRecord(themeJson);

    return {
      name,
      slug,
      status,
      storeInfo,
      theme,
      payments: { codEnabled: payments.codEnabled === true },
      // Defaults to `{}` when unset — the admin UI (a later task) handles
      // defaulting this to `{ methods: [] }` client-side.
      shipping,
    };
  }
}
