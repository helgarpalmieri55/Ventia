# Operations runbook

Backups, the restore drill, and the concurrency load test — the two P6
Definition-of-Done items from [`SPEC.md` §11](SPEC.md#11-build-phases-claude-code-roadmap):
*"backups + restore drill — restore drill documented and executed"* and
*"load test (100 concurrent checkouts) — isolation suite green under load"*.

**What in this document was actually executed.** Everything under
[Restore drill](#restore-drill) and [Load test](#load-test) was run end to end
on the local dev stack, and the outputs pasted below are real, unedited runs —
not examples. Everything that was written but **not** exercised is called out
inline in a `> **Not exercised.**` block. The two biggest ones: offsite
(R2) upload has no implementation here at all, and the restore drill's
"recreate the roles in an empty cluster" branch never fired, because the
cluster it ran against already had them.

| Script | Purpose |
| --- | --- |
| [`scripts/backup.sh`](../scripts/backup.sh) | Take a verified logical backup (dump + roles + manifest + checksums). |
| [`scripts/restore-drill.sh`](../scripts/restore-drill.sh) | Restore a backup into a scratch database and prove it is usable. |
| [`scripts/load-test.mjs`](../scripts/load-test.mjs) | 100 concurrent checkouts; assert stock accounting and tenant isolation hold. |

Prerequisites for all three: the dev stack up (`docker compose -f docker/compose.yaml up -d`),
migrations applied, and `psql` / `pg_dump` / `pg_restore` (PostgreSQL client 16+)
plus `jq` on `PATH`.

---

## Backups

```bash
bash scripts/backup.sh
BACKUP_DIR=/mnt/backups BACKUP_RETENTION_DAYS=30 bash scripts/backup.sh
```

Each run writes four files sharing one timestamped basename:

| File | Contents |
| --- | --- |
| `<base>.dump` | `pg_dump --format=custom` of the database. |
| `<base>.globals.sql` | `pg_dumpall --globals-only` — the **cluster-wide roles**. |
| `<base>.manifest.json` | Row counts per table, policy count + digest, migration count, server version. |
| `<base>.sha256` | Checksums of the three files above. |

**Why the globals file is not optional.** `pg_dump` dumps one database and
deliberately omits roles. Every RLS policy in this schema is written against
the `ventia_app` role
([`20260723182728_rls`](../packages/db/prisma/migrations/20260723182728_rls/migration.sql)),
and [`packages/db/src/tenant-client.ts`](../packages/db/src/tenant-client.ts)
reaches it with `SET LOCAL ROLE` on every tenant-scoped query. Restoring the
`.dump` alone into a cluster that has never seen `ventia_app` fails on the
first `GRANT` — and the tempting "just skip the grants" workaround produces a
database that comes up looking healthy with tenant isolation switched off.
`backup.sh` refuses to keep a globals dump that does not contain
`CREATE ROLE ventia_app`.

**Why the manifest exists.** The restore drill compares the restored database
against these recorded numbers. Row counts are taken *before and after* the
dump; if they differ, `sourceQuiescent` is set to `false` and the drill
downgrades its row-count comparison to advisory rather than reporting a false
failure — `pg_dump`'s snapshot is consistent, but it is a snapshot of an
instant this script cannot observe from outside.

**Verification at backup time.** The dump is parsed with `pg_restore --list`
before it is kept; a truncated or corrupt archive fails during the backup
rather than during an incident.

**Retention.** `BACKUP_RETENTION_DAYS` (default 30, per SPEC.md §10) prunes
older runs. Pruning is scoped to this script's own `ventia-*` filename prefix,
so pointing `BACKUP_DIR` at a shared directory cannot delete a bystander's
files. Verified: a file backdated 45 days was deleted, an unrelated
`not-ours-keepme.dump` of the same age was not.

**Default output directory** is `${TMPDIR:-/tmp}/ventia-backups`, deliberately
outside the repo — `.gitignore` has no entry for a backup directory and the
repository must not accrue multi-megabyte dumps as untracked files.

Real output from a run against the dev database:

```
==> Source: postgresql://ventia:ventia@localhost:5432/ventia (database 'ventia')
==> Server: PostgreSQL 16.14 (Debian 16.14-1.pgdg12+1) ...
==> Counting rows (pre-dump)...
==> pg_dump (custom format)...
==> pg_dumpall --globals-only (roles + cluster grants)...
==> Counting rows (post-dump)...
==> Verifying the dump is readable (pg_restore --list)...
==> Archive TOC entries: 286
==> Pruning backups older than 30 days...
==> Backup OK: /tmp/ventia-backups/ventia-ventia-20260819T004924Z.dump
```

and the manifest it produced:

```json
{
  "createdAt": "2026-08-19T00:49:24Z",
  "dumpBytes": 102262,
  "tocEntries": 286,
  "sourceQuiescent": true,
  "policyCount": 29,
  "rlsTableCount": 28,
  "migrationCount": 20,
  "policyDigest": "837f5af66ca9865f10f99ccbbaf9398e"
}
```

### Scheduling

> **Not exercised.** No scheduler and no offsite copy were set up or run.
> SPEC.md §10 calls for a nightly `pg_dump` to R2 with 30-day retention;
> `backup.sh` produces the artifacts and prunes them, but **nothing here
> uploads anything anywhere**. A backup that only exists on the machine
> running the database is not a backup of that machine. Wiring up the upload
> (and then re-running the drill *from a downloaded copy*, which is the part
> that actually proves the offsite copy is good) is outstanding work.

The intended shape, for whoever picks it up:

```cron
# 03:15 UTC nightly
15 3 * * * cd /srv/ventia && BACKUP_DIR=/var/backups/ventia bash scripts/backup.sh >> /var/log/ventia-backup.log 2>&1
# Weekly drill, Sundays 04:00 UTC — non-zero exit should page someone
0 4 * * 0 cd /srv/ventia && bash scripts/restore-drill.sh --latest >> /var/log/ventia-drill.log 2>&1
```

---

## Restore drill

```bash
bash scripts/restore-drill.sh            # fresh backup, then restore it
bash scripts/restore-drill.sh --latest   # drill the newest dump in BACKUP_DIR
bash scripts/restore-drill.sh --backup /path/to/ventia-....dump
```

The drill creates a throwaway database (`ventia_drill_<timestamp>_<pid>`),
restores into it, runs 15 checks, and drops it again on exit (`KEEP_DRILL_DB=1`
keeps it for post-mortem). **The source database is never written to.**

`pg_restore` runs with `--exit-on-error`, deliberately: its default is to log
errors and carry on, exiting 0 with a "there were N errors" line that is
trivially missed in a cron log. A drill that tolerates errors proves nothing.

### What the checks actually prove

1. **Backup integrity** — `sha256sum --check` on the three artifacts.
2. **Roles** — `ventia_app` exists; if it does not, the globals dump is applied
   first. (See the *Not exercised* note below.)
3. **Restore** — `pg_restore --exit-on-error` completed.
4. **Table set** — identical to the source.
5. **Row counts** — every table matches the manifest.
6. **RLS enabled** — the same tables carry `relrowsecurity`. A table restored
   with RLS off looks perfectly healthy and serves every tenant's rows to
   every tenant.
7. **Policy definitions** — md5 over every policy's
   `(table, name, permissive, cmd, USING, WITH CHECK)` matches the digest taken
   at dump time. This is the check that catches the catastrophic-and-invisible
   failure: data restores fine, `tenant_isolation` quietly did not.
8. **Grant matrix** — `ventia_app`'s complete (table, privilege) matrix is
   identical to the source's. Compared *against the source* rather than against
   a hardcoded expectation, so it needs no maintenance as tables are added.
9. **Revoked platform tables** — `ventia_app` still has no access to `User`,
   `Session`, `Account`, `Verification`, `Membership`, `AuditLog`,
   `_prisma_migrations`. These carry no `tenantId` and therefore no RLS policy,
   so any grant here hands every tenant-scoped request the whole table. If a
   leak is found, the drill states explicitly whether it is pre-existing in the
   source or was introduced by the restore.
10. **`BYPASSRLS`** — `ventia_app` does not hold it; if it did, every policy
    above would be decorative.
11. **Isolation actually enforced** — the real test. Connect **as `ventia_app`**
    against the restored data, the same `SET ROLE` + `app.tenant_id` GUC path
    the application uses, and check that tenant A's context sees exactly A's
    rows, B's sees B's, **zero** of the other tenant's, no GUC at all sees
    nothing (fails closed), and a cross-tenant `INSERT` is refused by the
    policy's `WITH CHECK` clause. Checks 6–10 assert the machinery is present;
    this one asserts it bites.
12. **Schema version** — `_prisma_migrations` count matches the manifest.

### Executed run

Run on 2026-08-19 against the dev database (20 migrations applied, 10 tenants,
13 products, 45 rows total):

```
==============================================================
 Ventia restore drill — 2026-08-19T00:48:55Z
==============================================================
==> Source database: ventia
==> Scratch database: ventia_drill_20260819004855_24725

--- Step 0: backup integrity -------------------------------
  PASS  Checksums match (sha256sum --check)
  PASS  Role ventia_app present in the cluster
        already existed; globals dump not re-applied

--- Step 1: restore ----------------------------------------
  PASS  pg_restore --exit-on-error completed

--- Step 2: schema and data --------------------------------
  PASS  Table set identical to source (35 tables)
  PASS  Row counts match the manifest on all 32 tables
        45 rows restored

--- Step 3: RLS survived the round trip --------------------
  PASS  RLS enabled on the same 28 tables as the source
  PASS  All 29 policy definitions byte-identical
        md5 837f5af66ca9865f10f99ccbbaf9398e

--- Step 4: grants survived the round trip -----------------
  PASS  ventia_app's entire grant matrix is identical to the source
        97 (table, privilege) pairs
  PASS  ventia_app has NO access to the 7 auth/platform tables (restored)
  PASS  ventia_app does not hold BYPASSRLS
  NOTE  RLS tables ventia_app cannot even SELECT: WhatsAppNumber

--- Step 5: tenant isolation actually enforced -------------
        tenant A = 6edd806e-de71-4e18-a45a-fcf4222dbb45 (2 products)
        tenant B = 80545634-1a67-4a3a-bfa5-34a1d598555a (2 products)
  PASS  Each tenant's GUC sees exactly its own products
        A: 2/2, B: 2/2
  PASS  Tenant A's context sees 0 of tenant B's products
  PASS  No app.tenant_id set => 0 rows (fails closed)
  PASS  Cross-tenant INSERT refused by the policy's WITH CHECK clause

--- Step 6: schema version ---------------------------------
  PASS  20 applied migrations restored
        latest: 20260819120000_payment_ledger

==============================================================
 Restore drill: 15 passed, 0 failed
==============================================================
```

### The drill's assertions are not vacuous

A green drill is only worth something if a broken restore would turn it red, so
the isolation checks were run against a deliberately-sabotaged copy: a second
scratch database was restored from the same dump, then
`ALTER TABLE "Product" DISABLE ROW LEVEL SECURITY` and
`DROP POLICY tenant_isolation ON "Order"` were applied by hand to simulate a
restore that lost them. Measured, on that copy:

| Probe | Healthy restore | Sabotaged copy |
| --- | --- | --- |
| Tenant A's context reading B's products | `0` | `2` — cross-tenant leak |
| No `app.tenant_id` set | `0` rows | `13` rows — fails open |
| Cross-tenant `INSERT` | `WRITE_BLOCKED` | `WRITE_ALLOWED` |
| Policy digest | `837f5af6…` | `a4306cd9…` — mismatch |

Every check flipped. They measure what they claim to.

### Findings from running it

- **`WhatsAppNumber` has RLS enabled but `ventia_app` holds no privileges on
  it at all** (reported by the drill as a `NOTE`, not a failure — it is
  faithfully restored, and identical in the source). A tenant-owned,
  RLS-protected table that the tenant-scoped role cannot even `SELECT` is
  invisible to every tenant-scoped query. Introduced by
  [`20260818120000_whatsapp_numbers`](../packages/db/prisma/migrations/20260818120000_whatsapp_numbers/migration.sql);
  the `ALTER DEFAULT PRIVILEGES` from the RLS migration did not cover it. Not
  fixed here — it belongs in a migration, which is outside this work's scope.
- An earlier version of check 8 hardcoded "every RLS table has full CRUD" and
  reported failures for `AgentUsage`, `Payment`, `WebhookEvent` and
  `WebhookEventReview`, which the source only grants `SELECT` (or
  `SELECT, INSERT`) on by design. It was rewritten to compare against the
  source. A drill that reports the schema's deliberate decisions as restore
  failures is a drill people learn to ignore.

> **Not exercised.** The "cluster has never seen `ventia_app`, so apply the
> globals dump" branch never ran: the drill was only ever run against a cluster
> that already had the role, so it took the no-op path every time. That branch
> is one `psql -f <globals>` and its input has been verified to contain
> `CREATE ROLE ventia_app`, but the code path itself is **untested**. A real
> disaster-recovery rehearsal into a genuinely empty cluster is the missing
> piece.

---

## Disaster recovery: restoring into a new cluster

The drill restores into a scratch database *beside* the original. A real
recovery replaces it. The sequence, with each step marked for whether this work
exercised it:

```bash
# 1. Verify the artifacts before trusting them.                    [EXERCISED]
cd "$BACKUP_DIR" && sha256sum --check ventia-ventia-<stamp>.sha256

# 2. Recreate cluster-wide roles (ventia_app and its membership).  [NOT EXERCISED]
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f ventia-ventia-<stamp>.globals.sql

# 3. Create the target database.                                   [EXERCISED]
psql "$ADMIN_URL" -c 'CREATE DATABASE ventia'

# 4. Restore, refusing to continue past any error.                 [EXERCISED]
pg_restore --dbname="$DATABASE_URL" --exit-on-error ventia-ventia-<stamp>.dump

# 5. Prove it before pointing traffic at it.                       [EXERCISED]
BACKUP_DIR=... bash scripts/restore-drill.sh --backup ventia-ventia-<stamp>.dump
```

Step 5 is the one that matters: it is the same script, and it will tell you
whether isolation survived before a merchant finds out for you.

> **Not exercised, and a real gap:** there is no WAL archiving and no
> point-in-time recovery. The recovery-point objective is therefore "whenever
> the last nightly dump ran" — up to 24 hours of orders. For a platform taking
> real payments that is a decision to make deliberately, not to discover.

---

## Load test

```bash
node scripts/load-test.mjs                       # 100 concurrent checkouts
CONCURRENCY=250 node scripts/load-test.mjs
SCENARIOS=2 node scripts/load-test.mjs           # one scenario in isolation
KEEP_LOAD_TEST_DATA=1 node scripts/load-test.mjs # leave the rows for inspection
```

The script seeds four throwaway tenants by SQL (unique slugs per run), drives
**real** checkouts over HTTP against a running API, asserts the outcome by
reading Postgres directly, and deletes its tenants afterwards — including on
`SIGINT`/`SIGTERM`, so an interrupted run leaves nothing behind (verified: a run
killed mid-scenario cleaned up all four tenants and their orders).

### Invariants vs capacity — and why they are counted separately

- **Invariant** assertions must hold no matter how badly the run degrades:
  stock never negative, the `Order` rows that exist exactly match the `201`s
  that were returned, per-tenant numbering dense and unique, no tenant seeing
  another's rows. A failure here means money or stock was lost, duplicated, or
  crossed a tenant boundary.
- **Capacity** assertions say "every one of the N requests was actually
  served". A failure means the platform *refused* or *dropped* work — bad and
  worth fixing, but not a correctness violation.

Both are fatal to the exit code; they are reported apart so a degraded run is
never mistaken for a broken one, or vice versa. This distinction turned out to
be the most useful thing in the script: in **every** degraded configuration
measured below — including runs where 93 of 100 requests failed — not a single
invariant was violated.

### Why the stock scenarios check out with `wompi` and not `cod`

A COD checkout deliberately does **not** decrement stock: stock moves when the
merchant *confirms* the order in the admin, not at checkout
([`checkout.service.ts`](../services/api/src/checkout/checkout.service.ts)).
An oversell probe driven with COD would therefore assert nothing at all — 1000
concurrent COD checkouts against stock 1 all succeed, correctly. The
online-payment path is the one that reserves stock inside the checkout
transaction (`adjustStockLine`, an atomic floor-checked `UPDATE`), so that is
the path an oversell test has to drive. Wompi's `createCheckoutSession` builds
a signed redirect URL locally and makes **no network call**, so this runs fully
offline against fake-but-well-formed credentials — the same posture
[`services/api/test/checkout.test.ts`](../services/api/test/checkout.test.ts)
already takes. Scenario 3 uses `cod` on purpose, so the primary (P2) checkout
path is also exercised at 100-wide concurrency.

### Measured results — 100 concurrent checkouts, all green

API on a 4-vCPU box, Prisma `connection_limit=150`, Postgres
`max_connections=300`, checkout rate limit raised (see findings). Three
consecutive full-suite runs were green; the numbers below are the third:

| Scenario | Offered | Result | Wall | Throughput | p50 / p95 / max |
| --- | --- | --- | --- | --- | --- |
| 1 — capacity (stock 100) | 100 concurrent | **100 × 201** | 1839 ms | 54.4 checkouts/s | 1065 / 1749 / 1829 ms |
| 2 — oversell (stock 50) | 100 concurrent | **50 × 201 + 50 × 400 `INSUFFICIENT_STOCK`** | 1552 ms | 64.4 checkouts/s | 1068 / 1500 / 1545 ms |
| 3 — isolation (2 tenants × 50) | 100 concurrent | **100 × 201** | 911 ms | 109.7 checkouts/s | 638 / 875 / 905 ms |

**Oversell: zero, in every run at every concurrency level tested.** Stock never
went negative and never landed anywhere but exactly `initial − successes`.

What the database said afterwards:

- Scenario 1 — 100 `Order` rows; `Product.stock` 100 → **0**; order numbers
  **dense and unique 1..100** (the per-tenant advisory lock in
  `nextOrderNumber` held under 100-wide contention); `InventoryMovement`
  ledger sums to exactly **−100**.
- Scenario 2 — exactly **50** winners against 50 units, exactly **50** clean
  `400 INSUFFICIENT_STOCK` losers, **0** orders written by any loser, stock
  **0**, never negative.
- Scenario 3 — **50** orders per tenant, each tenant numbered **1..50
  independently**; **0** order lines referencing the other tenant's product;
  **0** `OrderItem.tenantId` disagreeing with its parent `Order`; and — read
  back **through RLS as `ventia_app`** — each tenant's context saw its own 50
  orders and **0** of the other tenant's.

That last one is the DoD's *"isolation suite green under load"*: isolation
verified by the mechanism that enforces it in production, while 100 checkouts
for two tenants were interleaved in flight against the same process, the same
Prisma pool and the same Postgres backends.

### Finding 1 — the checkout rate limiter dominates any single-source load test

`RATE_LIMITS.checkout()` allows **60 requests per IP per minute**
([`services/api/src/main.ts`](../services/api/src/main.ts)). The whole load
test comes from one address, so the first untuned run produced 58 correct
`429 TOO_MANY_REQUESTS` responses and measured the limiter rather than the
checkout path:

```
statuses    201×2  429×58  500×40
```

This is the limiter working as designed, not a bug. For load testing, raise it
on the API process only: `RATE_LIMIT_CHECKOUT_PER_MINUTE=100000`. The script
detects any `429` and prints this instruction at the end of the run.

### Finding 2 — checkout starved the Prisma connection pool (real bug, now fixed)

**Symptom (before the fix).** Bursts of concurrent checkouts failed with a bare
`500 Internal server error` after almost exactly 15 seconds. At the default
pool size the failure is immediate and near-total.

**Mechanism.** `CheckoutService.checkout()` calls
`ShippingService.isCodAllowed()` and `.priceFor()` from **inside**
`platformDb.$transaction()`. Those go through `tenantDb()`, which needs a
**second** connection from the **same** pool in order to run its
`SET LOCAL ROLE` transaction. Once a burst has enough checkouts open to hold
every pooled connection, none of them can obtain that second connection, so
they all sit waiting until Prisma's 15-second interactive-transaction timeout
fires.

**Evidence.**

- The very first failures, at Prisma's default pool (9 on 4 vCPUs), carry the
  pool-timeout error naming the exact call site:
  `Timed out fetching a new connection from the connection pool` in
  `shipping.service.ts:33`, i.e. `tenantDb(tenantId).tenant.findUniqueOrThrow()`.
- `pg_stat_activity`, sampled once a second through a stalled burst
  (`connection_limit=50`): **50 connections `idle in transaction`, 0 active,
  0 waiting on a lock**, for 15 consecutive seconds — the client is holding
  every connection open inside a transaction and sending no statements, which
  is starvation, not database contention.
- Failures land at 15.0–15.7 s, i.e. the interactive-transaction timeout, and
  the API log shows both
  `Transaction API error: Unable to start a transaction in the given time`
  (the 2 s `maxWait`) and
  `Transaction already closed … timeout for this transaction was 15000 ms`.
- **It goes away exactly when the pool exceeds peak concurrency.** With
  `connection_limit=150` against 100 concurrent checkouts, three consecutive
  full-suite runs were green. With `connection_limit=50` or `95` against the
  same 100, runs failed most of the time.

**Measured behaviour by configuration:**

| Pool | Concurrency | Result |
| --- | --- | --- |
| 9 (Prisma default, 4 vCPU) | 100 | Near-total failure; pool timeouts at `shipping.service.ts:33` |
| 50 | 40 | Green, reproducible |
| 50 | 100 | **Nondeterministic** — some runs 100/100 in 1.9 s, most wedge at 15 s |
| 95 | 100 | Wedged; 77–93 of 100 requests returned 500 |
| 150 | 100 | **Green, reproducible** (3/3 runs) |
| 9 (Prisma default) | 100 | **Green** — after the fix below |

**Impact.** A checkout burst larger than the pool does not shed load
gracefully — it returns HTTP 500 with no error code after a 15-second wait. A
shopper sees a spinner, then "Internal server error", with no idea whether
they were charged. Nothing is corrupted (every invariant held in every wedged
run), but the user-visible failure mode is the worst available one.

**Fix — applied.** `ShippingService` now exposes `loadConfig(tenantId)`, which
performs the single `Tenant.settings` read, plus pure sibling methods
(`isCodAllowedIn`, `priceForIn`, `findMethodLabelIn`) that answer from an
already-loaded config with no database access.
[`checkout.service.ts`](../services/api/src/checkout/checkout.service.ts) calls
`loadConfig` **before** opening `platformDb.$transaction()` and uses the pure
methods inside it, so checkout needs exactly one pooled connection.

Only the I/O moved. The two questions are still asked from the same place in
the same order and still throw the same `SHIPPING_METHOD_UNAVAILABLE` 400s at
the same point, so no error ordering changed. This was never transactionally
consistent data anyway: the transaction is on `platformDb`, and `tenantDb`
never joined it.

The identical shape existed at a second site —
`OrdersService.transition()` called `findMethodLabel` on `tenantDb` from inside
its own `platformDb.$transaction`, and its comment cited checkout's (now
removed) precedent as justification. Fixed the same way. Lower traffic, same
deadlock.

Sizing the pool above peak concurrency was only ever a mitigation; it moved
the cliff rather than removing it, and it is no longer needed.

**Verified, same pool, same everything:**

| Checkout path | Pool | Concurrency | Served | Wall |
| --- | --- | --- | --- | --- |
| Before (reads inside the transaction) | 9 (default) | 100 | **7 × 201, 93 × 500** | 20 327 ms |
| After (config loaded before it) | 9 (default) | 100 | **100 × 201** | 1 926 ms |

Both rows are runs of `scripts/load-test.mjs` against the dev stack minutes
apart, with the fix reverted and restored in between — not a before/after from
different sessions. Invariants held in both: even in the wedged run stock never
went negative and the 7 orders that existed matched the 7 `201`s exactly. The
bug cost availability, never correctness.

### Environment notes

`node scripts/load-test.mjs` now runs green against the **plain dev stack** —
default Prisma pool, no `connection_limit`, nothing to reconfigure. The only
env change it needs is `RATE_LIMIT_CHECKOUT_PER_MINUTE=100000` on the API
process (Finding 1).

The recipe below is kept for the case it was originally written for: driving
concurrency *above* 100. The dev stack's Postgres runs with the default
`max_connections = 100` ([`docker/compose.yaml`](../docker/compose.yaml) sets
no override), so `CONCURRENCY=250` still needs a Postgres of its own. Starting
a **dedicated, throwaway** one alongside the stack leaves the shared one
untouched:

```bash
docker run -d --name ventia-loadtest-pg \
  -e POSTGRES_USER=ventia -e POSTGRES_PASSWORD=ventia -e POSTGRES_DB=ventia \
  -p 5433:5432 pgvector/pgvector:pg16 -c max_connections=300

DATABASE_URL=postgresql://ventia:ventia@localhost:5433/ventia \
  pnpm --filter @ventia/db migrate:deploy

# API against it, with a pool wider than the offered concurrency:
DATABASE_URL='postgresql://ventia:ventia@localhost:5433/ventia?connection_limit=150&pool_timeout=30' \
REDIS_URL=redis://localhost:6379 AUTH_SECRET=dev-secret-change-me \
RATE_LIMIT_CHECKOUT_PER_MINUTE=100000 \
PAYMENTS_ENCRYPTION_KEY=ZGV2LW9ubHktZTJlLWtleS0zMi1ieXRlcy1sb25nISE= \
PLATFORM_ROOT_DOMAIN=ventia.localhost \
  pnpm --filter @ventia/api dev

DATABASE_URL=postgresql://ventia:ventia@localhost:5433/ventia node scripts/load-test.mjs

docker rm -f ventia-loadtest-pg
```

`PAYMENTS_ENCRYPTION_KEY` must match between the API and the load test — the
script seeds encrypted Wompi credentials into `Tenant.settings` and the API
decrypts them. Both default to the same fixed dev key `scripts/e2e.sh` uses,
so an API started the way `e2e.sh` starts it needs no extra configuration.

> **Not exercised.** The load test drives the API **directly on `:4000`**,
> bypassing Caddy — so nothing here measures the proxy, TLS termination, or
> `trust proxy` behaviour under load, and the per-IP rate limiting was measured
> against `127.0.0.1` rather than a forwarded client address. Also untested:
> the storefront and admin Next.js apps under load, any real payment-gateway
> call (credentials are well-formed fakes; Wompi's redirect is built locally),
> email delivery (the dev console mailer only), the WhatsApp and AI-agent
> endpoints, and any form of *sustained* load — every measurement here is a
> single burst lasting a few seconds, so nothing is known about connection
> leaks, memory growth, or BullMQ worker behaviour over hours.
