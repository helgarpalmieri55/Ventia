import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { platformDb } from '@ventia/db';

/**
 * Ley 1581 (Habeas Data) retention purge for agent conversations — the job
 * `docs/SPEC.md` §9 requires ("agent conversations covered by the same
 * retention/purge policy") and §7 names ("Retention: 12 months, then purge
 * job").
 *
 * A `Conversation` + its `Message` rows are the highest-PII-density table pair
 * in this schema and the only one whose contents nobody controls: a shopper
 * types their name, their address, their cédula, their phone number into a
 * chat box because the agent asked a question that invited it. Orders at least
 * have a fixed shape that the anonymisation flow can strip field by field;
 * a transcript does not, so the only defensible treatment is deletion of the
 * whole row.
 *
 * ## The default: 12 months, and why it is per DEPLOYMENT, not per tenant
 *
 * `AGENT_RETENTION_MONTHS` (see .env.example). Deliberately NOT a per-tenant
 * setting, though every neighbouring knob in this codebase is:
 *
 *  - The data subject here is the SHOPPER, not the merchant. Ley 1581 makes
 *    the *responsable del tratamiento* — the platform operator, jointly with
 *    the store — answerable for keeping personal data no longer than the
 *    purpose requires. A merchant-editable retention window is a merchant
 *    editing their own compliance obligation, and the person who bears the
 *    consequence never gets a vote.
 *  - The obvious home for a per-tenant value would be `Tenant.settings`, which
 *    is writable by any store owner through the settings API. A knob a
 *    merchant can raise to 600 months is not a retention policy, it is an
 *    opt-out with extra steps.
 *  - A deployment-level env var still covers the real variation: a Ventia
 *    instance run for a sector with a different statutory floor changes one
 *    variable, and it changes for every tenant on that instance at once,
 *    which is exactly the granularity the obligation actually has.
 *
 * If a per-tenant window is ever genuinely needed (e.g. a merchant contracting
 * for a SHORTER one than the platform default), the shape that stays safe is a
 * per-tenant override clamped to `<= AGENT_RETENTION_MONTHS` — never above it.
 * That is a deliberate non-goal here, not an oversight.
 */
const DEFAULT_RETENTION_MONTHS = 12;

/**
 * Daily. The window this job enforces is measured in months, so a 24-hour
 * cadence bounds how long a row can outlive its retention by at 24 hours —
 * proportionate, and orders of magnitude cheaper than the minute-scale sweeps
 * in payments/, whose deadlines are measured in minutes.
 */
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

const QUEUE_NAME = 'conversation-retention';
const JOB_NAME = 'sweep';
// A fixed, stable job id for the repeatable job REGISTRATION (not a per-run
// id — BullMQ generates those), so a process restart re-registers the SAME
// repeatable job instead of accumulating a second, independent schedule.
const REPEAT_JOB_ID = 'conversation-retention-sweep';

/**
 * The retention window in months, from env, with the same posture as
 * `RATE_LIMITS` in common/rate-limit.ts: optional, and a malformed value falls
 * back to the default rather than being propagated.
 *
 * The failure modes this guards are asymmetric and both bad, which is why
 * neither `NaN` nor `0` is allowed through:
 *
 *  - `NaN` months would make the cutoff an Invalid Date, every comparison
 *    against it false, and the purge a silent no-op — a compliance job that
 *    reports success while retaining everything forever.
 *  - `0` (or a negative) would put the cutoff at or after "now" and purge
 *    every conversation on the platform, including this morning's.
 *
 * So: integer, strictly positive, or the default.
 */
export function retentionMonths(): number {
  const raw = process.env.AGENT_RETENTION_MONTHS;
  if (raw === undefined) return DEFAULT_RETENTION_MONTHS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_MONTHS;
}

/**
 * `from` minus `months`, clamped to the last day of the target month.
 *
 * `Date.setUTCMonth(m - 12)` alone is *almost* right and wrong in one place:
 * 29 February minus 12 months is 29 February of a non-leap year, which
 * Postgres-style date arithmetic clamps to the 28th and JavaScript rolls
 * forward to 1 March. Rolling FORWARD moves the cutoff later, i.e. purges data
 * that is one day short of the retention window. One day early on one date a
 * year is not a catastrophe, but "delete personal data slightly before you are
 * allowed to" is the wrong direction to be sloppy in, and clamping costs three
 * lines.
 */
export function retentionCutoff(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  // Park on the 1st first so the month subtraction itself cannot roll over.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  // Day 0 of the NEXT month is the last day of this one.
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return d;
}

/**
 * The one status this sweep will never delete, at any age.
 *
 * ## Which status actually means "open"
 *
 * Grepped rather than assumed. `Conversation.status` is a free `String` with
 * exactly three values written anywhere in this repo:
 *
 *  - `'open'`   — the value every conversation is CREATED with, on both
 *                 channels (agent.service.ts:368, whatsapp-inbound.service.ts:140).
 *  - `'escalated'` — set by the `escalate_to_human` tool
 *                 (agent-tools.service.ts:418). This is the one that means a
 *                 human owes the shopper an answer: it is what the merchant's
 *                 "sin atender" count in conversations.controller.ts counts.
 *  - `'resolved'` — set only by the merchant clicking "marcar como atendida"
 *                 (conversations.controller.ts:132).
 *
 * Nothing ever moves a conversation OUT of `'open'`. There is no close, no
 * timeout, no end-of-session transition — `'open'` is the terminal state of
 * essentially every conversation this platform will ever store. So a purge
 * that skipped `'open'` rows would purge approximately nothing, and the Ley
 * 1581 obligation this file exists to discharge would be satisfied on paper
 * and violated in the database. That is the failure mode worth avoiding: not
 * deleting too much, but shipping a retention job that retains everything.
 *
 * What the requirement is actually protecting — "an escalated-but-unresolved
 * handoff must not vanish out from under the merchant" — is `'escalated'`, and
 * `'escalated'` is protected here unconditionally, regardless of age. A
 * merchant who has not answered a handoff in 12 months still has it waiting.
 *
 * The rest of the "don't delete something still in use" job is done by the
 * ACTIVITY cutoff below rather than by status, which is strictly stronger than
 * a status check would be: see {@link purgeExpiredConversations}.
 */
const PROTECTED_STATUS = 'escalated';

/**
 * Conversations examined per batch, and the ceiling for one run.
 *
 * Same reasoning as `EXPIRE_BATCH_LIMIT` (stock-reservation.worker.ts) and
 * `RECONCILE_BATCH_LIMIT` (reconciliation.worker.ts): nothing is dropped, only
 * deferred to the next daily run. The specific hazard here is that this sweep
 * runs against the OLDEST data on the platform, so the very first run after
 * this ships — or the first run after a long outage — faces the entire
 * accumulated backlog at once. An unbounded `deleteMany` over a year of
 * messages is a single statement holding row locks on a table the live agent
 * is concurrently inserting into; the batching is what keeps each transaction
 * short enough that a shopper mid-chat never waits on it.
 *
 * Ordered oldest-first so a truncated run always drains the FRONT of the
 * backlog — the rows that have been retained unlawfully the longest.
 */
const PURGE_BATCH_SIZE = 200;
const PURGE_MAX_PER_RUN = 2_000;

export interface PurgeResult {
  conversationsDeleted: number;
  messagesDeleted: number;
  /** How many distinct tenants had at least one conversation purged. */
  tenantsAffected: number;
  /** True if the run stopped at {@link PURGE_MAX_PER_RUN} with candidates left. */
  cappedOut: boolean;
  /** The instant older-than which conversations were eligible. */
  cutoff: Date;
}

/**
 * The testable sweep: deletes every tenant's `Conversation` (and its
 * `Message` rows) that has been inactive longer than the retention window.
 *
 * Exported as a plain function — deliberately NOT a method that also starts
 * the BullMQ scheduling machinery — so tests call it directly (see
 * test/conversation-retention.test.ts) without ever constructing a real
 * `Queue`/`Worker` against a Redis connection. This mirrors
 * stock-reservation.worker.ts exactly, including the
 * {@link ConversationRetentionWorker} class below being the ONLY thing in this
 * file that touches BullMQ and never being auto-started by Nest's module
 * lifecycle.
 *
 * ## Eligibility: inactivity, not `startedAt`
 *
 * "Older than 12 months" cannot mean `startedAt < cutoff` on its own, and the
 * reason is specific to how WhatsApp conversations work here:
 * `whatsapp-inbound.service.ts`'s `resolveConversation` REUSES the most recent
 * non-`resolved` conversation for a returning shopper forever ("on WhatsApp
 * the thread IS the history"). A loyal customer of a store that has been live
 * for two years is therefore writing into a `Conversation` row whose
 * `startedAt` is two years old — and a `startedAt`-only sweep would delete a
 * live thread out from under an in-progress chat.
 *
 * So a conversation is eligible only when BOTH:
 *   - it was started before the cutoff, AND
 *   - it has no message at all after the cutoff (`messages: { none: ... }`,
 *     which Prisma compiles to a `NOT EXISTS` subquery).
 *
 * The second condition is what "12 months since this shopper's data was last
 * used for the purpose it was collected for" actually means, and it subsumes
 * any status-based liveness check: a conversation someone is still talking in
 * is never eligible no matter what its status column says.
 *
 * ## Cross-tenant read: why no `SET LOCAL ROLE` on the candidate query
 *
 * Identical to the reasoning documented at length in
 * stock-reservation.worker.ts, and it applies here even more strongly: a
 * retention sweep is platform-wide by definition — a BullMQ job has no request
 * context and no tenant, and the obligation is the operator's across every
 * store at once. `platformDb`'s connection identity is the table owner
 * (`packages/db/src/index.ts` documents it as "Owner connection — bypasses
 * RLS. Platform-admin/system use only"), and the RLS policies in
 * `20260723182728_rls/migration.sql` are plain `CREATE POLICY` without `FORCE
 * ROW LEVEL SECURITY`, which Postgres never applies to a table's owner. So the
 * candidate `findMany` below already sees every tenant's rows with no role
 * switch and no bypass trick. Switching to `ventia_app` and setting one
 * `app.tenant_id` would scope it to a single tenant — the opposite of what a
 * platform-wide sweep needs.
 *
 * The per-tenant `SET LOCAL ROLE` + `set_config` inside
 * {@link purgeTenantBatch} is therefore NOT about widening visibility (this
 * connection already has all of it). It is about NARROWING the WRITES to one
 * tenant, so that a future bug in this file's `where` clauses cannot delete
 * another store's transcripts — RLS as defence in depth on a `DELETE`, exactly
 * as `orders.service.ts`'s `transition()` and `payments.service.ts`'s
 * `markPaid` do for their own writes.
 *
 * ## No `tenantDb()` inside the transaction
 *
 * Everything inside `platformDb.$transaction()` below goes through the `tx`
 * client. A `tenantDb()` call issued while a transaction is open needs a
 * SECOND connection out of the same Prisma pool while the first is still held,
 * which deadlocks under a burst wider than the pool — the bug documented on
 * `ShippingConfig` in checkout/shipping.service.ts (measured at 100 concurrent
 * checkouts: 50 connections idle-in-transaction, 0 active). Nothing in this
 * file may reintroduce it; the per-tenant grouping is done in memory, BEFORE
 * any transaction opens.
 */
export async function purgeExpiredConversations(now: Date = new Date()): Promise<PurgeResult> {
  const months = retentionMonths();
  const cutoff = retentionCutoff(now, months);

  const result: PurgeResult = {
    conversationsDeleted: 0,
    messagesDeleted: 0,
    tenantsAffected: 0,
    cappedOut: false,
    cutoff,
  };
  const tenantsSeen = new Set<string>();

  while (result.conversationsDeleted < PURGE_MAX_PER_RUN) {
    const remaining = PURGE_MAX_PER_RUN - result.conversationsDeleted;
    const take = Math.min(PURGE_BATCH_SIZE, remaining);

    const candidates = await platformDb.conversation.findMany({
      where: {
        startedAt: { lt: cutoff },
        status: { not: PROTECTED_STATUS },
        messages: { none: { createdAt: { gte: cutoff } } },
      },
      select: { id: true, tenantId: true },
      orderBy: { startedAt: 'asc' },
      take,
    });

    if (candidates.length === 0) break;

    // Group in memory, before any transaction opens — see the "No tenantDb()
    // inside the transaction" note above. One transaction per tenant per
    // batch, so each `SET LOCAL ROLE ventia_app` + `app.tenant_id` pair scopes
    // exactly the deletes it covers.
    const byTenant = new Map<string, string[]>();
    for (const row of candidates) {
      const ids = byTenant.get(row.tenantId);
      if (ids) ids.push(row.id);
      else byTenant.set(row.tenantId, [row.id]);
    }

    let batchDeleted = 0;
    for (const [tenantId, ids] of byTenant) {
      try {
        const deleted = await purgeTenantBatch(tenantId, ids, cutoff);
        batchDeleted += deleted.conversations;
        result.conversationsDeleted += deleted.conversations;
        result.messagesDeleted += deleted.messages;
        if (deleted.conversations > 0) tenantsSeen.add(tenantId);
      } catch (err) {
        // One tenant's failure must never abort the whole sweep — same
        // deliberate choice as stock-reservation.worker.ts's per-order catch.
        // This loop spans every store on the platform, and one bad row
        // blocking every other tenant's lawful purge is a much worse outcome
        // than logging this one and continuing. Nothing was mutated for this
        // tenant (the whole per-tenant body runs in its own transaction, which
        // rolled back), so the same rows are candidates again on the next run.
        //
        // The error message is logged; the ROWS are not, and never should be —
        // this job exists because their contents are personal data.
        console.error('[conversation-retention] failed to purge a tenant batch, continuing sweep', {
          tenantId,
          candidates: ids.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Every candidate in this batch was re-validated away (a shopper wrote
    // back, or the agent escalated, between the SELECT and the DELETE) or
    // every tenant in it errored. Either way the same query would return the
    // same rows forever — stop rather than spin.
    if (batchDeleted === 0) break;

    // A short batch means the candidate query is drained; nothing left to do.
    if (candidates.length < take) break;
  }

  result.tenantsAffected = tenantsSeen.size;
  result.cappedOut = result.conversationsDeleted >= PURGE_MAX_PER_RUN;

  if (result.cappedOut) {
    // Never truncate silently: hitting the cap means personal data is still
    // being retained past its window somewhere in the remainder, and the only
    // way to tell a healthy nightly sweep from a persistently-saturated one is
    // to say so.
    console.warn('[conversation-retention] sweep hit its per-run cap — remainder deferred to the next run', {
      cap: PURGE_MAX_PER_RUN,
    });
  }

  return result;
}

/**
 * One tenant's slice of one batch, inside its own tenant-scoped transaction.
 *
 * Re-validates the candidates INSIDE the transaction before deleting anything,
 * for the same reason `expireOneReservation` re-reads the order inside its
 * advisory lock: the cross-tenant SELECT and this transaction are two separate
 * round trips, and in between,
 *
 *   - the shopper may have written a new message (the conversation is live
 *     again and must not be deleted mid-chat), or
 *   - the agent may have escalated it (`escalate_to_human` sets
 *     `status = 'escalated'`, and an unanswered handoff must never be purged).
 *
 * Re-running the exact eligibility predicate scoped to these ids costs one
 * indexed query and closes both races. Deleting straight from the candidate
 * id list would not.
 *
 * `Message` rows are deleted explicitly rather than left to the FK's
 * `onDelete: Cascade`. The cascade would do it correctly, but it reports
 * nothing — and a retention job whose log cannot say how many personal-data
 * rows it destroyed is not auditable, which for a Ley 1581 control is most of
 * the point. Both deletes are in one transaction, so the pair is still atomic.
 */
async function purgeTenantBatch(
  tenantId: string,
  candidateIds: string[],
  cutoff: Date,
): Promise<{ conversations: number; messages: number }> {
  return platformDb.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    const stillEligible = await tx.conversation.findMany({
      where: {
        id: { in: candidateIds },
        tenantId,
        startedAt: { lt: cutoff },
        status: { not: PROTECTED_STATUS },
        messages: { none: { createdAt: { gte: cutoff } } },
      },
      select: { id: true },
    });
    const ids = stillEligible.map((row) => row.id);
    if (ids.length === 0) return { conversations: 0, messages: 0 };

    const messages = await tx.message.deleteMany({ where: { tenantId, conversationId: { in: ids } } });
    const conversations = await tx.conversation.deleteMany({ where: { tenantId, id: { in: ids } } });

    return { conversations: conversations.count, messages: messages.count };
  });
}

/**
 * Thin BullMQ wrapper around {@link purgeExpiredConversations} — registered as
 * an ordinary provider in `agent.module.ts`, but its `start()` method is called
 * from EXACTLY ONE place: `main.ts`'s `if (require.main === module)` real-boot
 * block, AFTER `createApp()` + `app.listen(...)`.
 *
 * ## Why this must not implement `OnModuleInit`
 *
 * Verbatim the reasoning on `StockReservationWorker` in
 * stock-reservation.worker.ts, and it matters more here because of what this
 * job DOES. `createApp()` is the factory every test file in this repo calls,
 * and Nest's `app.init()` invokes `onModuleInit`/`onApplicationBootstrap` on
 * every provider in the graph. A retention worker started from a lifecycle
 * hook would mean every test run in this repo spins up a real repeatable job
 * that DELETES rows out of that test's own database in the background of
 * unrelated suites — the most confusing possible test flake, and one that
 * would look like a bug in whatever suite happened to be running.
 *
 * So this class implements NEITHER `OnModuleInit` nor
 * `OnApplicationBootstrap`. `start()` is an ordinary public method nothing
 * invokes except main.ts's real-boot branch, which no test's import graph
 * reaches. `OnModuleDestroy` IS implemented and is a safe no-op if `start()`
 * was never called.
 */
@Injectable()
export class ConversationRetentionWorker implements OnModuleDestroy {
  private connection: Redis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  async start(): Promise<void> {
    // A DEDICATED ioredis connection with `maxRetriesPerRequest: null`, not a
    // reuse of app.module.ts's REDIS_CLIENT — BullMQ's documented connection
    // requirement, for the reasons spelled out in stock-reservation.worker.ts's
    // identical block.
    const connectionOptions: ConnectionOptions = { maxRetriesPerRequest: null };
    this.connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', connectionOptions);
    this.connection.on('error', (err) => console.error('[conversation-retention] redis error', err.message));

    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
    await this.queue.add(JOB_NAME, {}, { repeat: { every: SWEEP_INTERVAL_MS }, jobId: REPEAT_JOB_ID });

    this.worker = new Worker(
      QUEUE_NAME,
      async () => {
        const result = await purgeExpiredConversations();
        // Always logged, including a zero run: for a compliance control, "the
        // sweep ran and found nothing due" and "the sweep did not run" must be
        // distinguishable in the logs a year later. Counts and tenant ids
        // only — never a single byte of what was purged.
        console.log('[conversation-retention] sweep complete', {
          cutoff: result.cutoff.toISOString(),
          retentionMonths: retentionMonths(),
          conversationsDeleted: result.conversationsDeleted,
          messagesDeleted: result.messagesDeleted,
          tenantsAffected: result.tenantsAffected,
          cappedOut: result.cappedOut,
        });
      },
      { connection: this.connection },
    );
    this.worker.on('failed', (job, err) => {
      console.error('[conversation-retention] sweep job failed', { jobId: job?.id, error: err.message });
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
