import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Prisma, tenantDb } from '@ventia/db';
import type { PaymentProviderId } from '@ventia/payments';
import {
  agentSettingsSchema,
  paymentsSettingsSchema,
  shippingSettingsSchema,
  storeSettingsSchema,
  themeSchema,
} from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';
import { PaymentsService } from '../payments/payments.service';
import { platformRootDomain } from '../tenants/custom-domains.service';
import { tenantStorefrontBaseUrl } from '../tenants/tenant-public-url';

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

/** Builds the masked `providers.<provider>` view for `GET
 * /v1/admin/settings` / the PATCH response, reading DIRECTLY off the stored
 * settings JSON — deliberately NOT calling
 * `PaymentsService.getTenantProviderConfig` (which decrypts
 * `privateKey`/`integritySecret`/`eventsSecret`/`epaycoCustomerId`).
 * Answering "is this provider connected" + "what's the masked public key"
 * never needs the plaintext secrets, only the cleartext `publicKey` and the
 * presence of the encrypted-private-key blob — both already sitting in
 * `payments.providers.<provider>` as saved by
 * `PaymentsService.saveProviderCredentials`. This keeps `toResponse`
 * synchronous (no encryption-key/async round trip just to render a settings
 * page) and, more importantly, makes it structurally impossible for this
 * code path to ever touch — let alone leak — a decrypted secret.
 *
 * Generalized (P3b Task 4) from a Wompi-only `maskedWompiView` to a shared
 * helper parameterized by `provider` — this was a plan gap: the plan's
 * stated Task 4 file list didn't mention this controller at all, but leaving
 * it hardcoded to `wompi` would have made the new
 * `mercadopago`/`epayco` schemas unreachable in practice (a PATCH could still
 * save mercadopago/epayco credentials, but `GET`/every PATCH response would
 * never show their connection status, matching neither `wompi`'s existing UX
 * nor Task 5's admin UI needs). Same generalization discipline as this
 * phase's Task 1 `checkout.service.ts` `!== 'cod'` refactor. */
function maskedProviderView(
  payments: JsonRecord,
  provider: PaymentProviderId,
): { connected: boolean; publicKeyMasked: string | null; sandbox: boolean } {
  const providers = asRecord(payments.providers as Prisma.JsonValue | undefined);
  const stored = asRecord(providers[provider] as Prisma.JsonValue | undefined);
  const publicKey = typeof stored.publicKey === 'string' ? stored.publicKey : null;
  const connected = typeof stored.privateKeyEncrypted === 'string';
  const sandbox = stored.sandbox === true;
  return {
    connected,
    publicKeyMasked: publicKey ? maskPublicKey(publicKey) : null,
    sandbox,
  };
}

/** Every `PaymentProviderId` with a real schema/UI slot — used to loop over
 * `input.providers` generically in `updatePayments` and to build the full
 * `providers` view in `toResponse`, rather than hand-enumerating `wompi`/
 * `mercadopago`/`epayco` at each call site. */
const ALL_PROVIDER_IDS: readonly PaymentProviderId[] = ['wompi', 'mercadopago', 'epayco'];

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
    return this.toResponse(tenant.name, tenant.slug, tenant.status, tenant.settings, tenant.theme, tenant.agentConfig);
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

    return this.toResponse(
      updated.name,
      updated.slug,
      updated.status,
      updated.settings,
      updated.theme,
      updated.agentConfig,
    );
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

    return this.toResponse(
      updated.name,
      updated.slug,
      updated.status,
      updated.settings,
      updated.theme,
      updated.agentConfig,
    );
  }

  /**
   * Extended (P3a Task 3) to accept an optional nested `providers.wompi`
   * object alongside the pre-existing `codEnabled` toggle, and further
   * widened (P3b Task 4, a plan gap — the plan's stated file list for this
   * task never mentioned this controller, but leaving it hardcoded to
   * `wompi` would leave the new `mercadopago`/`epayco` schemas unreachable
   * through this endpoint) to loop over EVERY `PaymentProviderId` present in
   * `input.providers`. All of `codEnabled` and each configured provider are
   * merge-in-place, INDEPENDENTLY of each other and of one another — a PATCH
   * sending only one must never clobber any of the others (design decision
   * 8's explicit regression risk callout, now generalized to 3 providers +
   * codEnabled = 4 independently-mergeable pieces). Deliberately does NOT
   * spread `input` directly into `settings.payments` the way the pre-P3a
   * version did: `input.providers.<id>`, if present, carries PLAINTEXT
   * `privateKey`/`integritySecret`/`eventsSecret`/`epaycoCustomerId` — those
   * must go through `PaymentsService.saveProviderCredentials` (which encrypts
   * before persisting), never written to `settings` as-is.
   */
  @Patch('payments')
  async updatePayments(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const input = parseOr400(paymentsSettingsSchema, body);

    for (const providerId of ALL_PROVIDER_IDS) {
      const creds = input.providers?.[providerId];
      if (creds) {
        await this.paymentsService.saveProviderCredentials(session.tenantId, providerId, creds);
      }
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

    // Audit log: NEVER pass `input` verbatim — `input.providers.<id>` carries
    // plaintext secrets, and `writeAudit` persists `data` as-is into
    // `AuditLog.data` (a real, separate leak vector from the API response
    // one this task's tests focus on). Only non-secret shape is recorded,
    // for whichever provider(s) were actually present in this PATCH.
    const auditedProviders: Record<string, { publicKey: string; sandbox: boolean }> = {};
    for (const providerId of ALL_PROVIDER_IDS) {
      const creds = input.providers?.[providerId];
      if (creds) {
        auditedProviders[providerId] = { publicKey: creds.publicKey, sandbox: creds.sandbox };
      }
    }
    await writeAudit(session, 'settings.payments', 'Tenant', session.tenantId, {
      ...(input.codEnabled !== undefined ? { codEnabled: input.codEnabled } : {}),
      ...(Object.keys(auditedProviders).length > 0 ? { providers: auditedProviders } : {}),
    });

    const tenant = await tenantDb(session.tenantId).tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
    return this.toResponse(tenant.name, tenant.slug, tenant.status, tenant.settings, tenant.theme, tenant.agentConfig);
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

    return this.toResponse(
      updated.name,
      updated.slug,
      updated.status,
      updated.settings,
      updated.theme,
      updated.agentConfig,
    );
  }

  /**
   * The merchant's configuration of the AI sales agent (docs/SPEC.md §7).
   *
   * Writes `Tenant.agentConfig` — a column of its own rather than another key
   * under `settings`, because that is where the schema already put it and
   * where `agent/system-prompt.ts` already reads it from.
   *
   * Merged field-by-field like `storeInfo`, not replaced like `theme`: the
   * admin page edits these four fields independently and there is no render
   * that needs all four present, so a PATCH carrying only `tone` should not
   * silently blank a store's carefully written summary.
   */
  @Patch('agent')
  async updateAgent(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    const input = parseOr400(agentSettingsSchema, body);
    const db = tenantDb(session.tenantId);

    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
    const agentConfig = { ...asRecord(tenant.agentConfig), ...input };

    const updated = await db.tenant.update({
      where: { id: session.tenantId },
      data: { agentConfig: agentConfig as Prisma.InputJsonValue },
    });

    await writeAudit(session, 'settings.agent', 'Tenant', session.tenantId, input);

    return this.toResponse(
      updated.name,
      updated.slug,
      updated.status,
      updated.settings,
      updated.theme,
      updated.agentConfig,
    );
  }

  private toResponse(
    name: string,
    slug: string,
    status: string,
    settingsJson: Prisma.JsonValue | null,
    themeJson: Prisma.JsonValue | null,
    agentConfigJson: Prisma.JsonValue | null,
  ) {
    const settings = asRecord(settingsJson);
    const storeInfo = asRecord(settings.storeInfo as Prisma.JsonValue | undefined);
    const payments = asRecord(settings.payments as Prisma.JsonValue | undefined);
    const shipping = asRecord(settings.shipping as Prisma.JsonValue | undefined);
    const theme = asRecord(themeJson);
    const agent = asRecord(agentConfigJson);

    return {
      name,
      slug,
      status,
      /**
       * The browser-reachable address of this store — what the launch screen
       * links to once the merchant presses "Lanzar tienda".
       *
       * The admin panel used to build this itself as
       * `http://${slug}.ventia.localhost`, with the root hardcoded. That link
       * is dead on every deployment that is not this repo's dev stack, and
       * plaintext even where it is not: the two things a merchant is most
       * likely to click right after launching.
       *
       * Built from the free `${slug}.${root}` subdomain rather than whichever
       * domain is primary. That address exists from provisioning and never
       * stops resolving, whereas a custom domain reaches this screen only if
       * the merchant already finished a DNS setup they usually have not — and
       * a launch screen linking to a domain that does not resolve yet reads as
       * "the launch failed". `tenantStorefrontBaseUrl` picks the scheme, so a
       * real domain gets https and the `.localhost` dev stack gets http.
       */
      storeUrl: tenantStorefrontBaseUrl(`${slug}.${platformRootDomain()}`),
      storeInfo,
      theme,
      payments: {
        codEnabled: payments.codEnabled === true,
        // Generalized (P3b Task 4) from a wompi-only view to all 3
        // providers, so `GET /v1/admin/settings` and every PATCH response
        // consistently show connection status for wompi/mercadopago/epayco
        // going forward — see `maskedProviderView`'s doc comment for why
        // this generalization was necessary, not optional.
        providers: {
          wompi: maskedProviderView(payments, 'wompi'),
          mercadopago: maskedProviderView(payments, 'mercadopago'),
          epayco: maskedProviderView(payments, 'epayco'),
        },
      },
      // Defaults to `{}` when unset — the admin UI (a later task) handles
      // defaulting this to `{ methods: [] }` client-side.
      shipping,
      // Whatever the merchant has configured for the AI agent, `{}` when
      // untouched. Unlike the storefront's own view of this blob
      // (`/v1/tenant`, which exposes only `agentName`), the whole thing is
      // returned here — this route is owner-only and it is the merchant's own
      // text.
      agent,
    };
  }
}
