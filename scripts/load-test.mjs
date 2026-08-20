#!/usr/bin/env node
// P6 Definition-of-Done: "load test (100 concurrent checkouts)" —
// DoD phrase: "isolation suite green under load".
//
// The interesting question here is NOT throughput. It is whether the two
// invariants the whole platform rests on survive real concurrency:
//
//   * STOCK ACCOUNTING — N concurrent checkouts against a product with stock
//     N must produce exactly N orders and leave stock at 0; with stock N/2
//     they must produce exactly N/2 orders, N/2 clean 400s, and stock 0 —
//     never a negative stock, never an oversell, never a 500.
//   * TENANT ISOLATION — two tenants checking out simultaneously through the
//     same process, the same Prisma pool and the same Postgres connections
//     must never cross-contaminate: no order in tenant A referencing tenant
//     B's product, and per-tenant order numbering (`@@unique(tenantId,
//     number)`) staying dense and gap-free on both sides at once.
//
// So every scenario ends in assertions read straight out of Postgres, and
// the last of them re-reads the results AS `ventia_app` under RLS — the same
// SET ROLE + `app.tenant_id` GUC path packages/db/src/tenant-client.ts uses
// — so "isolation held" is checked by the mechanism that enforces it in
// production, not only by the application's own bookkeeping.
//
// WHY THE STOCK SCENARIOS CHECK OUT WITH `wompi`, NOT `cod`:
// a COD checkout deliberately does NOT decrement stock (see
// services/api/src/checkout/checkout.service.ts — stock moves when the
// merchant CONFIRMS the order in the admin, not at checkout). Driving the
// oversell probe with COD would therefore assert nothing at all: 1000
// concurrent COD checkouts against stock 1 all succeed, correctly. The
// online-payment path is the one that reserves stock inside the checkout
// transaction (`adjustStockLine`, an atomic floor-checked UPDATE), so that
// is the path an oversell test has to drive. Wompi's `createCheckoutSession`
// builds a signed redirect URL locally and makes no network call, so this
// runs fully offline against fake-but-well-formed credentials — exactly what
// services/api/test/checkout.test.ts already does.
// Scenario 3 uses `cod` on purpose, so the primary (P2) checkout path is
// also exercised at 100-wide concurrency rather than only the P3 one.
//
// INVARIANT vs CAPACITY. Every scenario splits its assertions in two, and
// the distinction is the point of the whole script:
//
//   INVARIANT  — must hold no matter how badly the run degrades. Stock never
//                goes negative; the Order rows that exist exactly match the
//                201s that were returned; per-tenant numbering stays dense
//                and unique; no tenant sees another's rows. A failure here is
//                a correctness bug: money or stock was lost, duplicated, or
//                crossed a tenant boundary.
//   CAPACITY   — "every one of the N requests was actually served". A failure
//                here means the platform REFUSED or DROPPED work (429, 5xx,
//                socket error) — bad, visible, and worth fixing, but not a
//                correctness violation. Reported separately so a degraded run
//                cannot be mistaken for a broken one, or vice versa.
//
// Both are counted, and either kind of failure exits non-zero.
//
// Prerequisites: dev stack up (docker/compose.yaml), migrations applied, and
// the API running with the SAME PAYMENTS_ENCRYPTION_KEY this script uses —
// `bash scripts/e2e.sh`'s default key is the default here too.
//
// TWO API-SIDE LIMITS WILL OTHERWISE DOMINATE THE RESULT, and both were found
// by running this script rather than by reading the code:
//
//   * The checkout rate limiter (services/api/src/main.ts) allows 60 requests
//     per IP per minute. 100 concurrent checkouts all come from one address,
//     so ~58 of them get a correct 429 and the run measures the limiter
//     instead of the checkout path. Raise it FOR THE LOAD TEST ONLY:
//       RATE_LIMIT_CHECKOUT_PER_MINUTE=100000
// Only the rate limiter still applies. A SECOND limit used to: at Prisma's
// default pool (`num_cpus * 2 + 1`, 9 on a 4-vCPU box) 100 concurrent
// checkouts failed 93 of 100 times with pool timeouts surfaced as bare 500s,
// and the only way to get a green run was a pool wider than the offered
// concurrency. That was a real bug in the checkout path, found by this
// script and since FIXED (checkout.service.ts / shipping.service.ts now load
// the shipping config before opening the transaction instead of reading it
// from inside one). This suite is green at 100 concurrent on the *default*
// pool now — if you find yourself widening `connection_limit` to make it
// pass, something has regressed.
//
// Both are documented in docs/operations.md along with the measured numbers
// before and after.
//
// Usage:
//   node scripts/load-test.mjs
//   CONCURRENCY=250 node scripts/load-test.mjs
//   KEEP_LOAD_TEST_DATA=1 node scripts/load-test.mjs   # leave rows for inspection
//
// Env: API_URL, DATABASE_URL, CONCURRENCY, PAYMENTS_ENCRYPTION_KEY,
//      KEEP_LOAD_TEST_DATA.

import { execFileSync } from 'node:child_process';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://ventia:ventia@localhost:5432/ventia';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 100);
// Same fixed, obviously-fake dev key scripts/e2e.sh defaults to, for the same
// reason: the API and this script must derive the same AES key or every
// wompi checkout fails at credential decryption, and a randomly generated
// one could never match an already-running API.
const ENCRYPTION_KEY_B64 = process.env.PAYMENTS_ENCRYPTION_KEY ?? 'ZGV2LW9ubHktZTJlLWtleS0zMi1ieXRlcy1sb25nISE=';
const KEEP_DATA = process.env.KEEP_LOAD_TEST_DATA === '1';
// Which scenarios to run, e.g. SCENARIOS=2 to reproduce one in isolation.
// Scenario 1 leaves 100 committed orders and a sold-out product behind for
// its tenant, so running a later scenario alone is the only way to see its
// numbers without that warm-up in front of it.
const SCENARIOS = new Set((process.env.SCENARIOS ?? '1,2,3').split(',').map((x) => x.trim()));

// One run id in every slug/domain/email this script creates, so (a) two runs
// never collide on Tenant.slug / TenantDomain.domain uniqueness, (b) the
// DomainResolver's 60-second Redis cache of domain -> tenantId can never
// serve a previous run's tenant for this run's domain, and (c) cleanup can
// delete exactly this run's rows and nothing else.
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;

const BOGOTA_ADDRESS = {
  nombreCompleto: 'Carga Concurrente',
  telefono: '3001234567',
  departamentoCode: '11',
  municipioName: 'Bogotá, D.C.',
  direccion: 'Calle 1 # 2-34',
};

let invariantFailures = 0;
let capacityFailures = 0;
let sawRateLimit = false;
let sawPoolStall = false;
const C = { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };

/** A correctness assertion. Must hold however degraded the run was. */
function assert(ok, description, detail = '') {
  if (ok) {
    console.log(`  ${C.green}PASS${C.off}  ${description}${detail ? `  ${C.dim}${detail}${C.off}` : ''}`);
  } else {
    invariantFailures += 1;
    console.log(`  ${C.red}FAIL${C.off}  ${description}${detail ? `  ${detail}` : ''}`);
  }
}

/** A throughput assertion: the platform served the offered load. Tracked
 * separately from `assert` so "we refused 58 requests" and "we sold stock we
 * did not have" are never reported as the same kind of problem. */
function capacity(ok, description, detail = '') {
  if (ok) {
    console.log(`  ${C.green}PASS${C.off}  ${C.dim}[capacity]${C.off} ${description}${detail ? `  ${C.dim}${detail}${C.off}` : ''}`);
  } else {
    capacityFailures += 1;
    console.log(`  ${C.yellow}FAIL${C.off}  ${C.dim}[capacity]${C.off} ${description}${detail ? `  ${detail}` : ''}`);
  }
}

/** Requests the platform refused or dropped: a 429 from the rate limiter, any
 * 5xx, or a transport failure. Deliberately NOT counting a 400
 * INSUFFICIENT_STOCK, which is a correct answer, not a refusal. */
function rejections(results) {
  const list = results.filter((r) => r.status === 429 || r.status >= 500 || r.status === 0);
  if (list.some((r) => r.status === 429)) sawRateLimit = true;
  // A 5xx that took ~15s is Prisma's interactive-transaction timeout, which
  // for this endpoint means connection-pool starvation rather than a slow
  // query — see the note printed at the end of the run.
  if (list.some((r) => r.status >= 500 && r.ms > 12_000)) sawPoolStall = true;
  return list;
}

// ---------------------------------------------------------------------------
// Postgres, via the psql binary. This repo has no standalone `pg` driver in
// its dependency tree (Prisma ships its own engine), and adding one just for
// a local load-test script would be a real dependency for a throwaway need.
// psql is already a prerequisite of scripts/backup.sh and restore-drill.sh.
// ---------------------------------------------------------------------------
function sql(query) {
  const out = execFileSync('psql', [DATABASE_URL, '-tA', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter((l) => l.length > 0).map((l) => l.split('\t'));
}
/** Single scalar from a single-row/single-column query. */
function sqlOne(query) {
  const rows = sql(query);
  return rows.length ? rows[0][0] : null;
}
/** Postgres string literal — doubling `'` is the whole escape rule for a
 * standard_conforming_strings literal, and every value passed here is
 * generated by this script (no user input), so this stays deliberately small
 * rather than pretending to be a general-purpose quoter. */
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------
// Payment-credential encryption. Mirrors
// services/api/src/payments/encryption.ts's format exactly —
// "base64(iv):base64(tag):base64(ciphertext)", AES-256-GCM, 12-byte IV —
// because this script seeds Tenant.settings by SQL and the API decrypts what
// it finds there. Reimplemented rather than imported: services/api has no
// current build output to import from, and importing TypeScript source from
// a plain .mjs script would need a compiler in the loop. If that format ever
// changes, the wompi scenarios below fail loudly at the first checkout
// (PAYMENT_PROVIDER_NOT_CONFIGURED / a decrypt error), never silently.
// ---------------------------------------------------------------------------
function encryptSecret(plaintext) {
  const key = Buffer.from(ENCRYPTION_KEY_B64, 'base64');
  if (key.length !== 32) throw new Error(`PAYMENTS_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

const SHIPPING_SETTINGS = {
  methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
};

function wompiCredentials() {
  return {
    publicKey: 'pub_test_LOADTESTLOADTESTLOAD',
    privateKeyEncrypted: encryptSecret('prv_test_LOADTESTLOADTESTLOADTESTLOADTEST'),
    integritySecretEncrypted: encryptSecret('test_integrity_loadtest'),
    eventsSecretEncrypted: encryptSecret('test_events_loadtest'),
    sandbox: true,
  };
}

/** Creates one live tenant with one primary domain and one in-stock active
 * product, and returns the ids the scenarios need. Seeded by SQL rather than
 * through the admin API because there is no unauthenticated way to create a
 * tenant, and driving the whole signup + onboarding wizard 4 times would be
 * setup cost with no bearing on what this script measures. */
function seedTenant({ label, stock, paymentMethod }) {
  const slug = `loadtest-${label}-${RUN}`;
  const domain = `${slug}.ventia.localhost`;
  const settings = {
    shipping: SHIPPING_SETTINGS,
    ...(paymentMethod === 'wompi' ? { payments: { providers: { wompi: wompiCredentials() } } } : {}),
  };
  const tenantId = sqlOne(`
    INSERT INTO "Tenant" (id, slug, name, status, settings, "updatedAt")
    VALUES (gen_random_uuid(), ${lit(slug)}, ${lit(`Load Test ${label.toUpperCase()}`)}, 'live',
            ${lit(JSON.stringify(settings))}::jsonb, now())
    RETURNING id`);
  sqlOne(`
    INSERT INTO "TenantDomain" (id, "tenantId", domain, "isPrimary")
    VALUES (gen_random_uuid(), ${lit(tenantId)}, ${lit(domain)}, true) RETURNING id`);
  const productId = sqlOne(`
    INSERT INTO "Product" (id, "tenantId", name, slug, "priceCents", stock, status, "updatedAt")
    VALUES (gen_random_uuid(), ${lit(tenantId)}, ${lit(`Producto ${label}`)}, ${lit(`producto-${label}`)},
            45900, ${Number(stock)}, 'active', now())
    RETURNING id`);
  return { label, slug, domain, tenantId, productId, paymentMethod, initialStock: Number(stock) };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Creates one cart holding one unit of `productId` and returns its
 * `ventia_cart` cookie value. Part of SETUP, not of what is measured: the
 * checkouts are what must be concurrent, so these run at a modest fixed
 * width and their latency is reported separately (as context) rather than
 * mixed into the checkout numbers. */
async function createCart(domain, productId) {
  const res = await fetch(`${API_URL}/v1/storefront/cart/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-domain': domain },
    body: JSON.stringify({ productId, qty: 1 }),
  });
  if (res.status !== 201) {
    throw new Error(`cart/items returned ${res.status}: ${await res.text()}`);
  }
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  const raw = setCookie.find((c) => c.startsWith('ventia_cart='));
  if (!raw) throw new Error('no ventia_cart Set-Cookie on the cart response');
  await res.arrayBuffer();
  return raw.split(';')[0].slice('ventia_cart='.length);
}

/** Runs `tasks` with at most `width` in flight. Used only for setup. */
async function pool(tasks, width) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, tasks.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= tasks.length) return;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

async function checkout({ domain, cookie, paymentMethod, index }) {
  const startedAt = performance.now();
  try {
    const res = await fetch(`${API_URL}/v1/storefront/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-domain': domain,
        cookie: `ventia_cart=${cookie}`,
      },
      body: JSON.stringify({
        email: `carga-${index}-${RUN}@example.com`,
        phone: '3001234567',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod,
      }),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    return { ms: performance.now() - startedAt, status: res.status, body, domain };
  } catch (err) {
    // A transport-level failure (socket hang-up, ECONNRESET under load) is a
    // distinct and much worse outcome than a clean 4xx, so it gets its own
    // pseudo-status rather than being folded into the error count.
    return { ms: performance.now() - startedAt, status: 0, body: { error: String(err?.message ?? err) }, domain };
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
/** One line naming WHY requests were refused, with counts — a bare
 * "12 rejected" sends the reader to the API log for something this already
 * knows. */
function summarizeRejections(refused) {
  if (refused.length === 0) return '';
  const buckets = new Map();
  for (const r of refused) {
    const label =
      r.status === 429
        ? `429 ${r.body?.error ?? ''}`.trim()
        : r.status === 0
          ? `transport: ${r.body?.error ?? 'unknown'}`
          : `${r.status} ${r.body?.message ?? r.body?.error ?? ''}`.trim();
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([label, n]) => `${n}× ${label}`).join('; ');
}

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[idx];
}

function reportLatency(results, wallMs) {
  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = new Map();
  for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  const statusLine = [...byStatus.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `${s === 0 ? 'transport-error' : s}×${n}`)
    .join('  ');
  const ms = (v) => `${v.toFixed(0)}ms`;
  console.log(`  ${C.dim}statuses${C.off}    ${statusLine}`);
  console.log(
    `  ${C.dim}latency${C.off}     p50 ${ms(percentile(sorted, 50))}  p95 ${ms(percentile(sorted, 95))}  ` +
      `p99 ${ms(percentile(sorted, 99))}  max ${ms(sorted[sorted.length - 1] ?? 0)}`,
  );
  console.log(
    `  ${C.dim}wall${C.off}        ${ms(wallMs)} for ${results.length} requests  ` +
      `(${((results.length / wallMs) * 1000).toFixed(1)} checkouts/s aggregate)`,
  );
  return { byStatus, sorted };
}

/** Reads a tenant's order count back through RLS — SET ROLE ventia_app +
 * the app.tenant_id GUC, i.e. the exact path every tenant-scoped query in
 * the app takes — and also asks, in that same context, how many of the OTHER
 * tenant's orders are visible. The application's own bookkeeping being
 * correct and the database's isolation being correct are two different
 * claims; this checks the second one. */
function rlsScopedOrderCounts(tenantId, otherTenantId) {
  const rows = sql(`
    BEGIN;
    SET LOCAL ROLE ventia_app;
    SET LOCAL app.tenant_id = ${lit(tenantId)};
    SELECT 'own', count(*) FROM "Order"
    UNION ALL
    SELECT 'other', count(*) FROM "Order" WHERE "tenantId" = ${lit(otherTenantId)};
    ROLLBACK;`);
  const own = rows.find((r) => r[0] === 'own');
  const other = rows.find((r) => r[0] === 'other');
  return { own: Number(own?.[1] ?? -1), other: Number(other?.[1] ?? -1) };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Fires `n` checkouts truly simultaneously (all carts built first, then one
 * Promise.all) and returns the results plus the wall time of the burst. */
async function burst(requests) {
  const startedAt = performance.now();
  const results = await Promise.all(requests.map((r) => checkout(r)));
  return { results, wallMs: performance.now() - startedAt };
}

async function scenarioCapacity(tenant, n) {
  console.log(`\n${C.bold}Scenario 1 — capacity: ${n} concurrent checkouts, stock ${tenant.initialStock}${C.off}`);
  console.log(`  ${C.dim}tenant${C.off}      ${tenant.slug} (${tenant.paymentMethod})`);

  const setupStart = performance.now();
  const cookies = await pool(
    Array.from({ length: n }, () => () => createCart(tenant.domain, tenant.productId)),
    20,
  );
  console.log(`  ${C.dim}setup${C.off}       ${n} carts in ${(performance.now() - setupStart).toFixed(0)}ms`);

  const { results, wallMs } = await burst(
    cookies.map((cookie, index) => ({ domain: tenant.domain, cookie, paymentMethod: tenant.paymentMethod, index })),
  );
  reportLatency(results, wallMs);

  const ok = results.filter((r) => r.status === 201).length;
  const refused = rejections(results);
  const orders = Number(sqlOne(`SELECT count(*) FROM "Order" WHERE "tenantId" = ${lit(tenant.tenantId)}`));
  const stock = Number(sqlOne(`SELECT stock FROM "Product" WHERE id = ${lit(tenant.productId)}`));
  const numbers = sql(
    `SELECT count(*), count(DISTINCT number), coalesce(min(number),0), coalesce(max(number),0)
     FROM "Order" WHERE "tenantId" = ${lit(tenant.tenantId)}`,
  )[0].map(Number);
  const moved = Number(
    sqlOne(`SELECT coalesce(sum(delta), 0) FROM "InventoryMovement" WHERE "tenantId" = ${lit(tenant.tenantId)}`),
  );

  // Invariants — stated against the number of 201s ACTUALLY returned, not
  // against n, so they stay meaningful (and stay assertions, not noise) even
  // on a run the platform partly refused. "orders === ok" is the strong one:
  // every 201 produced exactly one order and every non-201 produced none, so
  // no shopper was charged for an order that does not exist and none exists
  // that no shopper was told about.
  assert(orders === ok, 'Order rows exactly match the 201s returned', `${orders} rows, ${ok} × 201`);
  assert(stock === tenant.initialStock - ok, `stock decremented exactly once per order`, `${tenant.initialStock} - ${ok} = ${tenant.initialStock - ok}, actual ${stock}`);
  assert(stock >= 0, 'stock never went negative', `stock = ${stock}`);
  assert(
    numbers[0] === numbers[1] && (numbers[0] === 0 || (numbers[2] === 1 && numbers[3] === numbers[0])),
    `order numbers are dense and unique 1..${numbers[0]} under the advisory lock`,
    `count ${numbers[0]}, distinct ${numbers[1]}, min ${numbers[2]}, max ${numbers[3]}`,
  );
  assert(moved === -ok, `InventoryMovement ledger sums to -${ok}`, `sum(delta) = ${moved}`);

  capacity(ok === n, `all ${n} concurrent checkouts were served`, `${ok}/${n} returned 201`);
  capacity(refused.length === 0, 'nothing was refused (no 429) or dropped (no 5xx / transport error)', summarizeRejections(refused));
  return results;
}

async function scenarioOversell(tenant, n) {
  const stockCap = tenant.initialStock;
  console.log(
    `\n${C.bold}Scenario 2 — oversell probe: ${n} concurrent checkouts, stock ${stockCap}${C.off}`,
  );
  console.log(`  ${C.dim}tenant${C.off}      ${tenant.slug} (${tenant.paymentMethod})`);

  const cookies = await pool(
    Array.from({ length: n }, () => () => createCart(tenant.domain, tenant.productId)),
    20,
  );

  const { results, wallMs } = await burst(
    cookies.map((cookie, index) => ({ domain: tenant.domain, cookie, paymentMethod: tenant.paymentMethod, index })),
  );
  reportLatency(results, wallMs);

  const ok = results.filter((r) => r.status === 201).length;
  const insufficient = results.filter((r) => r.status === 400 && r.body?.error === 'INSUFFICIENT_STOCK').length;
  const refused = rejections(results);
  const unexplained = results.filter(
    (r) => r.status !== 201 && !(r.status === 400 && r.body?.error === 'INSUFFICIENT_STOCK') && !refused.includes(r),
  );
  const orders = Number(sqlOne(`SELECT count(*) FROM "Order" WHERE "tenantId" = ${lit(tenant.tenantId)}`));
  const stock = Number(sqlOne(`SELECT stock FROM "Product" WHERE id = ${lit(tenant.productId)}`));

  // THE headline invariant of this whole script: more winners than there was
  // stock means the platform sold something it did not have.
  assert(ok <= stockCap, `NO OVERSELL: winners (${ok}) never exceeded the ${stockCap} units in stock`, `${ok} ≤ ${stockCap}`);
  assert(stock >= 0, 'stock never went negative', `stock = ${stock}`);
  assert(orders === ok, 'Order rows exactly match the 201s returned', `${orders} rows, ${ok} × 201`);
  assert(stock === stockCap - ok, 'stock decremented exactly once per order', `${stockCap} - ${ok} = ${stockCap - ok}, actual ${stock}`);
  assert(
    unexplained.length === 0,
    'every loser got a clean 400 INSUFFICIENT_STOCK, never a mystery error',
    unexplained.length ? JSON.stringify(unexplained.slice(0, 3).map((r) => ({ status: r.status, body: r.body }))) : `${insufficient} × 400 INSUFFICIENT_STOCK`,
  );

  capacity(ok === stockCap, `the winner set is exactly the ${stockCap} available units`, `${ok} succeeded`);
  capacity(
    insufficient === n - stockCap,
    `the other ${n - stockCap} were told INSUFFICIENT_STOCK`,
    `${insufficient} were`,
  );
  capacity(refused.length === 0, 'nothing was refused (no 429) or dropped (no 5xx / transport error)', summarizeRejections(refused));
  return results;
}

async function scenarioCrossTenant(tenantC, tenantD, perTenant) {
  const n = perTenant * 2;
  console.log(
    `\n${C.bold}Scenario 3 — tenant isolation: ${n} concurrent checkouts, ${perTenant} per tenant, interleaved${C.off}`,
  );
  console.log(`  ${C.dim}tenants${C.off}     ${tenantC.slug} + ${tenantD.slug} (${tenantC.paymentMethod})`);

  const cookiesC = await pool(Array.from({ length: perTenant }, () => () => createCart(tenantC.domain, tenantC.productId)), 20);
  const cookiesD = await pool(Array.from({ length: perTenant }, () => () => createCart(tenantD.domain, tenantD.productId)), 20);

  // Interleaved rather than "all of C then all of D": the whole point is
  // that requests for the two tenants are in flight against the same
  // process, the same Prisma connection pool and the same Postgres backends
  // at the same instant, which is where a leaked `app.tenant_id` GUC or a
  // reused-connection bug would show up.
  const requests = [];
  for (let i = 0; i < perTenant; i++) {
    requests.push({ domain: tenantC.domain, cookie: cookiesC[i], paymentMethod: tenantC.paymentMethod, index: `c${i}` });
    requests.push({ domain: tenantD.domain, cookie: cookiesD[i], paymentMethod: tenantD.paymentMethod, index: `d${i}` });
  }

  const { results, wallMs } = await burst(requests);
  reportLatency(results, wallMs);

  const okC = results.filter((r) => r.domain === tenantC.domain && r.status === 201).length;
  const okD = results.filter((r) => r.domain === tenantD.domain && r.status === 201).length;
  const refused = rejections(results);

  for (const [t, served] of [
    [tenantC, okC],
    [tenantD, okD],
  ]) {
    const orders = Number(sqlOne(`SELECT count(*) FROM "Order" WHERE "tenantId" = ${lit(t.tenantId)}`));
    const nums = sql(
      `SELECT count(DISTINCT number), coalesce(min(number),0), coalesce(max(number),0)
       FROM "Order" WHERE "tenantId" = ${lit(t.tenantId)}`,
    )[0].map(Number);
    assert(orders === served, `${t.slug}: Order rows match its own 201s`, `${orders} rows, ${served} × 201`);
    assert(
      nums[0] === served && (served === 0 || (nums[1] === 1 && nums[2] === served)),
      `${t.slug}: its OWN order numbering is dense 1..${served}, unaffected by the other tenant`,
      `distinct ${nums[0]}, min ${nums[1]}, max ${nums[2]}`,
    );
  }

  // The contamination check proper: an order line in one tenant pointing at
  // the other tenant's product, or an OrderItem whose tenantId disagrees
  // with its parent Order's.
  const foreignItems = Number(
    sqlOne(`
      SELECT count(*) FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
      WHERE o."tenantId" IN (${lit(tenantC.tenantId)}, ${lit(tenantD.tenantId)})
        AND oi."productId" IS NOT NULL
        AND oi."productId" <> CASE WHEN o."tenantId" = ${lit(tenantC.tenantId)}
                                   THEN ${lit(tenantC.productId)}::uuid ELSE ${lit(tenantD.productId)}::uuid END`),
  );
  const mismatchedItems = Number(
    sqlOne(`
      SELECT count(*) FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
      WHERE o."tenantId" IN (${lit(tenantC.tenantId)}, ${lit(tenantD.tenantId)})
        AND oi."tenantId" <> o."tenantId"`),
  );
  assert(foreignItems === 0, 'no order line references the other tenant\'s product', `${foreignItems} foreign lines`);
  assert(mismatchedItems === 0, 'every OrderItem.tenantId matches its Order.tenantId', `${mismatchedItems} mismatched`);

  const cRls = rlsScopedOrderCounts(tenantC.tenantId, tenantD.tenantId);
  const dRls = rlsScopedOrderCounts(tenantD.tenantId, tenantC.tenantId);
  assert(
    cRls.own === okC && cRls.other === 0,
    `under RLS as ventia_app, ${tenantC.slug} sees its ${okC} orders and 0 of the other tenant's`,
    `own ${cRls.own}, other ${cRls.other}`,
  );
  assert(
    dRls.own === okD && dRls.other === 0,
    `under RLS as ventia_app, ${tenantD.slug} sees its ${okD} orders and 0 of the other tenant's`,
    `own ${dRls.own}, other ${dRls.other}`,
  );

  capacity(okC === perTenant && okD === perTenant, `both tenants got a 201 for all ${perTenant} of their requests`, `C ${okC}, D ${okD}`);
  capacity(refused.length === 0, 'nothing was refused (no 429) or dropped (no 5xx / transport error)', summarizeRejections(refused));
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`${C.bold}Ventia load test — ${CONCURRENCY} concurrent checkouts${C.off}`);
  console.log(`  API           ${API_URL}`);
  console.log(`  Database      ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
  console.log(`  Run id        ${RUN}`);

  const health = await fetch(`${API_URL}/v1/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(
      `\nerror: the API is not answering at ${API_URL}/v1/health.\n` +
        '       Start it first, e.g.:\n' +
        '       DATABASE_URL=... REDIS_URL=redis://localhost:6379 AUTH_SECRET=dev-secret-change-me \\\n' +
        '         PAYMENTS_ENCRYPTION_KEY=ZGV2LW9ubHktZTJlLWtleS0zMi1ieXRlcy1sb25nISE= \\\n' +
        '         pnpm --filter @ventia/api dev',
    );
    process.exit(1);
  }
  await health.arrayBuffer();

  const half = Math.floor(CONCURRENCY / 2);
  const tenants = {
    a: seedTenant({ label: 'a', stock: CONCURRENCY, paymentMethod: 'wompi' }),
    b: seedTenant({ label: 'b', stock: half, paymentMethod: 'wompi' }),
    c: seedTenant({ label: 'c', stock: half, paymentMethod: 'cod' }),
    d: seedTenant({ label: 'd', stock: half, paymentMethod: 'cod' }),
  };
  console.log(`  Seeded        4 tenants (slug prefix loadtest-*-${RUN})`);

  // Ctrl-C / SIGTERM must not leave 4 tenants and a few hundred orders behind
  // in a shared dev database: `finally` alone does not run when the process is
  // signalled, and an interrupted run was in fact observed leaving exactly
  // that residue. Both handlers do the same cleanup the happy path does, then
  // re-exit with the conventional 128+signal status.
  const cleanup = () => {
    if (KEEP_DATA) return;
    try {
      const ids = Object.values(tenants).map((t) => lit(t.tenantId)).join(', ');
      sql(`DELETE FROM "InventoryMovement" WHERE "tenantId" IN (${ids})`);
      sql(`DELETE FROM "NotificationLog" WHERE "tenantId" IN (${ids})`);
      sql(`DELETE FROM "Tenant" WHERE id IN (${ids})`);
    } catch {
      console.error(`\ncleanup failed — remove them by hand: DELETE FROM "Tenant" WHERE slug LIKE 'loadtest-%-${RUN}';`);
    }
  };
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
      console.log(`\n${C.dim}${signal} — cleaning up the loadtest-*-${RUN} tenants before exiting.${C.off}`);
      cleanup();
      process.exit(code);
    });
  }

  const startedAt = Date.now();
  try {
    if (SCENARIOS.has('1')) await scenarioCapacity(tenants.a, CONCURRENCY);
    if (SCENARIOS.has('2')) await scenarioOversell(tenants.b, CONCURRENCY);
    if (SCENARIOS.has('3')) await scenarioCrossTenant(tenants.c, tenants.d, half);
  } finally {
    if (KEEP_DATA) {
      console.log(`\n${C.dim}KEEP_LOAD_TEST_DATA=1 — leaving the loadtest-*-${RUN} tenants in place.${C.off}`);
    } else {
      // InventoryMovement and NotificationLog carry a tenantId but no FK to
      // Tenant (schema.prisma), so `DELETE FROM "Tenant"` does NOT cascade to
      // them — they have to be deleted explicitly or every run leaves a few
      // hundred orphan rows behind in the dev database.
      cleanup();
      console.log(`\n${C.dim}Cleaned up the 4 loadtest-*-${RUN} tenants (orders/carts/products cascade).${C.off}`);
    }
  }

  console.log(`\n${'='.repeat(66)}`);
  console.log(
    ` Invariants (correctness): ${invariantFailures === 0 ? `${C.green}all passed${C.off}` : `${C.red}${invariantFailures} FAILED${C.off}`}`,
  );
  console.log(
    ` Capacity (load served):   ${capacityFailures === 0 ? `${C.green}all passed${C.off}` : `${C.yellow}${capacityFailures} FAILED${C.off}`}`,
  );
  console.log(` Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (sawRateLimit) {
    console.log(
      `\n${C.yellow}note:${C.off} some requests got 429 TOO_MANY_REQUESTS. The checkout limiter allows\n` +
        '      60 requests per IP per minute and this whole test comes from one address.\n' +
        '      Re-run the API with RATE_LIMIT_CHECKOUT_PER_MINUTE=100000 to measure the\n' +
        '      checkout path itself rather than the limiter.',
    );
  }
  if (sawPoolStall) {
    console.log(
      `\n${C.yellow}note:${C.off} some requests failed with a 5xx after ~15s — that is Prisma's interactive-\n` +
        '      transaction timeout, and for this endpoint it means CONNECTION-POOL STARVATION,\n' +
        '      not a slow query. CheckoutService.checkout() calls ShippingService.isCodAllowed()\n' +
        '      and .priceFor() from INSIDE platformDb.$transaction(), and those go through\n' +
        '      tenantDb(), which needs a SECOND connection from the same pool. Once a burst has\n' +
        '      enough checkouts open to hold every pooled connection, none of them can obtain the\n' +
        '      second one and they all sit idle-in-transaction until the 15s timeout fires\n' +
        '      (confirmed with pg_stat_activity: N connections idle-in-transaction, 0 active).\n' +
        '      THIS WAS FIXED — checkout loads the shipping config before opening the\n' +
        '      transaction (see docs/operations.md, Finding 2). Seeing this note again means\n' +
        '      a nested tenantDb() read has come back inside a $transaction somewhere on the\n' +
        '      checkout path. Widening `connection_limit` hides it; do not do that instead.',
    );
  }
  console.log('='.repeat(66));
  process.exit(invariantFailures === 0 && capacityFailures === 0 ? 0 : 1);
}

await main();
