import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Prisma, tenantDb } from '@ventia/db';
import type { PaymentProviderId } from '@ventia/payments';
import { paymentsSettingsSchema, shippingSettingsSchema, storeSettingsSchema, themeSchema } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';
import { PaymentsService } from '../payments/payments.service';

type JsonRecord = Record<string, unknown>;

function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** Masks a public key for display: keeps the last 4 characters, replaces
 * everything else with `*`. `publicKey` is not secret (design decision 6 —
 * it's meant to appear in client-side checkout URLs), so this is purely a
 * "confirm which key is saved without echoing the whole thing back"
 * affordance, not a real confidentiality boundary the way `privateKey`'s
 * encryption is. */
function maskPublicKey(publicKey: string): string {
  const visible = publicKey.slice(-4);
  const hidden = '*'.repeat(Math.max(publicKey.length - 4, 0));
  return `${hidden}${visible}`;
}

/** Builds the masked `providers.wompi` view for `GET /v1/admin/settings` /
 * the PATCH response, reading DIRECTLY off the stored settings JSON —
 * deliberately NOT calling `PaymentsService.getTenantProviderConfig` (which
 * decrypts `privateKey`/`integritySecret`/`eventsSecret`). Answering
 * "is Wompi connected" + "what's the masked public key" never needs the
 * plaintext secrets, only the cleartext `publicKey` and the presence of the
 * encrypted-private-key blob — both already sitting in `payments.providers.
 * wompi` as saved by `PaymentsService.saveProviderCredentials`. This keeps
 * `toResponse` synchronous (no encryption-key/async round trip just to
 * render a settings page) and, more importantly, makes it structurally
 * impossible for this code path to ever touch — let alone leak — a
 * decrypted secret. */
function maskedWompiView(payments: JsonRecord): { connected: boolean; publicKeyMasked: string | null; sandbox: boolean } {
  const providers = asRecord(payments.providers as Prisma.JsonValue | undefined);
  const wompi = asRecord(providers.wompi as Prisma.JsonValue | undefined);
  const publicKey = typeof wompi.publicKey === 'string' ? wompi.publicKey : null;
  const connected = typeof wompi.privateKeyEncrypted === 'string';
  const sandbox = wompi.sandbox === true;
  return {
    connected,
    publicKeyMasked: publicKey ? maskPublicKey(publicKey) : null,
    sandbox,
  };
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
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve PaymentsService by type alone (same
  // caution as every other controller in this codebase — see orders.
  // controller.ts's identical comment).
  constructor(@Inject(PaymentsService) private readonly paymentsService: PaymentsService) {}

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

  /**
   * Extended (P3a Task 3) to accept an optional nested `providers.wompi`
   * object alongside the pre-existing `codEnabled` toggle. Both are
   * merge-in-place, INDEPENDENTLY of each other — a PATCH sending only one
   * must never clobber the other (design decision 8's explicit regression
   * risk callout). Deliberately does NOT spread `input` directly into
   * `settings.payments` the way the pre-P3a version did: `input.providers.
   * wompi`, if present, carries PLAINTEXT `privateKey`/`integritySecret`/
   * `eventsSecret` — those must go through `PaymentsService.
   * saveProviderCredentials` (which encrypts before persisting), never
   * written to `settings` as-is.
   */
  @Patch('payments')
  async updatePayments(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const input = parseOr400(paymentsSettingsSchema, body);

    if (input.providers?.wompi) {
      await this.paymentsService.saveProviderCredentials(session.tenantId, 'wompi', input.providers.wompi);
    }

    if (input.codEnabled !== undefined) {
      const db = tenantDb(session.tenantId);
      // Re-read fresh (rather than reusing an earlier read) so this merge
      // sees whatever `saveProviderCredentials` just wrote above when both
      // are present in the same PATCH — otherwise this write would overwrite
      // `settings` with a stale pre-providers-write snapshot.
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
      const settings = { ...asRecord(tenant.settings) };
      settings.payments = {
        ...asRecord(settings.payments as Prisma.JsonValue | undefined),
        codEnabled: input.codEnabled,
      };
      await db.tenant.update({
        where: { id: session.tenantId },
        data: { settings: settings as Prisma.InputJsonValue },
      });
    }

    // Audit log: NEVER pass `input` verbatim — `input.providers.wompi`
    // carries plaintext secrets, and `writeAudit` persists `data` as-is into
    // `AuditLog.data` (a real, separate leak vector from the API response
    // one this task's tests focus on). Only non-secret shape is recorded.
    await writeAudit(session, 'settings.payments', 'Tenant', session.tenantId, {
      ...(input.codEnabled !== undefined ? { codEnabled: input.codEnabled } : {}),
      ...(input.providers?.wompi
        ? { providers: { wompi: { publicKey: input.providers.wompi.publicKey, sandbox: input.providers.wompi.sandbox } } }
        : {}),
    });

    const tenant = await tenantDb(session.tenantId).tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
    return this.toResponse(tenant.name, tenant.slug, tenant.status, tenant.settings, tenant.theme);
  }

  /**
   * Owner-only connectivity check (same guards as every route on this
   * controller). No request body: the provider comes entirely from the URL
   * param, and there's nothing else for the caller to supply — the tenant's
   * already-saved credentials (from `updatePayments` above) are what gets
   * tested. Always 200 — `{ok: false}` is a successful API call reporting a
   * failed check, not an HTTP error (`PaymentsService.testConnection` itself
   * guarantees it never throws).
   */
  @Post('payments/:provider/test-connection')
  @HttpCode(200)
  async testConnection(
    @AdminSession() session: AdminSessionContext,
    @Param('provider') provider: PaymentProviderId,
  ) {
    return this.paymentsService.testConnection(session.tenantId, provider);
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
      payments: {
        codEnabled: payments.codEnabled === true,
        providers: { wompi: maskedWompiView(payments) },
      },
      // Defaults to `{}` when unset — the admin UI (a later task) handles
      // defaulting this to `{ methods: [] }` client-side.
      shipping,
    };
  }
}
