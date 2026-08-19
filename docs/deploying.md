# Deploying Ventia, and taking a pilot merchant live

*Written 2026-08-19, at the end of P6.*

Target: **one Ubuntu 24.04 VPS**, running everything — Postgres, Redis, MinIO,
the three Node services and Caddy — as containers, with images built on the box.

Nothing here has been deployed to a real host, and this document does not
pretend otherwise. What exists is the full set of artifacts, the reasoning
behind them, and an honest account of which parts have been executed and which
have only been written. §0 is the short path; the sections after it are why
each step is there.

**Minimum box:** 4 GB RAM (two Next.js builds peak around 1.5–2 GB each on top
of Postgres, Redis and MinIO), 2 vCPU, 40 GB disk. `provision-ubuntu.sh` adds
swap sized from RAM, but swap is a safety net for a build, not a substitute for
memory.

The last P6 Definition-of-Done item is *"two pilot merchants live on custom
domains"*. That is the only P6 item that cannot be completed from a
development environment, because it requires real merchants, real payment
credentials and real DNS. §8 is the checklist for it.

---

## 0. The short path

Everything below assumes a fresh VPS, a domain whose DNS you control, and that
you have read §1 (two secrets that cannot be regenerated) before you start.

```bash
# --- on the VPS, as root -----------------------------------------------------
git clone <your-repo-url> /srv/ventia && cd /srv/ventia
bash scripts/provision-ubuntu.sh --dry-run     # read what it will change
bash scripts/provision-ubuntu.sh               # docker, swap, ufw, deploy user

# --- DNS, before anything asks for a certificate -----------------------------
#   A     yourdomain.co        -> <VPS IP>
#   A     *.yourdomain.co      -> <VPS IP>      (tenant subdomains)
#   A     api.yourdomain.co    -> <VPS IP>
#   A     admin.yourdomain.co  -> <VPS IP>
#   A     cdn.yourdomain.co    -> <VPS IP>
# The wildcard is what makes a new merchant's store reachable the moment they
# sign up, with no DNS change per tenant.

# --- as the deploy user ------------------------------------------------------
cp .env.production.example .env && chmod 600 .env
openssl rand -base64 32        # -> AUTH_SECRET
openssl rand -base64 32        # -> PAYMENTS_ENCRYPTION_KEY
$EDITOR .env                   # fill everything; see §1-§2

bash scripts/deploy.sh --check-env   # refuses on dev defaults, not just blanks
bash scripts/deploy.sh               # backup -> build -> migrate -> up -> verify

# --- make the operator real (§3) ---------------------------------------------
# sign up at https://admin.yourdomain.co, verify the email, then:
docker compose -f docker/compose.prod.yaml exec postgres \
  psql -U ventia -d ventia -c \
  "UPDATE \"User\" SET \"isPlatformAdmin\" = true WHERE email = 'ops@yourdomain.co';"

# --- schedule the backups (§7) — they are not automatic ----------------------
bash scripts/install-cron.sh
```

`deploy.sh` runs nine phases and stops on the first failure. It takes a
`pg_dump` **before** migrating, because a migration is the most likely moment
to need one. **It does not roll back** — its own header carries the exact
recovery commands for a failure before and after the migrate phase. Read that
section before you need it, not during.

---

## 1. What must be set before the API will work at all

Two variables have no default and no fallback. The API boots without them and
fails later, at the worst moment:

| | |
| --- | --- |
| `AUTH_SECRET` | Signs sessions **and** the impersonation grant. `openssl rand -base64 32`. Rotating it logs everyone out; that is the intended blast radius. |
| `PAYMENTS_ENCRYPTION_KEY` | AES-256-GCM key for per-tenant gateway credentials **and** WhatsApp credentials at rest. Must be base64 of exactly 32 bytes: `openssl rand -base64 32`. |

**Losing `PAYMENTS_ENCRYPTION_KEY` is not recoverable.** Every merchant's
stored gateway and WhatsApp credentials become undecryptable ciphertext, and
every one of them has to re-enter their keys. Back it up somewhere that is not
the same machine as the database, and not the same backup as the database
either — a backup that contains both the ciphertext and the key protects
neither.

`DOMAIN_VERIFICATION_SECRET` falls back to `PAYMENTS_ENCRYPTION_KEY` when
unset, which is fine for a single-key deployment. Set it separately only if you
rotate the payments key on a different schedule — rotating it invalidates every
published-but-not-yet-verified domain token.

## 2. Hostnames

`PLATFORM_ROOT_DOMAIN` is what every tenant subdomain hangs off, and what the
tenant resolver strips to find a slug. In dev it is `ventia.localhost`; in
production it is your real apex.

`STOREFRONT_PUBLIC_SCHEME` is normally inferred and normally should be left
alone: `localhost`/`*.local`/`*.test` get `http`, every publicly registrable
domain gets `https`. Set it only for a deployment the inference gets wrong,
such as a staging host served over plain HTTP.

## 3. The platform operator, which is a two-step grant

`PLATFORM_ADMIN_EMAILS` alone is **not** enough, deliberately — see
`services/api/src/platform/platform-admin.guard.ts`. Three conditions, all
required:

1. the address is in `PLATFORM_ADMIN_EMAILS` (deployment config);
2. that user's email is verified (they clicked the link);
3. `User.isPlatformAdmin` is true.

Nothing in the product writes step 3. After the operator signs up and verifies:

```sql
UPDATE "User" SET "isPlatformAdmin" = true WHERE email = 'ops@yourdomain.co';
```

Until you run it they get a 403 and the API logs a line telling them exactly
this. **Unset `PLATFORM_ADMIN_EMAILS` denies everyone** — including you. That
is the correct direction for it to fail, and it means a fresh environment has
no operator until someone deliberately creates one.

## 4. Payments

Credentials are **per tenant**, entered by each merchant in
Configuración → Pagos, and encrypted at rest. There is no platform-level
gateway key.

What the platform operator has to do: nothing, except make sure each pilot
merchant has a real Wompi / Mercado Pago / ePayco merchant account of their
own.

> **Never verified against a live gateway.** No sandbox account was available
> at any point in this project. All three adapters are verified against
> recorded fixtures and their documented signature schemes only. The first
> real transaction on each gateway is a test, and should be a small one that
> the merchant is standing next to. Watch for: the webhook actually arriving
> (a `WebhookEvent` row), the signature verifying, and `Order.paymentStatus`
> reaching `PAID`. `docs/operations.md` has the reconciliation worker, which
> is what covers a webhook that never arrives.

## 5. WhatsApp

One decision is platform-level and is made in the Meta dashboard rather than
here: **which Meta app the numbers live under**. Meta delivers one webhook per
*app*, covering every number registered under it, so that app's webhook URL and
its App Secret are shared by every tenant on the deployment.

Everything else is per tenant. Full walkthrough in
[`docs/deploying-whatsapp.md`](deploying-whatsapp.md).

> **Never verified against live Meta traffic.** The Cloud API adapter is
> verified against recorded payloads and the documented `X-Hub-Signature-256`
> scheme. The handshake (`hub.challenge`) is the first thing that will tell you
> whether the URL and verify token are right — Meta will not save the webhook
> until it passes.

## 6. Custom domains and TLS

`docker/Caddyfile.prod` is the production config — `caddy validate` clean, and
used by `compose.prod.yaml`. It reads `PLATFORM_ROOT_DOMAIN` from the
environment, so it is not edited per deployment; that value **must match the
API's**, since it is what onboarding mints `${slug}.${root}` subdomains from
and what the TLS gate recognises them by.

Known hostnames (apex, `api.`, `admin.`, `cdn.`) get ordinary HTTP-01
certificates. Tenant subdomains and merchant custom domains both go through
on-demand issuance behind the `ask` gate.

> **A bug worth knowing about, because it was invisible until this point.**
> Every tenant gets `${slug}.${root}` at onboarding, and the gate originally
> required the `customDomain` plan entitlement — which `basico` does not have.
> Every basic-plan storefront would have been refused a certificate for its own
> address. Fixed: the plan gate now applies only to domains outside our zone,
> which is what "custom domain" means. It never appeared in development because
> `.localhost` needs no certificate, so this endpoint's first real caller is
> your VPS.

That endpoint is the issuance gate, and it answers 200 only when **all four**
are true: the domain is registered to a tenant, `verifiedAt` is set, the tenant
is `live`, and its plan includes `customDomain`. Anything else is a 403 and
Caddy will not request a certificate.

Without that gate, on-demand TLS will request a certificate for **any**
hostname pointed at the box, which is how a deployment gets itself
rate-limited by Let's Encrypt by a stranger.

The merchant's side is a DNS TXT record at `_ventia-verify.<domain>`; the admin
shows the exact value.

## 7. Backups, which are not optional and are not automatic

`scripts/backup.sh` and `scripts/backup-upload.mjs` exist and both have been
exercised (`docs/operations.md` has the measured runs, including a restore
drill of a *downloaded* copy). **Neither is scheduled by anything in this
repo.**

Install the schedule, and chain with `&&` so a failed backup is never followed
by an upload that makes a bad run look like a good one:

```cron
15 3 * * * cd /srv/ventia && BACKUP_DIR=/var/backups/ventia bash scripts/backup.sh && node scripts/backup-upload.mjs >> /var/log/ventia-backup.log 2>&1
0  4 * * 0 cd /srv/ventia && bash scripts/restore-drill.sh --latest >> /var/log/ventia-drill.log 2>&1
```

Offsite needs `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`
and `BACKUP_S3_SECRET_KEY` — an R2 bucket and an API token pair. The upload
refuses to run half-configured rather than silently skipping.

`scripts/install-cron.sh` installs all of it, and **refuses to install without
a notification channel** unless you explicitly override — because a backup
whose failures go to a logfile nobody reads is a backup nobody has. Configure
`VENTIA_ALERT_COMMAND` (any command) or `VENTIA_ALERT_WEBHOOK_URL`. When
notification itself fails, the wrapper prints `ALERT NOT DELIVERED — this
failure reached nobody`, so "the job failed" and "the job failed and nobody
heard" never look alike.

**Product images are backed up separately**, by `scripts/backup-objects.mjs`.
`backup.sh` dumps Postgres only, and with MinIO on this same box that would
mean a recovery where every order, price and customer is intact and every
product renders a broken image. The nightly chain runs both, `&&`-joined so a
failed dump is never followed by an upload that makes a bad run look good.

> **Not exercised.** The cron itself, on a real box. The scripts and both
> restore drills have been run end to end here (see `docs/operations.md`), but
> `install-cron.sh` writing a crontab that then actually fires at 03:15 on your
> VPS is unverified. Check the first morning.

> **Offsite still needs somewhere that is not this VPS.** `BACKUP_S3_*` can
> point at any S3-compatible target. Pointing it at the MinIO running on this
> same box is not a backup — the uploader refuses that exact case for the
> object archive, but nothing stops you doing it for the database dump.

There is no WAL archiving and no point-in-time recovery. **RPO is one nightly
dump** — up to 24 hours of orders. That may be acceptable for a pilot; it
should be a deliberate decision rather than a discovery.

## 8. Pilot checklist

For each of the two or three pilot merchants:

- [ ] Tenant created and `live`; plan assigned in the operator console.
- [ ] Subscription recorded (plan, price, paid-until) — otherwise the
      auto-suspend sweep ignores them entirely, which is the safe direction but
      also means nothing tracks whether they have paid.
- [ ] **Their own** payment gateway credentials entered and "test connection"
      passing.
- [ ] Shipping methods configured for the departamentos they actually ship to,
      and COD restrictions set if their carrier does not offer it everywhere.
- [ ] Privacy policy generated from their store data, **reviewed and edited by
      them**, and published. The generator fills what it can; anything still
      marked `[COMPLETAR: …]` is a field only they can supply. They are the
      *Responsable del Tratamiento*, not Ventia — this is not a step to do on
      their behalf.
- [ ] Custom domain added, TXT record published, verification passing, and a
      certificate actually issued (watch the Caddy log for the first request).
- [ ] One real end-to-end sale, by a real person, with a small amount: browse →
      cart → checkout → payment → merchant confirms → shipped → delivered, with
      the emails arriving at each step.
- [ ] `AGENT_RETENTION_MONTHS` and `SUBSCRIPTION_GRACE_DAYS` reviewed — the
      defaults (12 months, 7 days) are reasonable but they are policy, not
      technical constants.

## 9. What is still missing, stated plainly

- **No CI/CD.** There is no pipeline and no registry; `deploy.sh` builds on the
  box. Migration ordering, which this section used to list as unenforced, IS
  now enforced — `compose.prod.yaml`'s `migrate` service gates the API on
  `service_completed_successfully`, so a failed migration leaves the old API
  running rather than starting a new one against a schema it does not match.
- **No staging environment**, so the first time this runs anywhere but a
  laptop is production.
- **No load testing above 100 concurrent checkouts**, and none at all against
  real hardware — `scripts/load-test.mjs` ran against the dev stack.
  `docs/operations.md` has the numbers and their caveats.
- **Impersonation** has a design (`docs/superpowers/specs/`) and, depending on
  when you read this, an implementation. Check before assuming.
- **No dependency-vulnerability gate** in CI, and no penetration test. Both are
  listed in `docs/security-checklist.md` under what the audit did not cover.
