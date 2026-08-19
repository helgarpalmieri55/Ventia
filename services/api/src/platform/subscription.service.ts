import { HttpException, Injectable } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import type { RecordSubscriptionInput } from '@ventia/core';
import type { PlatformOperatorContext } from './platform-operator.decorator';
import { writePlatformAudit } from './platform-audit';
import { subscriptionView } from './platform.service';

/**
 * Manual subscription tracking (docs/SPEC.md §6 M9, §8) — the operator's side
 * of it. The other side is `subscription-sweep.worker.ts`, which acts on what
 * is recorded here.
 *
 * ## "v1 manual" is the whole design
 *
 * There is no payment processor in this flow and nothing here talks to one. A
 * merchant pays Ventia by bank transfer, an operator sees it, and records
 * "pagado hasta el 30 de septiembre". That recorded date is the ONLY input to
 * whether a store stays online, which is why this service is small, strict,
 * and audited: the interesting part of it is not the write, it is that the
 * write is the trigger for a store going dark seven days later.
 *
 * Reads and writes go through `platformDb` for the reason `PlatformService`'s
 * doc comment gives at length, plus one specific to this table: `ventia_app`
 * has ALL PRIVILEGES REVOKED on `Subscription` (migration
 * 20260819170000_subscription_platform_owned), so `tenantDb` physically cannot
 * reach it. That is deliberate — `paidUntil` is an enforcement input, and a
 * merchant-reachable write to it would be a merchant granting themselves free
 * service.
 */
@Injectable()
export class SubscriptionService {
  /**
   * Record or update THE subscription for a tenant — one row, upserted.
   *
   * `upsert` rather than create-then-update because "record a subscription"
   * and "update a subscription" are the same operator action performed at
   * different times, and the caller has no business knowing which one it is.
   * `tenantId` is unique, so there is no race in which two calls produce two
   * rows: the second one loses on the unique index and is retried as an update
   * by Postgres's own upsert. (Prisma surfaces a genuinely concurrent upsert
   * conflict as P2002; that is a 409-shaped event that has never been observed
   * for a surface one operator drives, and it is not swallowed here.)
   *
   * The tenant is looked up FIRST so an unknown id is a clean 404 rather than
   * a foreign-key violation surfacing as a 500.
   */
  async record(tenantId: string, input: RecordSubscriptionInput, operator: PlatformOperatorContext) {
    const tenant = await platformDb.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, status: true },
    });
    if (!tenant) throw new HttpException({ error: 'TENANT_NOT_FOUND' }, 404);

    const previous = await platformDb.subscription.findUnique({ where: { tenantId } });

    const saved = await platformDb.subscription.upsert({
      where: { tenantId },
      create: {
        tenantId,
        plan: input.plan,
        priceCents: input.priceCents,
        paidUntil: input.paidUntil,
        notes: input.notes,
      },
      update: {
        plan: input.plan,
        priceCents: input.priceCents,
        paidUntil: input.paidUntil,
        notes: input.notes,
      },
    });

    // Every mutation on this surface writes an audit row, same as plan
    // assignment and suspend/reactivate. Here it does double duty: because
    // `Subscription` holds only current state, this audit trail IS the payment
    // history — who moved `paidUntil`, from what, to what, and when. Recording
    // both sides of the change is what makes it one.
    await writePlatformAudit(operator, 'platform.tenant.subscription_recorded', tenantId, {
      plan: saved.plan,
      priceCents: saved.priceCents,
      paidUntil: saved.paidUntil?.toISOString() ?? null,
      notes: saved.notes,
      previous: previous
        ? {
            plan: previous.plan,
            priceCents: previous.priceCents,
            paidUntil: previous.paidUntil?.toISOString() ?? null,
            notes: previous.notes,
          }
        : null,
      created: previous === null,
    });

    return {
      tenantId,
      /** The tenant's CURRENT status, unchanged by this call. Recording a
       * payment does not reactivate a suspended store on its own — that is a
       * deliberate, separately-audited operator decision (`POST
       * .../reactivate`), because reactivating also has to be a choice
       * somebody made when the suspension was for abuse rather than for money.
       * Returning it here is what lets the admin UI say "registrado — la
       * tienda sigue suspendida, reactívala" instead of leaving the operator
       * to notice. */
      tenantStatus: tenant.status,
      subscription: subscriptionView(saved),
    };
  }

  /** The subscription on its own, for a UI that wants to refresh just this
   * panel. `null` (200, not 404) when nothing has been recorded: "this tenant
   * has no subscription on file" is a normal, expected answer to this
   * question, not a missing resource. */
  async get(tenantId: string) {
    const tenant = await platformDb.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) throw new HttpException({ error: 'TENANT_NOT_FOUND' }, 404);

    const row = await platformDb.subscription.findUnique({ where: { tenantId } });
    return { tenantId, subscription: row ? subscriptionView(row) : null };
  }
}
