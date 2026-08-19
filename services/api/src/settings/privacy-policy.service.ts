import { Injectable } from '@nestjs/common';
import { Prisma, platformDb, tenantDb } from '@ventia/db';
import { isPlanFeatureEnabledOn, loadPlanLimits } from '../common/plan-limits';
import {
  PRIVACY_POLICY_DISCLAIMER,
  renderPrivacyPolicy,
  type GeneratedPrivacyPolicy,
  type PrivacyPolicyTenantData,
} from './privacy-policy.template';

type JsonRecord = Record<string, unknown>;

function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Same ordering everywhere the three gateways are enumerated (see
 * `ALL_PROVIDER_IDS` in settings.controller.ts) so the generated sentence is
 * stable across regenerations rather than following JSON key order. */
const PROVIDER_ORDER = ['wompi', 'mercadopago', 'epayco'] as const;

export interface PrivacyPolicyGeneration extends GeneratedPrivacyPolicy {
  /** Merchant-facing warning. Never part of `bodyMd` — see the template's
   * doc comment for why it must not reach the shopper-facing page. */
  disclaimer: string;
  /** True when this tenant already has `policy_privacy` content saved, so the
   * admin UI can ask before replacing text the merchant wrote themselves. */
  hasExistingContent: boolean;
}

/**
 * Assembles a tenant's own data and renders their política de tratamiento de
 * datos personales (docs/SPEC.md §9).
 *
 * Generation NEVER writes: it returns text for the merchant to read, edit and
 * then save through `PUT /v1/admin/content/policy_privacy`. That split is the
 * "do not overwrite what the merchant already wrote" rule expressed in the API
 * shape rather than in a UI convention — there is no server route that can
 * replace a merchant's policy with generated text in one step.
 */
@Injectable()
export class PrivacyPolicyService {
  async generate(tenantId: string, now: Date = new Date()): Promise<PrivacyPolicyGeneration> {
    const db = tenantDb(tenantId);

    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const domains = await db.tenantDomain.findMany({ where: { tenantId } });
    const existing = await db.tenantContent.findUnique({
      where: { tenantId_type: { tenantId, type: 'policy_privacy' } },
    });

    // Plan entitlements go through the shared reader on platformDb, per
    // common/plan-limits.ts's "a plan limit is a fact ABOUT a tenant" note.
    const limits = await loadPlanLimits(tenantId);

    // Whether WhatsApp is genuinely LIVE, not merely allowed by the plan: the
    // policy tells a shopper we store the number they write from, and that is
    // only true once a number is actually connected. Counted on platformDb
    // because `ventia_app` has a column-level SELECT grant on this table that
    // omits two columns (see packages/db/src/tenant-models.ts) — a count needs
    // no columns, but keeping every read of this table on the owner connection
    // matches what every other caller in the codebase does.
    const whatsappConnected =
      (await platformDb.whatsAppNumber.count({ where: { tenantId, status: 'connected' } })) > 0;

    const settings = asRecord(tenant.settings);
    const storeInfo = asRecord(settings.storeInfo as Prisma.JsonValue | undefined);
    const payments = asRecord(settings.payments as Prisma.JsonValue | undefined);
    const providersJson = asRecord(payments.providers as Prisma.JsonValue | undefined);
    const agentConfig = asRecord(tenant.agentConfig);

    // A provider counts as "we use this to charge shoppers" only once real
    // credentials are saved — same signal `maskedProviderView` in
    // settings.controller.ts calls `connected`, read the same way (presence of
    // the encrypted private key), never by decrypting anything.
    const paymentProviders = PROVIDER_ORDER.filter(
      (id) => typeof asRecord(providersJson[id] as Prisma.JsonValue | undefined).privateKeyEncrypted === 'string',
    );

    const primaryDomain = domains.find((d) => d.isPrimary) ?? domains[0];

    const data: PrivacyPolicyTenantData = {
      storeName: tenant.name,
      domain: primaryDomain?.domain ?? null,
      contactEmail: asString(storeInfo.contactEmail),
      contactPhone: asString(storeInfo.contactPhone),
      // The three fields below have no writer today: `storeSettingsSchema`
      // (packages/core) accepts category/contactEmail/contactPhone/description
      // and strips anything else, so these are read defensively and will
      // normally render as [COMPLETAR: ...] markers. Adding them to that schema
      // is the one-line change that would autofill them; it lives in a package
      // this task does not own.
      legalName: asString(storeInfo.legalName),
      taxId: asString(storeInfo.taxId),
      addressLine: asString(storeInfo.address),
      municipio: asString(storeInfo.municipio),
      departamento: asString(storeInfo.departamento),
      codEnabled: payments.codEnabled === true,
      paymentProviders: [...paymentProviders],
      // Same definition of "this store has an AI agent" the storefront widget
      // uses (`agentEnabled` in tenants/domain-resolver.ts): a plan with a
      // non-zero monthly message allowance.
      agentEnabled: (limits?.aiMessagesMonth ?? 0) > 0,
      agentName: asString(agentConfig.agentName),
      whatsappConnected,
      humanHandoffEnabled: isPlanFeatureEnabledOn(limits, 'humanHandoff'),
      effectiveDate: now,
    };

    return {
      ...renderPrivacyPolicy(data),
      disclaimer: PRIVACY_POLICY_DISCLAIMER,
      hasExistingContent: existing !== null && existing.bodyMd.trim().length > 0,
    };
  }
}
