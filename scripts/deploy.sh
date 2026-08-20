#!/usr/bin/env bash
# The deploy loop, run ON THE VPS from the repo root. Single-host deployment:
# images are built here, Postgres and MinIO are in the same compose stack, and
# there is no registry, no CI and no staging (docs/deploying.md §9).
#
# Phases, in order, each one fatal:
#   0  preflight     — tools, disk, compose file, clean tree
#   1  env           — .env complete AND not still full of dev defaults
#   2  checkout      — fetch + check out the requested ref
#   3  backup        — pg_dump BEFORE anything touches the schema
#   4  build         — docker compose build
#   5  migrate       — prisma migrate deploy, verified by counting migrations
#   6  up            — docker compose up -d
#   7  health        — every service running/healthy, with a timeout
#   8  verify        — real HTTP requests against the running containers
#
# ===========================================================================
# WHAT THIS SCRIPT DOES NOT DO — read this part before you need it.
#
# IT DOES NOT ROLL BACK. There is no automatic revert, deliberately: an
# automatic rollback that runs while an operator is also intervening turns one
# incident into two, and a schema migration cannot be undone by re-running an
# old image anyway (Prisma has no down-migrations; `migrate deploy` is
# forward-only).
#
# If a phase fails, the stack is left EXACTLY as that phase left it, and the
# script prints the previous commit. Recovery, by which phase failed:
#
#   before phase 5 (migrate)   Nothing has changed the database. Check out the
#                              previous commit and re-run this script:
#                                git checkout <PREVIOUS_COMMIT> && bash scripts/deploy.sh
#
#   phase 5 or later           The schema has moved. Rolling the CODE back is
#                              not enough — the old code will meet a newer
#                              schema. Restore the dump phase 3 took (its path
#                              is printed at the end of every run and again on
#                              failure):
#                                docker compose -f docker/compose.prod.yaml stop api admin storefront
#                                pg_restore --clean --if-exists --dbname="$DATABASE_URL" <DUMP>
#                                git checkout <PREVIOUS_COMMIT> && bash scripts/deploy.sh
#                              Everything written between the dump and now is
#                              lost by that restore. That is the trade, and it
#                              is why phase 3 refuses to be skipped silently.
#
# It also does not: manage DNS or TLS (Caddy does, docs/deploying.md §6),
# seed anything, promote a platform admin (§3 — one SQL statement, by hand),
# or drain traffic before restarting. Restarts are a hard cut; requests in
# flight are dropped. On a single box with a pilot's traffic that is honest,
# and it is stated here rather than discovered.
# ===========================================================================
#
# Usage:
#   bash scripts/deploy.sh                 # deploy origin/<current branch>
#   bash scripts/deploy.sh v1.4.0          # deploy a tag/branch/sha
#   bash scripts/deploy.sh --check-env     # validate .env and exit (changes nothing)
#
# Options:
#   --check-env        run phase 1 only
#   --skip-backup      deploy with NO rollback point (says so, loudly)
#   --skip-build       reuse the images already built (for a config-only redeploy)
#   --allow-dirty      deploy with uncommitted changes in the working tree
#   --no-fetch         do not talk to the remote; deploy what is already here
#   --timeout <sec>    health wait, default 180
#
# Env overrides:
#   ENV_FILE           default .env
#   COMPOSE_FILE       default docker/compose.prod.yaml
#   MIGRATE_CMD        how to run migrations; see phase 5
#   BACKUP_DATABASE_URL  how THIS HOST reaches Postgres (the .env DATABASE_URL
#                      usually names a compose service, which the host cannot
#                      resolve). Default: DATABASE_URL from .env.
#   DB_SERVICE         compose service running Postgres, default "postgres"
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${ENV_FILE:=.env}"
: "${COMPOSE_FILE:=docker/compose.prod.yaml}"
: "${DB_SERVICE:=postgres}"

REF=""
CHECK_ENV_ONLY=0
SKIP_BACKUP=0
SKIP_BUILD=0
ALLOW_DIRTY=0
NO_FETCH=0
HEALTH_TIMEOUT=180

while [ $# -gt 0 ]; do
  case "$1" in
    --check-env) CHECK_ENV_ONLY=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --no-fetch) NO_FETCH=1; shift ;;
    --timeout) HEALTH_TIMEOUT="${2:?--timeout needs seconds}"; shift 2 ;;
    -h | --help) sed -n '2,80p' "$0"; exit 0 ;;
    -*) echo "error: unknown option '$1'" >&2; exit 2 ;;
    *) REF="$1"; shift ;;
  esac
done

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'

PHASE_TIMES=""
PHASE_START=0
CURRENT_PHASE=""
DUMP_PATH=""
PREVIOUS_COMMIT=""

phase() {
  CURRENT_PHASE="$1"
  PHASE_START="$(date +%s)"
  echo
  echo "${BOLD}==> $1${OFF}"
}
phase_done() {
  local secs=$(( $(date +%s) - PHASE_START ))
  PHASE_TIMES+="$(printf '  %-28s %4ds\n' "$CURRENT_PHASE" "$secs")"$'\n'
}

# Every failure exits through here, so no run can end without saying what
# state it left behind — the "half-deployed and silent" outcome is the one
# this script exists to make impossible.
on_error() {
  local status=$?
  echo
  echo "${RED}=============================================================="
  echo " DEPLOY FAILED during: ${CURRENT_PHASE:-preflight}   (exit $status)"
  echo "==============================================================${OFF}"
  if [ -n "$PREVIOUS_COMMIT" ]; then echo " previous commit: $PREVIOUS_COMMIT"; fi
  if [ -n "$DUMP_PATH" ]; then echo " pre-migration dump: $DUMP_PATH"; fi
  echo
  echo " The stack was NOT rolled back. Read the recovery section at the top"
  echo " of $0 — which recovery applies depends on whether the failure was"
  echo " before or after the migrate phase."
  echo
  echo " Current state:"
  docker compose -f "$COMPOSE_FILE" ps 2>/dev/null || true
  exit "$status"
}
trap on_error ERR

# ---------------------------------------------------------------------------
phase "Phase 0 — preflight"
# ---------------------------------------------------------------------------
# --check-env is about the FILE, not about this machine, so it does not
# require a deployable host (you may be running it on a laptop before
# shipping the file to the server).
if [ "$CHECK_ENV_ONLY" = "1" ]; then
  echo "  skipped — --check-env validates $ENV_FILE only"
else

[ -d .git ] || { echo "error: $ROOT_DIR is not a git checkout." >&2; exit 1; }
[ -f "$COMPOSE_FILE" ] || { echo "error: $COMPOSE_FILE not found. Are you on the branch that has it?" >&2; exit 1; }

for bin in docker git curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: $bin not found on PATH (scripts/provision-ubuntu.sh installs it)." >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "error: the docker compose plugin is not installed." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "error: cannot talk to the Docker daemon as $(id -un). Is this user in the docker group (log out and back in after being added)?" >&2; exit 1; }

if [ "$(id -u)" = "0" ]; then
  # Not fatal, but worth a line: files written by root into a bind mount are
  # a recurring source of "permission denied" the next time a non-root deploy
  # user runs this.
  echo "${YELLOW}warning:${OFF} running as root. The deploy user in the docker group is the intended way."
fi

# A build needs room for the image layers AND the Next.js build cache. Running
# out mid-build leaves dangling layers and a stack that is neither old nor new.
AVAIL_MB="$(df -Pm . | awk 'NR==2 {print $4}')"
echo "  disk available: ${AVAIL_MB} MB"
if [ "$AVAIL_MB" -lt 5000 ] && [ "$SKIP_BUILD" != "1" ]; then
  echo "error: only ${AVAIL_MB} MB free. Building three Node images needs more headroom than that." >&2
  echo "       Free space (docker system prune -f) or deploy with --skip-build." >&2
  exit 1
fi

TOTAL_RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
SWAP_MB="$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)"
echo "  ram: ${TOTAL_RAM_MB} MB, swap: ${SWAP_MB} MB"
if [ "$SKIP_BUILD" != "1" ] && [ "$TOTAL_RAM_MB" -lt 4096 ] && [ "$SWAP_MB" -lt 1024 ]; then
  # This is the documented way this deployment fails: a Next.js production
  # build on a 2 GB box with no swap gets OOM-killed, and the error surfaces
  # as an opaque "exit code 137" three minutes into the build.
  echo "error: ${TOTAL_RAM_MB} MB RAM and only ${SWAP_MB} MB swap. The Next.js builds will be OOM-killed." >&2
  echo "       Run scripts/provision-ubuntu.sh (it creates swap), or deploy with --skip-build." >&2
  exit 1
fi

if [ "$ALLOW_DIRTY" != "1" ] && [ -n "$(git status --porcelain)" ]; then
  echo "error: the working tree has uncommitted changes:" >&2
  git status --short >&2
  echo "       A deploy from a hand-edited tree cannot be reproduced or rolled back to." >&2
  echo "       Commit them, discard them, or pass --allow-dirty." >&2
  exit 1
fi

fi
phase_done

# ---------------------------------------------------------------------------
phase "Phase 1 — environment"
# ---------------------------------------------------------------------------
# Values are extracted with sed rather than by sourcing the file: `.env` is
# also read by docker compose, which does NOT run it as a shell, and a deploy
# script that executes its config file would run whatever a stray backtick in
# a password happened to spell.
[ -f "$ENV_FILE" ] || {
  echo "error: $ENV_FILE does not exist. Copy .env.production.example and fill it in." >&2
  exit 1
}
env_get() {
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

MISSING=""
BAD=""
WARNINGS=""
require() {
  local key="$1" why="$2"
  local val
  val="$(env_get "$key")"
  if [ -z "$val" ]; then MISSING+="  $key — $why"$'\n'; fi
}
reject() { # key, forbidden-value, why
  local val
  val="$(env_get "$1")"
  if [ -n "$val" ] && [ "$val" = "$2" ]; then BAD+="  $1 is still the DEVELOPMENT default ('$2') — $3"$'\n'; fi
}

# Hard-required by packages/core/src/env.ts (no default, boot fails without).
require DATABASE_URL           "Postgres connection string"
require REDIS_URL              "queues, rate limits and sessions"
require AUTH_SECRET            "signs sessions and impersonation grants (openssl rand -base64 32)"
require PAYMENTS_ENCRYPTION_KEY "AES-256-GCM key for per-tenant gateway + WhatsApp credentials at rest"
# Everything below HAS a dev default, which is exactly why it is checked here:
# the API boots happily with all of them and misbehaves in production.
require PLATFORM_ROOT_DOMAIN   "every tenant subdomain hangs off it; the dev default is ventia.localhost"
require PLATFORM_ADMIN_EMAILS  "unset denies EVERY operator, including you (docs/deploying.md §3)"
require API_URL                "public API origin"
require API_PUBLIC_URL         "shown to merchants as the WhatsApp webhook URL"
require ADMIN_URL              "auth trusted origin AND the link in every staff invite email"
require STOREFRONT_INTERNAL_URL "how the API reaches the storefront to revalidate ISR pages"
require REVALIDATE_SECRET      "authenticates those revalidate calls"
require S3_ENDPOINT            "product images"
require S3_ACCESS_KEY          "product images"
require S3_SECRET_KEY          "product images"
require S3_BUCKET              "product images"
require S3_PUBLIC_URL          "the origin baked into every stored image URL — changing it later orphans them"
# Not in the zod schema (it is .optional()), required here anyway: without it
# MailerModule silently falls back to ConsoleMailer, so every order
# confirmation, verification link and staff invite is written to the API's
# stdout and nobody is ever told. That is worse than a boot failure.
require RESEND_API_KEY         "without it every outbound email is silently printed to stdout instead of sent"
require RESEND_FROM_EMAIL      "the dev default is a .localhost address Resend will reject"

reject AUTH_SECRET dev-secret-change-me "every session token on this deployment would be forgeable"
reject REVALIDATE_SECRET dev-revalidate-secret "anyone could force cache revalidation"
reject S3_SECRET_KEY ventia-secret "the object store would be world-writable to anyone who read this repo"
reject S3_ACCESS_KEY ventia "same"

AUTH_SECRET_VAL="$(env_get AUTH_SECRET)"
if [ -n "$AUTH_SECRET_VAL" ] && [ "${#AUTH_SECRET_VAL}" -lt 32 ]; then
  BAD+="  AUTH_SECRET is ${#AUTH_SECRET_VAL} characters; use at least 32 (openssl rand -base64 32)"$'\n'
fi

PEK="$(env_get PAYMENTS_ENCRYPTION_KEY)"
if [ -n "$PEK" ]; then
  # Checked HERE because the alternative is finding out at the moment a
  # merchant saves their gateway credentials. Same rule as
  # packages/core/src/env.ts: base64 of exactly 32 raw bytes.
  PEK_BYTES="$(printf '%s' "$PEK" | base64 -d 2>/dev/null | wc -c || echo 0)"
  if [ "$PEK_BYTES" != "32" ]; then
    BAD+="  PAYMENTS_ENCRYPTION_KEY decodes to $PEK_BYTES bytes, must be exactly 32 (openssl rand -base64 32)"$'\n'
  fi
fi

ROOT_DOMAIN="$(env_get PLATFORM_ROOT_DOMAIN)"
case "$ROOT_DOMAIN" in
  *.localhost | *.local | *.test | localhost)
    BAD+="  PLATFORM_ROOT_DOMAIN is '$ROOT_DOMAIN' — a development TLD. No public certificate can exist for it."$'\n' ;;
esac

for key in API_URL API_PUBLIC_URL ADMIN_URL S3_PUBLIC_URL; do
  val="$(env_get "$key")"
  case "$val" in
    *localhost* | *127.0.0.1*)
      # These four are handed to BROWSERS. A localhost value points the
      # shopper's machine at itself.
      BAD+="  $key is '$val', which points at the visitor's own machine, not this server"$'\n' ;;
  esac
done

case "$(env_get DATABASE_URL)" in
  *ventia:ventia@*) BAD+="  DATABASE_URL still carries the development password (ventia:ventia)"$'\n' ;;
esac

for key in SENTRY_DSN DOMAIN_VERIFICATION_SECRET; do
  [ -n "$(env_get "$key")" ] || WARNINGS+="  $key is unset"$'\n'
done
[ -n "$(env_get ANTHROPIC_API_KEY)" ] || WARNINGS+="  ANTHROPIC_API_KEY is unset — the WhatsApp sales agent will not answer"$'\n'

if [ -n "$MISSING" ] || [ -n "$BAD" ]; then
  echo
  echo "${RED}$ENV_FILE is not deployable.${OFF}"
  if [ -n "$MISSING" ]; then
    echo
    echo "${BOLD}Absent:${OFF}"
    printf '%s' "$MISSING"
  fi
  if [ -n "$BAD" ]; then
    echo
    echo "${BOLD}Present but wrong:${OFF}"
    printf '%s' "$BAD"
  fi
  echo
  echo "Every one of these is listed so you fix them in one pass instead of"
  echo "discovering them one restart at a time."
  exit 1
fi

echo "  ${GREEN}all required variables present and none left at a development default${OFF}"
if [ -n "$WARNINGS" ]; then
  echo "  ${YELLOW}warnings (not fatal):${OFF}"
  printf '%s' "$WARNINGS"
fi

# The permissions of the file that holds every secret on this box.
ENV_PERMS="$(stat -c %a "$ENV_FILE")"
case "$ENV_PERMS" in
  600 | 640 | 400) : ;;
  *) echo "  ${YELLOW}warning:${OFF} $ENV_FILE is mode $ENV_PERMS — it holds every secret here. chmod 600 it." ;;
esac
phase_done

if [ "$CHECK_ENV_ONLY" = "1" ]; then
  echo
  echo "${GREEN}--check-env: $ENV_FILE is deployable.${OFF} Nothing was changed."
  exit 0
fi

# ---------------------------------------------------------------------------
phase "Phase 2 — checkout"
# ---------------------------------------------------------------------------
PREVIOUS_COMMIT="$(git rev-parse HEAD)"
PREVIOUS_SHORT="$(git rev-parse --short HEAD)"
echo "  currently at: $PREVIOUS_SHORT $(git log -1 --format=%s)"

if [ "$NO_FETCH" != "1" ]; then
  git fetch --prune --tags origin
fi
if [ -z "$REF" ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  REF="origin/$BRANCH"
  echo "  no ref given; using $REF"
fi
git rev-parse --verify "$REF^{commit}" >/dev/null 2>&1 || { echo "error: '$REF' is not a commit this checkout knows about." >&2; exit 1; }
git checkout --detach "$REF"
NEW_COMMIT="$(git rev-parse HEAD)"
NEW_SHORT="$(git rev-parse --short HEAD)"
echo "  now at: $NEW_SHORT $(git log -1 --format=%s)"

if [ "$PREVIOUS_COMMIT" = "$NEW_COMMIT" ]; then
  echo "  ${YELLOW}note:${OFF} same commit as before — this is a rebuild, not an upgrade."
else
  echo
  echo "  ${BOLD}Changes $PREVIOUS_SHORT..$NEW_SHORT:${OFF}"
  git log --oneline "$PREVIOUS_COMMIT..$NEW_COMMIT" 2>/dev/null | sed 's/^/    /' || echo "    (histories diverge — not a fast-forward)"
  echo
  # Migrations are the only change class that cannot be undone by redeploying
  # the old commit, so they are named before anything runs.
  MIGRATION_CHANGES="$(git diff --name-only "$PREVIOUS_COMMIT" "$NEW_COMMIT" -- packages/db/prisma/migrations | cut -d/ -f5 | sort -u | tr '\n' ' ')"
  if [ -n "$MIGRATION_CHANGES" ]; then
    echo "  ${YELLOW}This deploy contains SCHEMA MIGRATIONS:${OFF} $MIGRATION_CHANGES"
    echo "  Forward-only. Undoing them means restoring the dump phase 3 is about to take."
  else
    echo "  No new migrations in this range."
  fi
fi
phase_done

# ---------------------------------------------------------------------------
phase "Phase 3 — backup (before anything touches the schema)"
# ---------------------------------------------------------------------------
BACKUP_URL="${BACKUP_DATABASE_URL:-$(env_get DATABASE_URL)}"
if [ "$SKIP_BACKUP" = "1" ]; then
  echo "  ${YELLOW}SKIPPED by --skip-backup.${OFF}"
  echo "  ${YELLOW}This deploy has NO rollback point. If a migration corrupts data,${OFF}"
  echo "  ${YELLOW}the most recent copy is last night's nightly backup.${OFF}"
else
  command -v pg_dump >/dev/null 2>&1 || {
    echo "error: pg_dump is not installed on this host, so no pre-migration backup can be taken." >&2
    echo "       apt-get install postgresql-client-16 (scripts/provision-ubuntu.sh does this)," >&2
    echo "       or accept the risk explicitly with --skip-backup." >&2
    exit 1
  }
  if ! psql "$BACKUP_URL" -tAc 'SELECT 1' >/dev/null 2>&1; then
    # Refusing rather than continuing: the single most likely moment to need a
    # restore is the next 60 seconds, and "we could not reach the database to
    # back it up" is not a reason to migrate it anyway.
    echo "error: cannot reach Postgres at the URL this host would back up." >&2
    echo "       DATABASE_URL in $ENV_FILE usually names a COMPOSE SERVICE (e.g. postgres:5432)," >&2
    echo "       which this host cannot resolve. Set BACKUP_DATABASE_URL to the loopback form," >&2
    echo "       e.g. postgresql://ventia:...@127.0.0.1:5432/ventia, and make sure the compose" >&2
    echo "       file publishes 5432 on 127.0.0.1 only." >&2
    exit 1
  fi
  DUMP_PATH="$(DATABASE_URL="$BACKUP_URL" bash scripts/backup.sh | tail -n1)"
  [ -f "$DUMP_PATH" ] || { echo "error: backup.sh did not produce a dump." >&2; exit 1; }
  echo "  ${GREEN}rollback point:${OFF} $DUMP_PATH ($(stat -c %s "$DUMP_PATH") bytes)"
fi
phase_done

# ---------------------------------------------------------------------------
phase "Phase 4 — build"
# ---------------------------------------------------------------------------
if [ "$SKIP_BUILD" = "1" ]; then
  echo "  ${YELLOW}SKIPPED by --skip-build — the running images are whatever was built last time.${OFF}"
else
  # No --pull: base images are pinned in the Dockerfiles, and silently
  # re-pulling a moving tag is how two "identical" deploys stop being
  # identical. Nothing here is pushed anywhere; the images live on this box.
  docker compose -f "$COMPOSE_FILE" build
fi
phase_done

# ---------------------------------------------------------------------------
phase "Phase 5 — migrate"
# ---------------------------------------------------------------------------
# The ordering docs/deploying.md §9 calls out as unenforced: migrations run
# BEFORE the new API starts, so the new code never meets the old schema.
psql_in_db() {
  # Run SQL inside the Postgres container: the host may have no route to the
  # database except through docker, and this is only ever read-only counting.
  docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" \
    psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}
DB_URL_RAW="$(env_get DATABASE_URL)"
PG_USER="$(printf '%s' "$DB_URL_RAW" | sed -n 's|^[a-z]*://\([^:@/]*\).*|\1|p')"
PG_DB="$(printf '%s' "$DB_URL_RAW" | sed -e 's/?.*$//' -n -e 's|.*/\([^/]*\)$|\1|p')"

MIGRATIONS_BEFORE="$(psql_in_db 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL' || true)"
[ -n "$MIGRATIONS_BEFORE" ] || MIGRATIONS_BEFORE="unknown"
echo "  migrations applied before: $MIGRATIONS_BEFORE"

if [ -n "${MIGRATE_CMD:-}" ]; then
  echo "  using MIGRATE_CMD"
  bash -c "$MIGRATE_CMD"
elif docker compose -f "$COMPOSE_FILE" config --services | grep -qx 'migrate'; then
  docker compose -f "$COMPOSE_FILE" run --rm migrate
elif docker compose -f "$COMPOSE_FILE" config --services | grep -qx 'migrations'; then
  docker compose -f "$COMPOSE_FILE" run --rm migrations
else
  # Refusing instead of guessing. A wrong guess here either does nothing (and
  # the deploy proceeds with an un-migrated database) or runs the wrong
  # command against production data. The operator knows which service in
  # their compose file carries the Prisma CLI; this script does not.
  echo "error: no migration step found." >&2
  echo "       $COMPOSE_FILE defines no 'migrate' or 'migrations' service, and MIGRATE_CMD is unset." >&2
  echo "       Set it to whatever runs 'prisma migrate deploy' against your image, e.g.:" >&2
  echo "         MIGRATE_CMD='docker compose -f $COMPOSE_FILE run --rm --no-deps api pnpm --filter @ventia/db migrate:deploy'" >&2
  exit 1
fi

MIGRATIONS_AFTER="$(psql_in_db 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL' || true)"
if [ "$MIGRATIONS_BEFORE" = "unknown" ] || [ -z "$MIGRATIONS_AFTER" ]; then
  # Said out loud rather than assumed: the migrate command's exit code is not
  # proof that the schema moved.
  echo "  ${YELLOW}could not verify the migration count${OFF} (no psql inside the '$DB_SERVICE' container, or DB_SERVICE is wrong)."
  echo "  ${YELLOW}The migrate step's exit code is the only evidence this deploy has.${OFF}"
else
  echo "  migrations applied after:  $MIGRATIONS_AFTER  (+$((MIGRATIONS_AFTER - MIGRATIONS_BEFORE)))"
  if [ "$MIGRATIONS_AFTER" -gt "$MIGRATIONS_BEFORE" ]; then
    echo "  newest: $(psql_in_db 'SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS LAST LIMIT 1')"
  fi
fi
phase_done

# ---------------------------------------------------------------------------
phase "Phase 6 — up"
# ---------------------------------------------------------------------------
DEPLOY_EPOCH="$(date +%s)"
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans
phase_done

# ---------------------------------------------------------------------------
phase "Phase 7 — wait for health"
# ---------------------------------------------------------------------------
# Container state, from docker's own view. Services WITHOUT a healthcheck can
# only be observed as "running", which is a weaker statement — phase 8 is what
# turns that into evidence.
DEADLINE=$(( $(date +%s) + HEALTH_TIMEOUT ))
while :; do
  PS_JSON="$(docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null || echo '')"
  # compose emits either a JSON array or newline-delimited objects depending
  # on version; `jq -s` over `.[]?` handles both.
  # `.Health` is an EMPTY STRING (not null) for a service with no
  # healthcheck, so `// "-"` alone never fires and the wait loop would spin
  # until the timeout on a perfectly healthy stack.
  SUMMARY="$(printf '%s' "$PS_JSON" | jq -rs 'map(if type=="array" then .[] else . end) | .[] | "\(.Service)\t\(.State)\t\(if ((.Health // "") == "") then "-" else .Health end)"' 2>/dev/null || true)"
  [ -n "$SUMMARY" ] || { echo "error: could not read container state from docker compose ps." >&2; exit 1; }

  NOT_READY="$(printf '%s\n' "$SUMMARY" | awk -F'\t' '$2!="running" || ($3!="-" && $3!="healthy") {printf "%s(%s/%s) ", $1, $2, $3}')"
  EXITED="$(printf '%s\n' "$SUMMARY" | awk -F'\t' '$2=="exited" || $3=="unhealthy" {printf "%s ", $1}')"

  if [ -n "$EXITED" ]; then
    echo "error: service(s) exited or unhealthy: $EXITED" >&2
    for svc in $EXITED; do
      echo "--- last 40 lines of $svc ---" >&2
      docker compose -f "$COMPOSE_FILE" logs --tail=40 "$svc" >&2 || true
    done
    exit 1
  fi
  if [ -z "$NOT_READY" ]; then
    printf '%s\n' "$SUMMARY" | awk -F'\t' '{printf "  %-14s %s %s\n", $1, $2, ($3=="-" ? "(no healthcheck)" : $3)}'
    break
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "error: timed out after ${HEALTH_TIMEOUT}s waiting for: $NOT_READY" >&2
    docker compose -f "$COMPOSE_FILE" ps >&2
    for svc in $(printf '%s\n' "$SUMMARY" | awk -F'\t' '$2!="running" || ($3!="-" && $3!="healthy") {print $1}'); do
      echo "--- last 30 lines of $svc ---" >&2
      docker compose -f "$COMPOSE_FILE" logs --tail=30 "$svc" >&2 || true
    done
    exit 1
  fi
  echo "  waiting for: $NOT_READY"
  sleep 5
done
phase_done

# ---------------------------------------------------------------------------
phase "Phase 8 — verify"
# ---------------------------------------------------------------------------
# "The container is running" is not "the application works". These are real
# HTTP requests, made against the containers' own addresses so they do not
# depend on ports being published or on DNS pointing here yet.
#
# Format: service:port:path:expected-substring (empty substring = any 2xx/3xx)
: "${DEPLOY_HTTP_CHECKS:=api:4000:/v1/health:ok storefront:3000:/: admin:3001:/:}"
VERIFIED=0
SKIPPED=""
SERVICES="$(docker compose -f "$COMPOSE_FILE" config --services)"

for spec in $DEPLOY_HTTP_CHECKS; do
  svc="${spec%%:*}"; rest="${spec#*:}"
  port="${rest%%:*}"; rest="${rest#*:}"
  path="${rest%%:*}"; expect="${rest#*:}"

  if ! printf '%s\n' "$SERVICES" | grep -qx "$svc"; then
    SKIPPED+="$svc "
    continue
  fi
  cid="$(docker compose -f "$COMPOSE_FILE" ps -q "$svc")"
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$cid" | awk '{print $1}')"
  [ -n "$ip" ] || { echo "error: could not determine $svc's container IP." >&2; exit 1; }

  url="http://$ip:$port$path"
  body="$(curl -sS --max-time 20 --fail-with-body "$url" 2>&1)" || {
    echo "error: $svc did not answer $url" >&2
    echo "$body" | head -n 5 >&2
    docker compose -f "$COMPOSE_FILE" logs --tail=30 "$svc" >&2 || true
    exit 1
  }
  if [ -n "$expect" ] && ! printf '%s' "$body" | grep -q "$expect"; then
    # A 200 whose body is wrong is the failure mode a status-code-only check
    # cannot see (an error page rendered with status 200, a proxy default).
    echo "error: $svc answered $url but the body does not contain '$expect':" >&2
    printf '%s\n' "$body" | head -n 5 >&2
    exit 1
  fi
  if [ -n "$expect" ]; then
    echo "  ${GREEN}OK${OFF}  $svc $url  (body contains: $expect)"
  else
    echo "  ${GREEN}OK${OFF}  $svc $url"
  fi
  VERIFIED=$((VERIFIED + 1))

  # Proof the container is running THIS deploy's image rather than having
  # survived it untouched — a compose file that did not change a service
  # leaves the old container up, and every check above would still pass.
  started="$(docker inspect -f '{{.State.StartedAt}}' "$cid")"
  started_epoch="$(date -d "$started" +%s 2>/dev/null || echo 0)"
  if [ "$started_epoch" -lt "$DEPLOY_EPOCH" ]; then
    echo "      ${YELLOW}note:${OFF} this container started before the deploy ($started) — it was not recreated."
  fi
done

if [ -n "$SKIPPED" ]; then echo "  ${YELLOW}not in $COMPOSE_FILE, not checked:${OFF} $SKIPPED"; fi
if [ "$VERIFIED" -eq 0 ]; then
  echo "error: nothing was verified — none of the expected services exist in $COMPOSE_FILE." >&2
  echo "       Set DEPLOY_HTTP_CHECKS to 'service:port:path:expected' triples that match it." >&2
  exit 1
fi
phase_done

trap - ERR
echo
echo "${GREEN}==============================================================${OFF}"
echo "${GREEN} DEPLOY OK${OFF}   $PREVIOUS_SHORT -> $NEW_SHORT"
echo "${GREEN}==============================================================${OFF}"
git log -1 --format='  %h %s (%an, %ar)' 
echo
echo "${BOLD}  phase timings${OFF}"
printf '%s' "$PHASE_TIMES"
echo
echo "  verified:      $VERIFIED HTTP endpoint(s) answering from their containers"
if [ -n "$DUMP_PATH" ]; then echo "  rollback dump: $DUMP_PATH"; fi
if [ "$SKIP_BACKUP" = "1" ]; then echo "  ${YELLOW}rollback dump: NONE — --skip-backup was passed${OFF}"; fi
echo "  previous:      $PREVIOUS_COMMIT"
echo
echo "${DIM}  This checkout is now in detached HEAD at $NEW_SHORT, which is what you"
echo "  want on a server: it is exactly the commit that is running.${OFF}"
