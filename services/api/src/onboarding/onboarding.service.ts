import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, platformDb, tenantDb } from '@ventia/db';
import {
  PLANS,
  onboardingStepSchema,
  paymentsDataSchema,
  slugify,
  storeInfoDataSchema,
  tenantProvisionSchema,
} from '@ventia/core';
import type { SessionContext } from '../auth/session-context';
import type { AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';

const MAX_SLUG_SUFFIX = 20;

export interface LaunchChecklist {
  storeInfo: boolean;
  emailVerified: boolean;
  hasActiveProduct: boolean;
  paymentsReady: boolean;
  ready: boolean;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

@Injectable()
export class OnboardingService {
  /**
   * Creates the tenant a signed-in, tenant-less user provisions on
   * first sign-up. Runs entirely on platformDb (the unscoped, owner-role
   * client) in ONE `$transaction`, not tenantDb: tenantDb's per-call RLS
   * scoping (SET LOCAL ROLE + `app.tenant_id` GUC, see
   * packages/db/src/tenant-client.ts) requires a tenantId to scope TO, and
   * that tenantId doesn't exist until the Tenant row created inside this
   * very transaction — tenant creation is necessarily a system-context
   * operation that precedes tenant scope, not something a tenant-scoped
   * client could ever perform.
   */
  async provisionTenant(session: SessionContext, body: unknown) {
    const existingMembership = await platformDb.membership.findFirst({
      where: { userId: session.userId },
    });
    if (existingMembership) {
      throw new HttpException({ error: 'ALREADY_HAS_TENANT' }, 409);
    }
    const input = parseOr400(tenantProvisionSchema, body);
    const base = input.slug ?? slugify(input.storeName);
    const rootDomain = process.env.PLATFORM_ROOT_DOMAIN ?? 'ventia.localhost';

    const tenant = await platformDb.$transaction(async (tx) => {
      const slug = await this.uniqueTenantSlug(tx, base);

      const created = await tx.tenant.create({
        data: { slug, name: input.storeName, status: 'draft', plan: 'basico' },
      });

      const limits = PLANS.basico;
      await tx.tenantLimits.create({
        data: {
          tenantId: created.id,
          productsMax: limits.productsMax,
          aiMessagesMonth: limits.aiMessagesMonth,
          staffSeats: limits.staffSeats,
          customDomain: limits.customDomain,
          humanHandoff: limits.humanHandoff,
          whatsappChannel: limits.whatsappChannel,
        },
      });

      await tx.tenantDomain.create({
        data: {
          tenantId: created.id,
          domain: `${slug}.${rootDomain}`,
          isPrimary: true,
          verifiedAt: new Date(),
        },
      });

      await tx.membership.create({
        data: { userId: session.userId, tenantId: created.id, role: 'owner' },
      });

      return created;
    });

    // Deliberately after the transaction commits: AuditLog isn't part of the
    // provisioning invariant itself (see audit.ts's doc comment — audit
    // writes must never fail an already-committed business mutation), and
    // the session here is synthesized (session.tenantId was null going in)
    // rather than the narrowed AdminSessionContext every other writeAudit
    // caller has on hand.
    await writeAudit(
      { userId: session.userId, email: session.email, tenantId: tenant.id, role: 'owner' },
      'onboarding.tenant_create',
      'Tenant',
      tenant.id,
      { storeName: input.storeName, slug: tenant.slug },
    );

    return {
      tenant: { tenantId: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status },
      role: 'owner' as const,
    };
  }

  /** Finds a tenant-unique slug: `base`, then `base-2`, ... `base-20` — same
   * dedup shape as products.service.ts's uniqueSlug, against Tenant.slug
   * instead of Product.slug. Throws 409 SLUG_TAKEN if all 20 are taken. */
  private async uniqueTenantSlug(tx: Prisma.TransactionClient, base: string): Promise<string> {
    for (let suffix = 1; suffix <= MAX_SLUG_SUFFIX; suffix++) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      const clash = await tx.tenant.findFirst({ where: { slug: candidate }, select: { id: true } });
      if (!clash) return candidate;
    }
    throw new HttpException({ error: 'SLUG_TAKEN' }, 409);
  }

  async getOnboarding(session: AdminSessionContext, emailVerified: boolean) {
    const db = tenantDb(session.tenantId);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
    const hasActiveProduct = (await db.product.count({ where: { status: 'active' } })) > 0;
    const checklist = this.buildChecklist(tenant, emailVerified, hasActiveProduct);

    return { steps: asRecord(tenant.settings).onboarding ?? {}, checklist };
  }

  /**
   * Shared checklist computation behind both GET /v1/admin/onboarding and
   * POST /v1/admin/launch (task-6 brief: "REUSE the existing service method,
   * don't duplicate"). `emailVerified` is passed in rather than looked up
   * here because both callers already have it cheaply on hand: the
   * onboarding GET reads it off `req.emailVerified` (set by AdminSessionGuard
   * from the caller's own session), and launch does the same — launch is
   * @Roles('owner')-only, so the calling session IS the owner whose
   * verification state the checklist needs.
   */
  private buildChecklist(
    tenant: { name: string; settings: Prisma.JsonValue | null },
    emailVerified: boolean,
    hasActiveProduct: boolean,
  ): LaunchChecklist {
    const settings = asRecord(tenant.settings);

    const storeInfoSettings = asRecord(settings.storeInfo as Prisma.JsonValue | undefined);
    const storeInfo = Boolean(tenant.name) && typeof storeInfoSettings.contactEmail === 'string';

    const paymentsSettings = asRecord(settings.payments as Prisma.JsonValue | undefined);
    const paymentsReady = paymentsSettings.codEnabled === true;

    return {
      storeInfo,
      emailVerified,
      hasActiveProduct,
      paymentsReady,
      ready: storeInfo && emailVerified && hasActiveProduct && paymentsReady,
    };
  }

  /**
   * POST /v1/admin/launch: not ready -> 422 LAUNCH_CHECKLIST_INCOMPLETE with
   * the checklist as `details`; ready -> flips tenant.status to 'live',
   * writes the 'tenant.launch' audit row, and returns the checklist.
   * Idempotent: a tenant already 'live' short-circuits to `{ status: 'live' }`
   * before touching the checklist or writing a second audit row.
   */
  async launch(session: AdminSessionContext, emailVerified: boolean) {
    const db = tenantDb(session.tenantId);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: session.tenantId } });

    if (tenant.status === 'live') {
      return { status: 'live' as const };
    }

    const hasActiveProduct = (await db.product.count({ where: { status: 'active' } })) > 0;
    const checklist = this.buildChecklist(tenant, emailVerified, hasActiveProduct);

    if (!checklist.ready) {
      throw new HttpException({ error: 'LAUNCH_CHECKLIST_INCOMPLETE', details: checklist }, 422);
    }

    await db.tenant.update({ where: { id: session.tenantId }, data: { status: 'live' } });
    await writeAudit(session, 'tenant.launch', 'Tenant', session.tenantId, checklist);

    return { status: 'live' as const, checklist };
  }

  async patchOnboarding(session: AdminSessionContext, body: unknown) {
    const input = parseOr400(onboardingStepSchema, body);
    const db = tenantDb(session.tenantId);

    // Read-modify-write of the single `settings` JSON column — no
    // transaction needed: it's one row, one UPDATE, and the last write for a
    // given tenant+step wins, which matches the wizard's own UX (a step form
    // re-submitted overwrites its own prior values).
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: session.tenantId } });
    const settings = { ...asRecord(tenant.settings) };
    const onboarding = { ...asRecord(settings.onboarding as Prisma.JsonValue | undefined) };
    onboarding[input.step] = { done: true, completedAt: new Date().toISOString() };
    settings.onboarding = onboarding;

    if (input.step === 'store_info' && input.data !== undefined) {
      // Re-parse through the per-step schema (already validated inside
      // onboardingStepSchema's superRefine) to strip any extra keys the
      // caller sent beyond the four documented store_info fields, rather
      // than merging the raw `data` record verbatim into settings.storeInfo.
      const parsed = storeInfoDataSchema.parse(input.data);
      settings.storeInfo = { ...asRecord(settings.storeInfo as Prisma.JsonValue | undefined), ...parsed };
    }
    if (input.step === 'payments' && input.data !== undefined) {
      const parsed = paymentsDataSchema.parse(input.data);
      settings.payments = { ...asRecord(settings.payments as Prisma.JsonValue | undefined), ...parsed };
    }

    const updated = await db.tenant.update({
      where: { id: session.tenantId },
      data: { settings: settings as Prisma.InputJsonValue },
    });

    await writeAudit(session, 'onboarding.step', 'Tenant', session.tenantId, input);

    return { steps: asRecord(updated.settings).onboarding ?? {} };
  }
}
