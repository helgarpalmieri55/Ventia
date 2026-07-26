import { Injectable, HttpException } from '@nestjs/common';
import { tenantDb, type Prisma } from '@ventia/db';
import type { ShippingMethodInput, ShippingMethodType } from '@ventia/core';

type JsonRecord = Record<string, unknown>;

// Same defensive-parse posture as settings/settings.controller.ts's asRecord:
// `settings` is a loosely-typed JSON column, so every read through it treats
// an absent/malformed shape as "nothing configured" rather than throwing.
function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export interface ShippingQuoteLine {
  id: string;
  type: ShippingMethodType;
  label: string;
  priceCents: number;
}

@Injectable()
export class ShippingService {
  /** Reads a tenant's enabled shipping methods off `settings.shipping.methods`,
   * defaulting to `[]` for a tenant that has never configured shipping (an
   * unset/malformed `settings` column must never crash a storefront quote). */
  private async enabledMethods(tenantId: string): Promise<ShippingMethodInput[]> {
    const tenant = await tenantDb(tenantId).tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = asRecord(tenant.settings);
    const shipping = asRecord(settings.shipping as Prisma.JsonValue | undefined);
    const methods = Array.isArray(shipping.methods) ? (shipping.methods as ShippingMethodInput[]) : [];
    return methods.filter((m) => m && m.enabled === true);
  }

  /**
   * "What are my shipping options" listing for the pre-submit storefront UI,
   * which doesn't yet know the cart's real subtotal. `zone` methods with no
   * rate for this departamento (neither a specific rate nor a fallback) are
   * simply OMITTED from the results here — one unpriceable method shouldn't
   * fail the whole quote, since this is a menu of options, not a commitment
   * to any one of them. Contrast with `priceFor`, which is called once a
   * SPECIFIC method has been chosen at checkout time and hard-fails
   * (SHIPPING_METHOD_UNAVAILABLE) if that chosen method can't be priced.
   *
   * `free_over` can't be resolved here either (no subtotal yet) — it shows
   * `fallbackPriceCents` as a placeholder display price. The real
   * checkout-time price (via `priceFor`, once the actual subtotal is known)
   * may differ (0 if the real subtotal clears the threshold) — that's
   * expected and is why `priceFor` exists as a separate call.
   */
  async quote(tenantId: string, departamentoCode: string): Promise<ShippingQuoteLine[]> {
    const methods = await this.enabledMethods(tenantId);
    const lines: ShippingQuoteLine[] = [];
    for (const method of methods) {
      switch (method.type) {
        case 'flat':
          lines.push({ id: method.id, type: method.type, label: method.label, priceCents: method.priceCents });
          break;
        case 'zone': {
          const rate = method.ratesByDepartamento[departamentoCode] ?? method.defaultPriceCents;
          if (rate === undefined) break; // omit, don't fail the whole quote
          lines.push({ id: method.id, type: method.type, label: method.label, priceCents: rate });
          break;
        }
        case 'free_over':
          lines.push({
            id: method.id,
            type: method.type,
            label: method.label,
            priceCents: method.fallbackPriceCents,
          });
          break;
        case 'pickup':
          lines.push({ id: method.id, type: method.type, label: method.label, priceCents: 0 });
          break;
      }
    }
    return lines;
  }

  /** Prices ONE specific, already-chosen method, now that the real cart
   * subtotal is known. Unlike `quote`, this hard-fails
   * (SHIPPING_METHOD_UNAVAILABLE, 400) when the method isn't configured/
   * enabled, or (for `zone`) has no rate for this departamento — checkout
   * cannot silently proceed with an unpriceable shipping choice. */
  async priceFor(
    tenantId: string,
    methodId: string,
    departamentoCode: string,
    subtotalCents: number,
  ): Promise<number> {
    const methods = await this.enabledMethods(tenantId);
    const method = methods.find((m) => m.id === methodId);
    if (!method) {
      throw new HttpException({ error: 'SHIPPING_METHOD_UNAVAILABLE', details: { methodId } }, 400);
    }

    switch (method.type) {
      case 'flat':
        return method.priceCents;
      case 'zone': {
        const rate = method.ratesByDepartamento[departamentoCode] ?? method.defaultPriceCents;
        if (rate === undefined) {
          throw new HttpException({ error: 'SHIPPING_METHOD_UNAVAILABLE', details: { methodId } }, 400);
        }
        return rate;
      }
      case 'free_over':
        return subtotalCents >= method.thresholdCents ? 0 : method.fallbackPriceCents;
      case 'pickup':
        return 0;
    }
  }

  /** `true` when `codRestrictedDepartamentos` is unset/empty (no restriction
   * configured — COD allowed everywhere), else `true` UNLESS this
   * departamento is in the list. `codRestrictedDepartamentos` (per its
   * shipping-schemas.ts doc comment) names departamentos where COD is
   * *disallowed* ("many carriers don't offer COD to"), so membership in the
   * list must gate COD OFF, not on — this is the negation of a literal
   * `.includes()` read of that field. */
  async isCodAllowed(tenantId: string, departamentoCode: string): Promise<boolean> {
    const tenant = await tenantDb(tenantId).tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = asRecord(tenant.settings);
    const shipping = asRecord(settings.shipping as Prisma.JsonValue | undefined);
    const restricted = Array.isArray(shipping.codRestrictedDepartamentos)
      ? (shipping.codRestrictedDepartamentos as string[])
      : [];
    if (restricted.length === 0) return true;
    return !restricted.includes(departamentoCode);
  }
}
