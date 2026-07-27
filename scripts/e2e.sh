#!/usr/bin/env bash
# P1 Definition-of-Done Playwright e2e runner (Task 8).
#
# Boots the API + admin + storefront dev servers against the ALREADY-RUNNING
# dev stack (docker/compose.yaml — postgres/redis/caddy/minio; this script
# only checks it's up, it never starts it), waits for all three to respond,
# runs the admin app's Playwright suite through Caddy
# (http://admin.ventia.localhost), then tears the servers down again — even
# on failure (the EXIT trap), so a red run never leaves stray dev servers
# bound to 3000/3001/4000.
#
# Usage: bash scripts/e2e.sh
# Env overrides: DATABASE_URL, REDIS_URL, AUTH_SECRET, API_URL,
#   API_INTERNAL_URL, PLATFORM_ROOT_DOMAIN, S3_*, E2E_LOG_DIR.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${E2E_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/ventia-e2e.XXXXXX")}"
mkdir -p "$LOG_DIR"
echo "==> Logs: $LOG_DIR"

API_LOG="$LOG_DIR/api.log"
ADMIN_LOG="$LOG_DIR/admin.log"
STOREFRONT_LOG="$LOG_DIR/storefront.log"

: "${DATABASE_URL:=postgresql://ventia:ventia@localhost:5432/ventia}"
: "${REDIS_URL:=redis://localhost:6379}"
: "${AUTH_SECRET:=dev-secret-change-me}"
: "${API_URL:=http://api.ventia.localhost}"
: "${API_INTERNAL_URL:=http://localhost:4000}"
: "${ADMIN_URL:=http://admin.ventia.localhost}"
: "${PLATFORM_ROOT_DOMAIN:=ventia.localhost}"
: "${S3_ENDPOINT:=http://localhost:9000}"
: "${S3_ACCESS_KEY:=ventia}"
: "${S3_SECRET_KEY:=ventia-secret}"
: "${S3_BUCKET:=ventia}"
: "${S3_PUBLIC_URL:=http://localhost:9000/ventia}"
export DATABASE_URL REDIS_URL AUTH_SECRET API_URL API_INTERNAL_URL ADMIN_URL PLATFORM_ROOT_DOMAIN
export S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_PUBLIC_URL

echo "==> Checking the dev stack (postgres/redis/caddy/minio) is up..."
for name in docker-postgres-1 docker-redis-1 docker-caddy-1 docker-minio-1; do
  if ! docker ps --filter "name=^${name}\$" --filter status=running -q | grep -q .; then
    echo "error: $name is not running. Start the dev stack first:" >&2
    echo "  docker compose -f docker/compose.yaml up -d" >&2
    exit 1
  fi
done

echo "==> Freeing ports 3000/3001/4000 in case a previous run left something behind..."
fuser -k 3000/tcp 3001/tcp 4000/tcp >/dev/null 2>&1 || true
sleep 1

PIDS=()

cleanup() {
  local status=$?
  echo "==> Stopping dev servers..."
  for pid in "${PIDS[@]:-}"; do
    if [ -n "${pid:-}" ]; then
      kill -- "-$pid" 2>/dev/null || true
    fi
  done
  echo "==> Logs kept at: $LOG_DIR"
  exit "$status"
}
trap cleanup EXIT

# Starts "$2" (a shell command string) in its own process group (via setsid)
# with stdout+stderr to "$1", and records the leader pid in PIDS for cleanup.
start_bg() {
  local log_file="$1" cmd="$2"
  setsid bash -c "$cmd" >"$log_file" 2>&1 &
  PIDS+=("$!")
}

# Polls "$1" every second (each attempt capped at 2s) until it responds with
# ANY HTTP status (curl exit 0 — a 4xx/5xx/redirect still means the server is
# up) or "$3" seconds elapse.
wait_for() {
  local url="$1" name="$2" tries="${3:-90}"
  for ((i = 0; i < tries; i++)); do
    if curl -s -o /dev/null -m 2 "$url"; then
      echo "==> $name is up ($url)"
      return 0
    fi
    sleep 1
  done
  echo "error: $name did not come up at $url within ${tries}s — see its log ($LOG_DIR)." >&2
  return 1
}

echo "==> Starting API (dev)..."
start_bg "$API_LOG" "cd '$ROOT_DIR/services/api' && pnpm run dev"
wait_for "$API_INTERNAL_URL/v1/health" "API"

echo "==> Starting admin (dev)..."
start_bg "$ADMIN_LOG" "cd '$ROOT_DIR/apps/admin' && API_INTERNAL_URL='$API_INTERNAL_URL' pnpm run dev"
wait_for "http://localhost:3001/" "admin"

echo "==> Starting storefront (dev)..."
start_bg "$STOREFRONT_LOG" "cd '$ROOT_DIR/apps/storefront' && API_INTERNAL_URL='$API_INTERNAL_URL' pnpm run dev"
wait_for "http://localhost:3000/" "storefront"

echo "==> Waiting for Caddy to reach admin.ventia.localhost..."
wait_for "http://admin.ventia.localhost/" "caddy -> admin"

# Next.js dev mode compiles each route lazily, on its first request — and an
# on-demand compile racing the very first navigation to a not-yet-compiled
# route has been observed (in this environment) to hang the request
# indefinitely rather than just being slow, wedging the whole suite behind a
# single dead `await`. Requesting every route the spec visits once here,
# sequentially and before Playwright ever starts, forces each one to finish
# compiling up front so the real run never races a first compile.
echo "==> Warming up admin/storefront routes (first Next.js dev compile per route)..."
for route in / /login /registro /verificar /onboarding /productos /productos/nuevo /categorias /importar /equipo /configuracion /lanzamiento /aceptar-invitacion /pedidos; do
  curl -s -o /dev/null -m 20 "http://localhost:3001${route}" || true
done
# /pedidos/[id] (dynamic) isn't warmed individually here — a fixed route list
# can't name a real order id up front, and p2-dod.spec.ts's own retryUntil
# already tolerates a slow first compile on that route the same way it does
# for every other freshly-loaded route it visits.
#
# Storefront: p2-dod.spec.ts (P2 DoD) additionally exercises /carrito,
# /checkout, /checkout/confirmacion/[orderNumber], and /rastrear beyond the
# home page p1-dod.spec.ts already warmed up here — /productos/[slug] and
# /checkout/confirmacion/[orderNumber] are dynamic routes with no real
# slug/order number known up front, but hitting any (even 404ing) value still
# forces that route's one-time compile, which is all warmup needs.
for route in / /carrito /checkout /checkout/confirmacion/0 /productos/warmup-only /rastrear; do
  curl -s -o /dev/null -m 20 "http://localhost:3000${route}" || true
done
echo "==> Warmup done."

# The e2e spec's only way to see the console-mailer's verification/invite
# links (there is no dev-only API backdoor — see the spec's own doc comment)
# is to read this file after triggering the send.
export E2E_API_LOG="$API_LOG"

echo "==> Running Playwright (apps/admin/e2e)..."
set +e
pnpm --filter @ventia/admin exec playwright test
STATUS=$?
set -e

echo "==> Playwright exit code: $STATUS"
exit "$STATUS"
