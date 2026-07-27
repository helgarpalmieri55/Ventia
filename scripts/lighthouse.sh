#!/usr/bin/env bash
# Lighthouse budget check for the storefront (P2c wrap-up, Task 6).
#
# This repo has no existing Lighthouse tooling — this script is the minimal
# version needed to produce real numbers against a real running dev server,
# using the `lighthouse` CLI (via `npx`, no new permanent dependency) against
# Chromium already preinstalled in this environment for Playwright
# (`PLAYWRIGHT_BROWSERS_PATH`, default `/opt/pw-browsers`) rather than letting
# Lighthouse try to download its own.
#
# Boots the API + storefront dev servers against the ALREADY-RUNNING dev
# stack (docker/compose.yaml), same "check, don't start, the Docker stack"
# posture as scripts/e2e.sh, then runs Lighthouse against the seeded
# `demo-moda` tenant's home page, one PDP, and `/carrito` (seeded by
# `pnpm --filter @ventia/db seed` — see the Quickstart in README.md; run that
# first if `demo-moda.ventia.localhost` 404s below). Reusing the existing
# seed data rather than provisioning a fresh tenant keeps this script
# standalone (no dependency on any e2e spec's own fixtures) and matches what
# the README's own "Verifying the stack" section already exercises.
#
# Usage: bash scripts/lighthouse.sh
# Env overrides: DATABASE_URL, API_INTERNAL_URL, HOST (the tenant subdomain
#   to test — default demo-moda.ventia.localhost), OUTPUT_DIR.
#
# CAVEAT: this runs against the Next.js DEV server (unminified, no
# production optimizations, React dev-mode overhead) — Performance scores
# here are a floor, not representative of a production build. Use this to
# catch REGRESSIONS and confirm the tooling works, not as a production SLA;
# re-run against `next build && next start` for a representative number.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${DATABASE_URL:=postgresql://ventia:ventia@localhost:5432/ventia}"
: "${REDIS_URL:=redis://localhost:6379}"
: "${AUTH_SECRET:=dev-secret-change-me}"
: "${API_INTERNAL_URL:=http://localhost:4000}"
: "${HOST:=demo-moda.ventia.localhost}"
: "${S3_ENDPOINT:=http://localhost:9000}"
: "${S3_ACCESS_KEY:=ventia}"
: "${S3_SECRET_KEY:=ventia-secret}"
: "${S3_BUCKET:=ventia}"
: "${S3_PUBLIC_URL:=http://localhost:9000/ventia}"
export DATABASE_URL REDIS_URL AUTH_SECRET API_INTERNAL_URL
export S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET S3_PUBLIC_URL

OUTPUT_DIR="${OUTPUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/ventia-lighthouse.XXXXXX")}"
mkdir -p "$OUTPUT_DIR"
echo "==> Reports: $OUTPUT_DIR"

echo "==> Checking the dev stack (postgres/redis/caddy/minio) is up..."
for name in docker-postgres-1 docker-redis-1 docker-caddy-1 docker-minio-1; do
  if ! docker ps --filter "name=^${name}\$" --filter status=running -q | grep -q .; then
    echo "error: $name is not running. Start the dev stack first:" >&2
    echo "  docker compose -f docker/compose.yaml up -d" >&2
    exit 1
  fi
done

echo "==> Freeing ports 3000/4000 in case a previous run left something behind..."
fuser -k 3000/tcp 4000/tcp >/dev/null 2>&1 || true
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
  echo "==> Reports kept at: $OUTPUT_DIR"
  exit "$status"
}
trap cleanup EXIT

start_bg() {
  local log_file="$1" cmd="$2"
  setsid bash -c "$cmd" >"$log_file" 2>&1 &
  PIDS+=("$!")
}

wait_for() {
  local url="$1" name="$2" tries="${3:-90}"
  for ((i = 0; i < tries; i++)); do
    if curl -s -o /dev/null -m 2 "$url"; then
      echo "==> $name is up ($url)"
      return 0
    fi
    sleep 1
  done
  echo "error: $name did not come up at $url within ${tries}s — see its log ($OUTPUT_DIR)." >&2
  return 1
}

echo "==> Starting API (dev)..."
start_bg "$OUTPUT_DIR/api.log" "cd '$ROOT_DIR/services/api' && pnpm run dev"
wait_for "$API_INTERNAL_URL/v1/health" "API"

echo "==> Starting storefront (dev)..."
start_bg "$OUTPUT_DIR/storefront.log" "cd '$ROOT_DIR/apps/storefront' && API_INTERNAL_URL='$API_INTERNAL_URL' pnpm run dev"
wait_for "http://localhost:3000/" "storefront"

echo "==> Waiting for Caddy to reach ${HOST}..."
if ! wait_for "http://${HOST}/" "caddy -> ${HOST}" 60; then
  echo "error: ${HOST} did not resolve — did you run 'pnpm --filter @ventia/db seed'?" >&2
  exit 1
fi

# Same preinstalled-Chromium resolution as apps/admin/playwright.config.ts's
# `preinstalledChromiumPath` (duplicated here rather than imported: this
# script is plain bash, that helper is TypeScript inside a different
# package) — Lighthouse needs its own Chrome/Chromium launch; pointing
# CHROME_PATH at the exact preinstalled binary means it never tries to
# download one of its own.
BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
CHROME_BIN="$(find "$BROWSERS_PATH" -maxdepth 1 -name 'chromium-*' -print -quit 2>/dev/null)/chrome-linux/chrome"
if [ -x "$CHROME_BIN" ]; then
  export CHROME_PATH="$CHROME_BIN"
  echo "==> Using preinstalled Chromium: $CHROME_PATH"
else
  echo "==> No preinstalled Chromium found under $BROWSERS_PATH — letting Lighthouse resolve its own." >&2
fi

run_lighthouse() {
  local path="$1" name="$2"
  local url="http://${HOST}${path}"
  local out="$OUTPUT_DIR/${name}"
  echo "==> Lighthouse: $url"
  npx --yes lighthouse "$url" \
    --output=json --output=html --output-path="$out" \
    --chrome-flags="--headless --no-sandbox" \
    --only-categories=performance,accessibility,best-practices,seo \
    --quiet
  node -e "
    const r = require('$out.report.json');
    const cats = r.categories;
    const pct = (c) => Math.round(c.score * 100);
    console.log('    ${name}: performance=' + pct(cats.performance) +
      ' accessibility=' + pct(cats.accessibility) +
      ' best-practices=' + pct(cats['best-practices']) +
      ' seo=' + pct(cats.seo));
  "
}

echo "==> Running Lighthouse against ${HOST} (dev server — see this script's header caveat)..."
run_lighthouse "/" "home"
run_lighthouse "/productos/camiseta-basica" "pdp"
run_lighthouse "/carrito" "carrito"

echo "==> Done. Full reports (HTML + JSON) in $OUTPUT_DIR"
