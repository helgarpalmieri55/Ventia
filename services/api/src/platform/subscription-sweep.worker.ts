import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { Prisma, platformDb } from '@ventia/db';
import { MAILER, type Mailer } from '../mailer/mailer';
import { sendSubscriptionWarningEmail } from '../mailer/subscription-emails';
import { PlatformService } from './platform.service';
import { writePlatformAudit, SYSTEM_OPERATOR } from './platform-audit';
import { addDays, subscriptionGraceDays, warningLeadDaysPastDue, WARNING_LEAD_DAYS } from './subscription-window';

/**
 * Auto-suspend for unpaid subscriptions (docs/SPEC.md §6 M9: "auto-suspend N
 * days past due (configurable, default 7) with warning email at N-3"), phase
 * P6.
 *
 * Structurally a sibling of `payments/stock-reservation.worker.ts` and
 * `agent/conversation-retention.worker.ts`, on purpose: the sweep is a plain
 * exported function that tests call directly with no BullMQ and no Redis
 * involved, and {@link SubscriptionSweepWorker} at the bottom of this file is
 * the only thing that touches a queue.
 *
 * ## Cross-tenant read: why `platformDb` with no `SET LOCAL ROLE`
 *
 * The reasoning is `stock-reservation.worker.ts`'s, followed rather than
 * reinvented: a repeatable job has no request and therefore no tenant, and
 * "every overdue subscription on the platform" is a question a tenant-scoped
 * client cannot even express — there is no id to pass, and RLS would filter
 * the answer to nothing. `platformDb` connects as the schema owner, which
 * Postgres exempts from non-FORCE policies, so the candidate query below sees
 * every tenant's row with no bypass trick.
 *
 * The one thing that differs from those two workers: they follow the wide read
 * with per-tenant `SET LOCAL ROLE ventia_app` + `app.tenant_id` transactions,
 * to NARROW their writes as defence in depth. That is not available here and
 * would be actively wrong if it were — `ventia_app` has ALL PRIVILEGES REVOKED
 * on `Subscription` (migration 20260819170000_subscription_platform_owned),
 * because a merchant-reachable write to `paidUntil` would be a merchant
 * granting themselves free service. The narrowing that replaces it is that
 * this sweep never writes to `Subscription` at all: it reads that table and
 * writes only to `Tenant.status` (through `PlatformService`, one tenant at a
 * time, by primary key) and `NotificationLog`.
 *
 * No `tenantDb()` is called anywhere in this file, and in particular never
 * from inside an open `platformDb.$transaction()` — that takes a second pool
 * connection while holding one and deadlocks under load (the `ShippingConfig`
 * bug documented in checkout/shipping.service.ts, measured at 93 of 100
 * concurrent checkouts failing).
 *
 * ## What this job will NOT do
 *
 * 1. **It never suspends a tenant with no `Subscription` row.** Not by a
 *    filter that could be dropped — structurally: the candidate query reads
 *    FROM `Subscription`, so a tenant nobody has recorded a payment for is not
 *    a row this job can see. That is the correct reading of the state, not a
 *    concession. "No subscription recorded" means nobody has entered this
 *    merchant into the billing book yet — a pilot store, a tenant created
 *    before this feature shipped, a signup an operator has not processed. It
 *    does not mean "has not paid". On the day this ships, EVERY existing
 *    tenant is in that state, and a job that read it as delinquency would take
 *    the entire platform offline in its first run.
 * 2. **It never suspends a tenant whose `paidUntil` is null.** Same reasoning
 *    one level down: a subscription recorded with a plan and a price but no
 *    date is "we know what they owe, nobody has paid yet" — an incomplete
 *    record, not a lapsed one. `NULL < cutoff` is false in SQL anyway; the
 *    explicit `not: null` in the query is there to say it was meant.
 * 3. **It never touches a tenant that is not `live`.** An already-`suspended`
 *    tenant is skipped, which is the idempotency that keeps a daily job from
 *    re-suspending (and re-auditing) the same store forever. A `draft` tenant
 *    is skipped because suspending one would be worse than useless: it is not
 *    serving anybody, and `POST /reactivate` refuses to un-suspend anything
 *    that is not `suspended`, so the eventual "undo" would silently LAUNCH a
 *    store whose owner never finished onboarding.
 *
 * Every one of those is the same choice: when the state is ambiguous, do not
 * take a store offline.
 */

/**
 * Hourly.
 *
 * The thresholds are measured in days, so a daily cadence would be
 * proportionate — `conversation-retention.worker.ts` reasons exactly that way
 * about a window measured in months. Hourly instead, for two reasons specific
 * to this job. It bounds how long a store keeps selling past its suspension
 * date at one hour rather than one day, which matters because the whole point
 * of the deadline is that service stops when payment does. And the reverse:
 * the moment an operator records a late payment, the merchant's next hour is
 * the longest they can be wrongly suspended... which they are not, because
 * recording a payment does not reactivate — see `SubscriptionService.record`.
 *
 * The cost of the higher cadence is two indexed queries against a table with
 * one row per tenant. Repeated runs are free of side effects: the warning is
 * claimed through a unique key and the suspension is guarded by `status`.
 */
const SWEEP_INTERVAL_MS = 60 * 60_000;

const QUEUE_NAME = 'subscription-sweep';
const JOB_NAME = 'sweep';
/** Fixed id for the repeatable job REGISTRATION (not a per-run id — BullMQ
 * generates those), so a restart re-registers the same schedule instead of
 * accumulating a second one. */
const REPEAT_JOB_ID = 'subscription-sweep';

/**
 * Most subscriptions either pass may act on in one run.
 *
 * Same reasoning as `EXPIRE_BATCH_LIMIT` (stock-reservation.worker.ts):
 * nothing is dropped, only deferred to the next run an hour later. The bound
 * matters most on the first run after this feature is switched on for a
 * platform with a backlog of overdue merchants, and on the first run after an
 * outage — the two runs with the most to do and the least margin.
 *
 * Ordered oldest-`paidUntil`-first so a truncated run always drains the FRONT
 * of the backlog rather than an arbitrary page.
 */
const SWEEP_BATCH_LIMIT = 500;

/** `NotificationLog.template` for the warning — the string the idempotency key
 * is built from, and what an operator greps for. */
export const WARNING_TEMPLATE = 'subscription_due_warning';

export interface SubscriptionSweepResult {
  /** Tenants suspended by this run. */
  suspended: number;
  /** Warning emails actually sent by this run. */
  warned: number;
  /** Candidates in the warning window whose warning was already sent for this
   * billing cycle — the number that proves the idempotency is working. */
  warningsAlreadySent: number;
  /** Warning candidates with nobody to email. */
  warningsUndeliverable: number;
  /** Per-tenant failures, in either pass. Logged, never fatal. */
  failures: number;
  graceDays: number;
  /** `paidUntil` older than this is suspendable. */
  suspendCutoff: Date;
  /** `paidUntil` older than this is warnable. */
  warnCutoff: Date;
  /** True when either pass hit {@link SWEEP_BATCH_LIMIT}. */
  cappedOut: boolean;
}

export interface SubscriptionSweepDeps {
  mailer: Mailer;
  /** The real `PlatformService`, not a shim: its `suspendForNonPayment` is
   * what evicts the storefront's tenant-resolution cache, which is the only
   * reason a suspension reaches shoppers inside SPEC §6 M9's 60 s. */
  platform: Pick<PlatformService, 'suspendForNonPayment'>;
}

/**
 * The testable sweep. Warns first, then suspends.
 *
 * The two passes read DISJOINT windows — warnable is `[warnCutoff,
 * suspendCutoff)`, suspendable is everything older than `suspendCutoff` — so a
 * tenant is never warned and suspended in the same run. The honest consequence,
 * stated rather than hidden: if this job does not run for longer than the
 * three-day notice period (a long outage, or the feature being switched on for
 * an already-overdue merchant), a tenant can cross the whole window while
 * nothing is watching and be suspended without ever receiving the warning
 * email. The alternative — sending "your store will be suspended in three
 * days" to somebody whose grace period expired last week — is a false
 * statement, and the due date the merchant agreed to is the contract; the
 * email is a courtesy on top of it.
 */
export async function sweepSubscriptions(
  deps: SubscriptionSweepDeps,
  now: Date = new Date(),
): Promise<SubscriptionSweepResult> {
  const graceDays = subscriptionGraceDays();
  const suspendCutoff = addDays(now, -graceDays);
  const warnCutoff = addDays(now, -warningLeadDaysPastDue(graceDays));

  const result: SubscriptionSweepResult = {
    suspended: 0,
    warned: 0,
    warningsAlreadySent: 0,
    warningsUndeliverable: 0,
    failures: 0,
    graceDays,
    suspendCutoff,
    warnCutoff,
    cappedOut: false,
  };

  // ---- pass 1: warnings ---------------------------------------------------
  const warnable = await platformDb.subscription.findMany({
    where: {
      paidUntil: { not: null, lt: warnCutoff, gte: suspendCutoff },
      // Only live stores. See "What this job will NOT do", point 3.
      tenant: { status: 'live' },
    },
    select: {
      tenantId: true,
      paidUntil: true,
      priceCents: true,
      tenant: { select: { name: true, settings: true } },
    },
    orderBy: { paidUntil: 'asc' },
    take: SWEEP_BATCH_LIMIT,
  });

  for (const row of warnable) {
    // Non-null by the query's own predicate; narrowed for the type system.
    const paidUntil = row.paidUntil!;
    try {
      const outcome = await warnOne(deps.mailer, {
        tenantId: row.tenantId,
        tenantName: row.tenant.name,
        settings: row.tenant.settings,
        priceCents: row.priceCents,
        paidUntil,
        suspendsOn: addDays(paidUntil, graceDays),
      });
      if (outcome === 'sent') result.warned++;
      else if (outcome === 'already_sent') result.warningsAlreadySent++;
      else result.warningsUndeliverable++;
    } catch (err) {
      // One tenant's failure never aborts the sweep — the deliberate choice
      // both sibling workers make, for the same reason: this loop spans every
      // store on the platform, and one bad row blocking everyone else's
      // warning (and, next pass, everyone else's suspension) is far worse than
      // logging it and moving on. The candidate is still a candidate next run.
      result.failures++;
      console.error('[subscription-sweep] failed to warn a tenant, continuing sweep', {
        tenantId: row.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- pass 2: suspensions ------------------------------------------------
  const suspendable = await platformDb.subscription.findMany({
    where: {
      paidUntil: { not: null, lt: suspendCutoff },
      tenant: { status: 'live' },
    },
    select: { tenantId: true, paidUntil: true },
    orderBy: { paidUntil: 'asc' },
    take: SWEEP_BATCH_LIMIT,
  });

  for (const row of suspendable) {
    const paidUntil = row.paidUntil!;
    try {
      await deps.platform.suspendForNonPayment(row.tenantId, { paidUntil, graceDays });
      result.suspended++;
    } catch (err) {
      result.failures++;
      console.error('[subscription-sweep] failed to suspend a tenant, continuing sweep', {
        tenantId: row.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  result.cappedOut = warnable.length === SWEEP_BATCH_LIMIT || suspendable.length === SWEEP_BATCH_LIMIT;
  if (result.cappedOut) {
    // Never truncate silently: hitting the cap means there are overdue
    // merchants this run did not reach, and the only way to tell a healthy
    // sweep from a saturated one is to say so.
    console.warn('[subscription-sweep] hit the batch limit — remainder deferred to the next run', {
      limit: SWEEP_BATCH_LIMIT,
    });
  }

  return result;
}

type WarnOutcome = 'sent' | 'already_sent' | 'undeliverable';

interface WarnContext {
  tenantId: string;
  tenantName: string;
  settings: Prisma.JsonValue;
  priceCents: number;
  paidUntil: Date;
  suspendsOn: Date;
}

/**
 * One tenant's warning, sent at most once per billing cycle.
 *
 * ## How "already warned" is known, without a new column
 *
 * `NotificationLog` — the table SPEC §6 M10 already defines for exactly this
 * ("no notification is ever sent twice for the same event (idempotency key =
 * order_event_id + template)"), with a UNIQUE constraint on `idempotencyKey`
 * enforcing it in the database rather than in a read-then-write that two runs
 * could interleave through. A `warningSentAt` column on `Subscription` would
 * have been a second, weaker mechanism for a problem this schema already
 * solves, and one an operator editing the subscription could clobber.
 *
 * The key is `subscription:<tenantId>:<template>:<paidUntil>`. Binding it to
 * `paidUntil` is what makes it a per-CYCLE key rather than a per-tenant one:
 * when the merchant pays and an operator moves the date forward, the key
 * changes and a future warning for the NEW cycle can be sent — while re-saving
 * the same date (an operator fixing a typo in `notes`) does not re-warn.
 *
 * ## Failed sends are retried; delivered ones are never repeated
 *
 * The row is claimed as `pending` BEFORE the send. On success it becomes
 * `sent` and no later run can claim it again. On failure it becomes `failed`,
 * which the claim treats as re-claimable — so a mail outage costs a day of
 * notice, not the entire warning. The trade this accepts: a send that reached
 * the provider and then failed on the way back would be re-sent, i.e. a
 * duplicate email. A duplicate warning is a nuisance; a store going dark with
 * no warning at all is the failure this feature exists to prevent.
 */
async function warnOne(mailer: Mailer, ctx: WarnContext): Promise<WarnOutcome> {
  const resolved = await resolveBillingRecipient(ctx.tenantId, ctx.settings);
  if (!resolved) {
    // No invented fallback address, same rule as the merchant new-order alert
    // in order-emails.ts. Loud, because a merchant about to be suspended with
    // nobody to notify is something an operator should fix before the sweep
    // takes the store down.
    console.warn('[subscription-sweep] no billing recipient for tenant — warning not sent', {
      tenantId: ctx.tenantId,
    });
    return 'undeliverable';
  }

  const idempotencyKey = warningKey(ctx.tenantId, ctx.paidUntil);
  const claimed = await claimWarning(ctx.tenantId, idempotencyKey, resolved);
  if (!claimed) return 'already_sent';

  try {
    await sendSubscriptionWarningEmail(mailer, {
      to: resolved,
      tenantName: ctx.tenantName,
      priceCents: ctx.priceCents,
      paidUntil: ctx.paidUntil,
      suspendsOn: ctx.suspendsOn,
    });
  } catch (err) {
    await platformDb.notificationLog
      .update({ where: { idempotencyKey }, data: { status: 'failed' } })
      .catch(() => undefined);
    throw err;
  }

  await platformDb.notificationLog.update({ where: { idempotencyKey }, data: { status: 'sent' } });

  // The warning is also audited, so the one query that answers "what did the
  // platform do to this merchant, and when" covers the notice as well as the
  // suspension it precedes. Never throws (see writePlatformAudit).
  await writePlatformAudit(SYSTEM_OPERATOR, 'platform.tenant.subscription_warned', ctx.tenantId, {
    recipient: resolved,
    paidUntil: ctx.paidUntil.toISOString(),
    suspendsOn: ctx.suspendsOn.toISOString(),
    warningLeadDays: WARNING_LEAD_DAYS,
  });

  return 'sent';
}

/** `subscription:<tenantId>:<template>:<paidUntil>` — see {@link warnOne}. */
export function warningKey(tenantId: string, paidUntil: Date): string {
  return `subscription:${tenantId}:${WARNING_TEMPLATE}:${paidUntil.toISOString()}`;
}

/**
 * Claims the right to send this warning. Returns false when somebody already
 * sent it (or is sending it right now).
 *
 * The INSERT is the claim: `NotificationLog.idempotencyKey` is unique, so two
 * concurrent runs cannot both win. A losing insert is not automatically a
 * "no" — if the previous attempt ended `failed`, the conditional update below
 * re-claims it, and that update is itself the atomic step (only one run can
 * match `status: 'failed'` and flip it to `pending`).
 */
async function claimWarning(tenantId: string, idempotencyKey: string, recipient: string): Promise<boolean> {
  try {
    await platformDb.notificationLog.create({
      data: {
        tenantId,
        channel: 'email',
        template: WARNING_TEMPLATE,
        recipient,
        idempotencyKey,
        status: 'pending',
        attempts: 1,
      },
    });
    return true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const reclaimed = await platformDb.notificationLog.updateMany({
      where: { idempotencyKey, status: 'failed' },
      data: { status: 'pending', recipient, attempts: { increment: 1 } },
    });
    return reclaimed.count === 1;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Who gets the billing warning.
 *
 * The tenant OWNER's account email, not `settings.storeInfo.contactEmail`.
 * They are different addresses answering different questions: the store's
 * contact email is published to shoppers (it goes on the privacy policy and in
 * order notifications) and may be a shared inbox nobody with a bank login
 * reads. The owner's account email is the person who signed the store up, is
 * verified by the auth flow, and is the party to the commercial relationship
 * this email is about.
 *
 * `storeInfo.contactEmail` is kept as a FALLBACK for the case where the owner
 * membership is missing (a tenant seeded outside the onboarding flow), because
 * some address is better than none when the alternative is a silent
 * suspension. Returns null if neither exists, and the caller says so loudly.
 *
 * Reads `Membership`, which is one of the tables `ventia_app` cannot touch at
 * all — another reason this job stays on `platformDb`.
 */
async function resolveBillingRecipient(tenantId: string, settings: Prisma.JsonValue): Promise<string | null> {
  const owner = await platformDb.membership.findFirst({
    where: { tenantId, role: 'owner' },
    // Oldest first: the founding owner, the same tie-break `getSessionContext`
    // uses, so this picks a stable address rather than whichever co-owner was
    // added last.
    orderBy: { createdAt: 'asc' },
    select: { user: { select: { email: true } } },
  });
  if (owner?.user.email) return owner.user.email;

  const storeInfo =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).storeInfo
      : null;
  const contactEmail =
    storeInfo && typeof storeInfo === 'object' && !Array.isArray(storeInfo)
      ? (storeInfo as Record<string, unknown>).contactEmail
      : null;
  return typeof contactEmail === 'string' && contactEmail.trim().length > 0 ? contactEmail.trim() : null;
}

/**
 * Thin BullMQ wrapper around {@link sweepSubscriptions} — registered as an
 * ordinary provider in `platform.module.ts`, but its `start()` method is called
 * from EXACTLY ONE place: `main.ts`'s `if (require.main === module)` real-boot
 * block, after `createApp()` + `app.listen(...)`.
 *
 * ## Why this must not implement `OnModuleInit`
 *
 * Verbatim the reasoning on `StockReservationWorker` and
 * `ConversationRetentionWorker`, and the consequence here is the loudest of
 * the three: `createApp()` is the factory every test file in this repo calls,
 * and Nest's `app.init()` runs `onModuleInit`/`onApplicationBootstrap` on every
 * provider in the graph. A subscription sweep started from a lifecycle hook
 * would SUSPEND TENANTS in the background of unrelated test suites — and, in
 * production, would start suspending stores from inside any process that
 * happened to build the module graph.
 *
 * So this class implements NEITHER hook. `start()` is an ordinary public
 * method nothing calls except main.ts's real-boot branch, which no test's
 * import graph reaches. `OnModuleDestroy` IS implemented and is a safe no-op
 * if `start()` was never called.
 */
@Injectable()
export class SubscriptionSweepWorker implements OnModuleDestroy {
  private connection: Redis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  // Explicit @Inject: esbuild does not emit `design:paramtypes`.
  constructor(
    @Inject(PlatformService) private readonly platform: PlatformService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async start(): Promise<void> {
    // A DEDICATED ioredis connection with `maxRetriesPerRequest: null` — BullMQ's
    // documented requirement, not a reuse of app.module.ts's REDIS_CLIENT, for
    // the reasons spelled out in stock-reservation.worker.ts's identical block.
    const connectionOptions: ConnectionOptions = { maxRetriesPerRequest: null };
    this.connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', connectionOptions);
    this.connection.on('error', (err) => console.error('[subscription-sweep] redis error', err.message));

    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
    await this.queue.add(JOB_NAME, {}, { repeat: { every: SWEEP_INTERVAL_MS }, jobId: REPEAT_JOB_ID });

    this.worker = new Worker(
      QUEUE_NAME,
      async () => {
        const result = await sweepSubscriptions({ mailer: this.mailer, platform: this.platform });
        // Always logged, including an empty run: a job that can take a
        // merchant's store offline must leave evidence that it ran and found
        // nothing, so "no suspensions last week" and "the sweep was dead last
        // week" are distinguishable a month later.
        console.log('[subscription-sweep] sweep complete', {
          graceDays: result.graceDays,
          suspended: result.suspended,
          warned: result.warned,
          warningsAlreadySent: result.warningsAlreadySent,
          warningsUndeliverable: result.warningsUndeliverable,
          failures: result.failures,
          cappedOut: result.cappedOut,
        });
      },
      { connection: this.connection },
    );
    this.worker.on('failed', (job, err) => {
      console.error('[subscription-sweep] sweep job failed', { jobId: job?.id, error: err.message });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    if (this.connection) {
      try {
        await this.connection.quit();
      } catch {
        this.connection.disconnect();
      }
    }
  }
}
