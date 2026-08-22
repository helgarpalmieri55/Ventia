import { Inject, Injectable } from '@nestjs/common';
import { Prisma, platformDb, tenantDb } from '@ventia/db';
import { loadPlanLimits } from '../common/plan-limits';
import { ShippingService } from '../checkout/shipping.service';
import { TERMS_DISCLAIMER, renderTerms, type GeneratedTerms, type TermsTenantData } from './terms.template';
import { asRecord, asString, connectedPaymentProviders } from './tenant-settings';

export interface TermsGeneration extends GeneratedTerms {
  /** Merchant-facing warning. Never part of `bodyMd` — see the template's
   * doc comment for why it must not reach the shopper-facing page. */
  disclaimer: string;
  /** True when this tenant already has `policy_terms` content saved, so the
   * admin UI can ask before replacing text the merchant wrote themselves. */
  hasExistingContent: boolean;
}

/**
 * Assembles a tenant's own configuration and renders their términos y
 * condiciones — the Ley 1480 "condiciones generales del contrato" their
 * storefront had no way to publish.
 *
 * Generation NEVER writes, exactly like `PrivacyPolicyService.generate`: it
 * returns text for the merchant to read, edit and then save through
 * `PUT /v1/admin/content/policy_terms`. There is no server route that can
 * replace a merchant's published contract with generated text in one step.
 *
 * ## Where the facts come from
 *
 * Shipping is read through `ShippingService.loadConfig` rather than by
 * re-parsing `settings.shipping` here, because the document QUOTES prices:
 * "envío estándar: $ 9.900" is a contractual term, and it has to come from
 * the same reader that prices the shopper's actual checkout. A second parse
 * is a second answer, and the one in the document is the one the merchant
 * gets held to.
 *
 * `ShippingService` is stateless (no constructor dependencies, no fields), so
 * `SettingsModule` provides its own instance instead of `CheckoutModule`
 * exporting it. Note this is NOT the case `ShippingConfig`'s doc comment
 * warns about — that warning is about calling `tenantDb()` while a
 * `platformDb.$transaction()` is open, and nothing on this path opens one.
 */
@Injectable()
export class TermsService {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // `design:paramtypes`, so implicit constructor injection resolves to
  // `undefined` and fails at call time rather than at boot.
  constructor(@Inject(ShippingService) private readonly shipping: ShippingService) {}

  async generate(tenantId: string, now: Date = new Date()): Promise<TermsGeneration> {
    const db = tenantDb(tenantId);

    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const domains = await db.tenantDomain.findMany({ where: { tenantId } });
    const existing = await db.tenantContent.findUnique({
      where: { tenantId_type: { tenantId, type: 'policy_terms' } },
    });
    const shippingConfig = await this.shipping.loadConfig(tenantId);

    // Plan entitlements go through the shared reader on platformDb, per
    // common/plan-limits.ts's "a plan limit is a fact ABOUT a tenant" note.
    const limits = await loadPlanLimits(tenantId);

    // Whether WhatsApp is genuinely LIVE, not merely allowed by the plan —
    // section 14 offers it as a PQR channel, and a channel nobody answers is
    // worse than one that is not listed. Counted on platformDb for the reason
    // PrivacyPolicyService gives.
    const whatsappConnected =
      (await platformDb.whatsAppNumber.count({ where: { tenantId, status: 'connected' } })) > 0;

    const settings = asRecord(tenant.settings);
    const storeInfo = asRecord(settings.storeInfo as Prisma.JsonValue | undefined);
    const payments = asRecord(settings.payments as Prisma.JsonValue | undefined);

    const primaryDomain = domains.find((d) => d.isPrimary) ?? domains[0];

    const data: TermsTenantData = {
      storeName: tenant.name,
      domain: primaryDomain?.domain ?? null,
      contactEmail: asString(storeInfo.contactEmail),
      contactPhone: asString(storeInfo.contactPhone),
      // The same five identidad-legal keys `storeSettingsSchema` accepts and
      // the privacy generator reads. `storeInfo.address` -> `addressLine` is
      // the same deliberate name difference documented there; renaming either
      // side silently reintroduces the [COMPLETAR: ...] markers.
      legalName: asString(storeInfo.legalName),
      taxId: asString(storeInfo.taxId),
      addressLine: asString(storeInfo.address),
      municipio: asString(storeInfo.municipio),
      departamento: asString(storeInfo.departamento),
      codEnabled: payments.codEnabled === true,
      paymentProviders: connectedPaymentProviders(payments),
      shippingMethods: shippingConfig.methods,
      codRestrictedDepartamentos: shippingConfig.codRestrictedDepartamentos,
      // Same definition of "this store has a chat widget" the storefront uses
      // (`agentEnabled` in tenants/domain-resolver.ts): a plan with a non-zero
      // monthly message allowance.
      agentEnabled: (limits?.aiCreditsMonth ?? 0) > 0,
      whatsappConnected,
      effectiveDate: now,
    };

    return {
      ...renderTerms(data),
      disclaimer: TERMS_DISCLAIMER,
      hasExistingContent: existing !== null && existing.bodyMd.trim().length > 0,
    };
  }
}
