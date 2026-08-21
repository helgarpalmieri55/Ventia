# The OPS feed

One snapshot of **what the platform costs** and **whether it is healthy**, per
store and in total, for an external operations application to consume.

Two transports, one payload. `OpsMetricsService.snapshot()` builds it; the
controller serves it and the worker posts it. There is deliberately no second
assembly path — two payloads meant to be identical but built separately do not
stay identical, and the divergence surfaces as a monitoring system disagreeing
with itself mid-incident.

---

## 1. Turn it on

```bash
openssl rand -hex 32          # -> OPS_METRICS_TOKEN
```

| Variable | Effect when unset |
| --- | --- |
| `OPS_METRICS_TOKEN` | Feed is **off**. `GET /v1/ops/metrics` answers 503; the push never starts. |
| `OPS_PUSH_URL` | No push. The pull endpoint still works. |
| `OPS_PUSH_INTERVAL_SECONDS` | 60. Floor is 10. |
| `AGENT_PRICE_INPUT_USD_PER_MTOK` | Every cost field is `null`. |
| `AGENT_PRICE_OUTPUT_USD_PER_MTOK` | Same — both or neither. |

The token minimum is 32 characters and shorter values are refused rather than
accepted with a warning: this one credential reaches every store's cost and
health in a single response.

---

## 2. Pull

```
GET /v1/ops/metrics
Authorization: Bearer $OPS_METRICS_TOKEN
```

`401` on a wrong or missing token, `503` when the platform side is not
configured — those are different problems and the OPS app should show them
differently. There is no write route in this module and there should never be
one; the credential lives in another application's config file, so whatever it
can reach is what one leaked file gives away.

## 3. Push

Every `OPS_PUSH_INTERVAL_SECONDS`, the same object is POSTed to `OPS_PUSH_URL`:

| Header | Meaning |
| --- | --- |
| `content-type` | `application/json` |
| `x-ventia-timestamp` | ISO-8601, equal to the body's `generatedAt` |
| `x-ventia-signature` | `HMAC-SHA256(timestamp + "." + body)` in hex, keyed with `OPS_METRICS_TOKEN` |

Verify it on your side by recomputing the HMAC over `timestamp + "." + rawBody`
— the **raw** body, before parsing, since re-serializing changes bytes. Reject
a timestamp outside a few minutes of now: the timestamp is inside the signed
material precisely so a captured POST cannot be replayed forever.

A push that fails is logged and dropped. It is never retried, because the next
tick carries fresher data and a queue of stale snapshots is worse than a gap.

**Why both.** Polling answers "what is the state right now", which is what a
dashboard render needs. The push makes the *absence* of data a signal in its
own right — a polled endpoint that stops being polled looks exactly like one
that stopped answering, and only the push distinguishes them.

---

## 4. What is in it

```jsonc
{
  "generatedAt": "2026-08-21T22:00:00.000Z",
  "month": "2026-08",
  "platform": {
    "uptimeSeconds": 3600,          // per PROCESS — a reset means a restart
    "tenants": { "total": 12, "live": 9, "draft": 2, "suspended": 1 },
    "ai": {
      "messages": 4210,
      "inputTokens": 9100000,
      "outputTokens": 1200000,
      "costMicroUsd": 45300000,     // null when prices are unconfigured
      "costCents": 4530             // null when prices are unconfigured
    },
    "costConfigured": true
  },
  "dependencies": {
    "database": { "ok": true, "latencyMs": 1.8 },
    "redis":    { "ok": true }
  },
  "queues": [ /* name, counts, registered schedules, recent failures */ ],
  "stores": [ /* one entry per tenant — see below */ ]
}
```

### Cost is `null`, never `0`, when it is unknown

Every cost field goes `null` if model prices are not configured, and
`platform.costConfigured` says which state you are in. Render "no configurado"
rather than a zero.

This is not defensive style for its own sake. The column this replaced,
`costCents`, was never written by anything — `AgentBudgetService.record()`
incremented the three counters beside it and stopped — so the operator console
read it and reported every store on the platform as costing exactly zero. A
confident wrong number is worse than an absent one, because it gets believed.

Costs accumulate in **micro-USD** (millionths of a dollar): one shopper turn
costs a fraction of a cent, and rounding each increment to whole cents rounds
nearly all of them away. Sum `costMicroUsd` across stores and convert once at
the end; summing `costCents` loses most of the total on a platform of small
stores.

### Per store

```jsonc
{
  "tenantId": "…", "slug": "mitienda", "name": "Mi Tienda",
  "status": "live", "plan": "pro",
  "ai": { "messages": 95, "messagesLimit": 100, "percentUsed": 95,
          "inputTokens": 1000000, "outputTokens": 200000,
          "costMicroUsd": 6000000, "costCents": 600 },
  "storefront": { "hasPrimaryDomain": true, "primaryDomainVerified": true, "customDomains": 2 },
  "orders24h": { "created": 14, "paid": 11, "failed": 1, "stuckPending": 0 },
  "issues": ["ai_budget_warning"],
  "health": "warning"
}
```

`percentUsed` is `null`, not `0`, when there is no limit to be a percentage of
— "0% used" reads as healthy for a store that is actually capped at zero.

### Issue codes

Short and stable, so you can alert on them without parsing prose. Empty
`issues` means healthy.

| Code | Meaning | Severity |
| --- | --- | --- |
| `no_primary_domain` | A **live** store with no domain row — nobody can reach it | critical |
| `primary_domain_unverified` | Live, domain present, never verified — no certificate | critical |
| `orders_stuck_pending` | Orders `PENDING` for over an hour — payments are not settling | critical |
| `ai_budget_exhausted` | At 100% — the agent has stopped answering shoppers | warning |
| `ai_budget_warning` | At or past 90% | warning |
| `ai_budget_unprovisioned` | No `TenantLimits` row, so the budget is a hard zero and the agent never answers | warning |

`critical` is reserved for the two states where a shopper cannot complete a
purchase: an unreachable store, or money taken and not settled. A silent agent
is bad, and it is not that.

A **draft** store with no verified domain is not flagged. It is mid-onboarding,
not broken, and alerting on it would train you to ignore the alert.

---

## 5. What it does not tell you

- **Uptime across replicas.** `uptimeSeconds` is `process.uptime()` of whichever
  instance answered. With more than one API container this is per-replica.
- **Historical series.** Every response is *now*, plus month-to-date AI usage.
  Storing history is the OPS application's job.
- **Anything below the API.** `dependencies` covers Postgres and Redis because
  those are what the API needs to serve a request. Disk, CPU and the host
  itself are your infrastructure monitor's business.
- **`GET /v1/health` is unchanged and still shallow.** It returns `{"status":"ok"}`
  if the process is alive and is what `docker/compose.prod.yaml` runs as the
  container healthcheck. It deliberately does NOT check Postgres or Redis:
  a healthcheck that fails on a Redis blip would restart the API and turn a
  dependency wobble into an outage. Use this feed for dependency health and
  keep `/v1/health` for liveness.
