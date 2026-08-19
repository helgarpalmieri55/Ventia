#!/usr/bin/env bash
# P6 Definition-of-Done: "restore drill documented and executed".
#
# A backup nobody has restored is not a backup. This script takes a backup
# produced by scripts/backup.sh (or produces a fresh one), restores it into a
# throwaway scratch database, and then PROVES the restore is usable — not
# just that pg_restore exited 0.
#
# What it proves, and why each check exists:
#
#   1. Table set          — the restored schema has exactly the source's
#                           tables. Catches a partial/filtered restore.
#   2. Row counts         — every tenant-owned and platform table matches the
#                           manifest's counts. Catches silent data loss.
#   3. RLS enabled        — the same tables carry `relrowsecurity`. A table
#                           restored with RLS off looks perfectly healthy and
#                           serves every tenant's rows to every tenant.
#   4. Policy definitions — md5 of every policy's (table, name, permissive,
#                           cmd, USING, WITH CHECK) matches the digest taken
#                           at dump time. This is the check that catches the
#                           catastrophic-and-invisible failure: data restores
#                           fine, `tenant_isolation` quietly did not.
#   5. Grants             — `ventia_app` still holds CRUD on the tenant
#                           tables, still holds NOTHING on the platform/auth
#                           tables the 20260723205801 migration revoked, and
#                           still lacks BYPASSRLS. Grants live in the dump;
#                           the role itself lives only in the globals file,
#                           which is why backup.sh writes both.
#   6. RLS actually works — the real test. Connect AS `ventia_app` against the
#                           RESTORED data and check that tenant A's GUC sees
#                           exactly tenant A's rows, tenant B's sees B's, no
#                           GUC sees nothing, and a cross-tenant INSERT is
#                           refused. Checks 3-5 assert the machinery is
#                           present; this one asserts it bites.
#   7. Migration state    — `_prisma_migrations` count matches, so the
#                           restored database is at the same schema version.
#
# The scratch database is dropped on exit (KEEP_DRILL_DB=1 to keep it for
# post-mortem). The SOURCE database is never written to.
#
# Usage:
#   bash scripts/restore-drill.sh                 # fresh backup, then restore it
#   bash scripts/restore-drill.sh --backup PATH   # drill an EXISTING .dump
#   bash scripts/restore-drill.sh --latest        # drill the newest dump in BACKUP_DIR
#
# Env overrides: DATABASE_URL, BACKUP_DIR, KEEP_DRILL_DB.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${DATABASE_URL:=postgresql://ventia:ventia@localhost:5432/ventia}"
: "${BACKUP_DIR:=${TMPDIR:-/tmp}/ventia-backups}"
: "${KEEP_DRILL_DB:=0}"

BACKUP_FILE=""
MODE="fresh"
while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP_FILE="${2:?--backup needs a path}"; MODE="given"; shift 2 ;;
    --latest) MODE="latest"; shift ;;
    -h | --help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

for bin in psql pg_restore jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: $bin not found on PATH." >&2; exit 1; }
done

# Split DATABASE_URL into "everything before the database name" and the query
# string, so the scratch database's URL can be built by swapping only the
# path segment — naive string surgery on the whole URL would eat an
# `?sslmode=require` or mangle a password containing a slash.
URL_NO_QUERY="${DATABASE_URL%%\?*}"
URL_QUERY=""
[ "$URL_NO_QUERY" != "$DATABASE_URL" ] && URL_QUERY="?${DATABASE_URL#*\?}"
URL_PREFIX="${URL_NO_QUERY%/*}"
SOURCE_DB="${URL_NO_QUERY##*/}"

DRILL_DB="ventia_drill_$(date -u +%Y%m%d%H%M%S)_$$"
# `postgres` is the maintenance database every cluster has: CREATE/DROP
# DATABASE cannot be run from inside the database being created or dropped.
ADMIN_URL="$URL_PREFIX/postgres$URL_QUERY"
DRILL_URL="$URL_PREFIX/$DRILL_DB$URL_QUERY"

PASS=0
FAIL=0
check() {
  local ok="$1" desc="$2" detail="${3:-}"
  if [ "$ok" = "yes" ]; then
    PASS=$((PASS + 1))
    printf '  \033[32mPASS\033[0m  %s\n' "$desc"
    [ -n "$detail" ] && printf '        %s\n' "$detail"
  else
    FAIL=$((FAIL + 1))
    printf '  \033[31mFAIL\033[0m  %s\n' "$desc"
    [ -n "$detail" ] && printf '        %s\n' "$detail"
  fi
  return 0
}

src() { psql "$DATABASE_URL" -tA -c "$1"; }
dst() { psql "$DRILL_URL" -tA -c "$1"; }

DRILL_CREATED=0
cleanup() {
  local status=$?
  if [ "$DRILL_CREATED" = "1" ]; then
    if [ "$KEEP_DRILL_DB" = "1" ]; then
      echo "==> KEEP_DRILL_DB=1 — scratch database kept: $DRILL_DB"
    else
      echo "==> Dropping scratch database $DRILL_DB..."
      # WITH (FORCE) terminates any leftover backend still connected (e.g. a
      # psql left open by a failed check), so a red drill still cleans up
      # instead of leaking a database until someone notices.
      psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT

echo "=============================================================="
echo " Ventia restore drill — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "=============================================================="
echo "==> Source database: $SOURCE_DB"
echo "==> Scratch database: $DRILL_DB"
echo

case "$MODE" in
  fresh)
    echo "==> Taking a fresh backup first (scripts/backup.sh)..."
    # backup.sh's last stdout line is the bare dump path — see its tail.
    BACKUP_FILE="$(BACKUP_DIR="$BACKUP_DIR" bash "$ROOT_DIR/scripts/backup.sh" | tail -n1)"
    echo
    ;;
  latest)
    # find + sort rather than `ls -1t`: newest-first by mtime, and immune to
    # whatever characters a caller-supplied BACKUP_DIR path contains.
    BACKUP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ventia-*.dump' -printf '%T@\t%p\n' 2>/dev/null | sort -rn | head -n1 | cut -f2-)"
    [ -n "$BACKUP_FILE" ] || { echo "error: no ventia-*.dump found in $BACKUP_DIR" >&2; exit 1; }
    ;;
esac

[ -f "$BACKUP_FILE" ] || { echo "error: backup file not found: $BACKUP_FILE" >&2; exit 1; }
BASE="${BACKUP_FILE%.dump}"
MANIFEST="$BASE.manifest.json"
GLOBALS="$BASE.globals.sql"
CHECKSUMS="$BASE.sha256"
[ -f "$MANIFEST" ] || { echo "error: manifest not found: $MANIFEST" >&2; exit 1; }

echo "==> Restoring from: $BACKUP_FILE"
echo "==> Manifest:       $MANIFEST"
echo

echo "--- Step 0: backup integrity -------------------------------"
if [ -f "$CHECKSUMS" ] && ( cd "$(dirname "$CHECKSUMS")" && sha256sum --quiet --check "$(basename "$CHECKSUMS")" ); then
  check yes "Checksums match (sha256sum --check)"
else
  check no "Checksums match (sha256sum --check)" "$CHECKSUMS"
fi

# The roles the dump's GRANT statements refer to are cluster-wide and are NOT
# in the .dump — restoring into a cluster that never had ventia_app is the
# realistic disaster-recovery case (new machine, empty cluster), so apply the
# globals file when the role is missing. On the dev cluster it already
# exists and this is a no-op, which is stated rather than hidden.
if [ "$(psql "$ADMIN_URL" -tA -c "SELECT count(*) FROM pg_roles WHERE rolname = 'ventia_app'")" = "0" ]; then
  echo "==> Role ventia_app absent — applying $GLOBALS"
  psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -f "$GLOBALS"
  check yes "Roles restored from the globals dump"
else
  check yes "Role ventia_app present in the cluster" "already existed; globals dump not re-applied"
fi
echo

echo "--- Step 1: restore ----------------------------------------"
echo "==> CREATE DATABASE $DRILL_DB"
psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DRILL_DB\""
DRILL_CREATED=1

echo "==> pg_restore..."
RESTORE_LOG="$(mktemp "${TMPDIR:-/tmp}/ventia-drill-restore.XXXXXX.log")"
# --exit-on-error, deliberately: pg_restore's DEFAULT is to log errors and
# carry on, exiting 0 with a "there were N errors" line that is trivially
# missed in a cron log. A restore drill that tolerates errors proves nothing.
if pg_restore --dbname="$DRILL_URL" --no-password --exit-on-error "$BACKUP_FILE" >"$RESTORE_LOG" 2>&1; then
  check yes "pg_restore --exit-on-error completed"
else
  check no "pg_restore --exit-on-error completed" "see $RESTORE_LOG"
  tail -n 20 "$RESTORE_LOG" >&2
fi
rm -f "$RESTORE_LOG"
echo

echo "--- Step 2: schema and data --------------------------------"
TABLES_SQL="SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'"
SRC_TABLES="$(src "$TABLES_SQL")"
DST_TABLES="$(dst "$TABLES_SQL")"
if [ "$SRC_TABLES" = "$DST_TABLES" ]; then
  check yes "Table set identical to source ($(echo "$DST_TABLES" | tr ',' '\n' | wc -l) tables)"
else
  check no "Table set identical to source" "only in source: $(comm -23 <(echo "$SRC_TABLES" | tr ',' '\n' | sort) <(echo "$DST_TABLES" | tr ',' '\n' | sort) | tr '\n' ' ')"
fi

QUIESCENT="$(jq -r '.sourceQuiescent' "$MANIFEST")"
MISMATCHES=""
TOTAL_ROWS=0
while IFS=$'\t' read -r table expected; do
  actual="$(dst "SELECT count(*) FROM \"$table\"")"
  TOTAL_ROWS=$((TOTAL_ROWS + actual))
  [ "$actual" = "$expected" ] || MISMATCHES+="$table(expected $expected, got $actual) "
done < <(jq -r '.rowCounts | to_entries[] | "\(.key)\t\(.value)"' "$MANIFEST")

if [ -z "$MISMATCHES" ]; then
  check yes "Row counts match the manifest on all $(jq -r '.rowCounts | length' "$MANIFEST") tables" "$TOTAL_ROWS rows restored"
elif [ "$QUIESCENT" = "false" ]; then
  # Honest degradation rather than a false red: backup.sh already recorded
  # that the source was being written to across the dump, so the manifest's
  # counts and the dump's snapshot are known to be from different instants.
  check yes "Row counts (ADVISORY — source was not quiescent during the dump)" "$MISMATCHES"
else
  check no "Row counts match the manifest" "$MISMATCHES"
fi
echo

echo "--- Step 3: RLS survived the round trip --------------------"
RLS_SQL="SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity"
SRC_RLS="$(src "$RLS_SQL")"
DST_RLS="$(dst "$RLS_SQL")"
DST_RLS_COUNT="$(dst "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity")"
EXPECTED_RLS="$(jq -r '.rlsTableCount' "$MANIFEST")"
if [ "$SRC_RLS" = "$DST_RLS" ] && [ "$DST_RLS_COUNT" = "$EXPECTED_RLS" ]; then
  check yes "RLS enabled on the same $DST_RLS_COUNT tables as the source"
else
  check no "RLS enabled on the same tables as the source" "expected $EXPECTED_RLS tables, restored has $DST_RLS_COUNT"
fi

POLICY_DIGEST_SQL="SELECT md5(string_agg(sig, E'\n' ORDER BY sig)) FROM (
    SELECT tablename || '|' || policyname || '|' || permissive || '|' || cmd
           || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '') AS sig
    FROM pg_policies WHERE schemaname = 'public'
  ) p"
DST_DIGEST="$(dst "$POLICY_DIGEST_SQL")"
EXPECTED_DIGEST="$(jq -r '.policyDigest' "$MANIFEST")"
DST_POLICIES="$(dst "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")"
EXPECTED_POLICIES="$(jq -r '.policyCount' "$MANIFEST")"
if [ "$DST_DIGEST" = "$EXPECTED_DIGEST" ] && [ "$DST_POLICIES" = "$EXPECTED_POLICIES" ]; then
  check yes "All $DST_POLICIES policy definitions byte-identical" "md5 $DST_DIGEST"
else
  check no "All policy definitions byte-identical" "expected $EXPECTED_POLICIES policies / md5 $EXPECTED_DIGEST, got $DST_POLICIES / md5 $DST_DIGEST"
fi
echo

echo "--- Step 4: grants survived the round trip -----------------"
# The round-trip property, stated as a comparison against the SOURCE rather
# than against a hardcoded expectation: the complete (table, privilege) matrix
# for `ventia_app` must come back identical. Written this way on purpose after
# an earlier version of this check hardcoded "every RLS table has full CRUD"
# and reported a FAIL for tables the source itself only grants SELECT on
# (AgentUsage, Payment, WebhookEvent, WebhookEventReview) — a drill that
# reports the schema's design decisions as restore failures is a drill people
# learn to ignore. Comparing to the source also means this check needs no
# maintenance as tables are added.
GRANT_MATRIX_SQL="
  SELECT coalesce(string_agg(t.relname || ':' || p.priv, ',' ORDER BY t.relname, p.priv), '') FROM
    (SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r') t
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(priv)
  WHERE has_table_privilege('ventia_app', t.oid, p.priv)"
SRC_GRANTS="$(src "$GRANT_MATRIX_SQL")"
DST_GRANTS="$(dst "$GRANT_MATRIX_SQL")"
if [ "$SRC_GRANTS" = "$DST_GRANTS" ]; then
  check yes "ventia_app's entire grant matrix is identical to the source" "$(echo "$SRC_GRANTS" | tr ',' '\n' | wc -l) (table, privilege) pairs"
else
  check no "ventia_app's entire grant matrix is identical to the source" \
    "lost: $(comm -23 <(echo "$SRC_GRANTS" | tr ',' '\n' | sort) <(echo "$DST_GRANTS" | tr ',' '\n' | sort) | tr '\n' ' ')| gained: $(comm -13 <(echo "$SRC_GRANTS" | tr ',' '\n' | sort) <(echo "$DST_GRANTS" | tr ',' '\n' | sort) | tr '\n' ' ')"
fi

# A standing security invariant on top of the round-trip check, because "the
# restore matches the source" is no comfort if the source is already wrong.
# These are the auth/platform tables the 20260723205801 migration revoked:
# they carry no tenantId and therefore no RLS policy, so ANY grant here hands
# every tenant-scoped request the whole table.
#
# `WebhookEvent` is deliberately NOT in this list even though that migration
# revoked it: 20260815120000_webhook_event_tenant_read later granted SELECT
# back on purpose (tenant-scoped webhook review). It is covered by the
# grant-matrix comparison above instead.
FORBIDDEN_TABLES="(VALUES ('User'),('Session'),('Account'),('Verification'),('Membership'),('AuditLog'),('_prisma_migrations'))"
FORBIDDEN_SQL="
  SELECT coalesce(string_agg(t.tbl || ':' || p.priv, ' '), '') FROM
    $FORBIDDEN_TABLES t(tbl)
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(priv)
  WHERE has_table_privilege('ventia_app', format('%I', t.tbl)::regclass, p.priv)"
LEAKED_DST="$(dst "$FORBIDDEN_SQL")"
LEAKED_SRC="$(src "$FORBIDDEN_SQL")"
if [ -z "$LEAKED_DST" ]; then
  check yes "ventia_app has NO access to the 7 auth/platform tables (restored)"
elif [ "$LEAKED_DST" = "$LEAKED_SRC" ]; then
  # Names the guilty side explicitly. A pre-existing hole in the source is a
  # security finding to fix in a migration, not a restore defect.
  check no "ventia_app has NO access to the auth/platform tables" "PRE-EXISTING IN THE SOURCE, not introduced by the restore: $LEAKED_DST"
else
  check no "ventia_app has NO access to the auth/platform tables" "INTRODUCED BY THE RESTORE: $LEAKED_DST (source has: ${LEAKED_SRC:-none})"
fi

BYPASS="$(psql "$ADMIN_URL" -tA -c "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'ventia_app'")"
if [ "$BYPASS" = "f" ]; then
  check yes "ventia_app does not hold BYPASSRLS"
else
  check no "ventia_app does not hold BYPASSRLS" "rolbypassrls = $BYPASS — every policy below is decorative"
fi

# Not a pass/fail: an RLS-protected tenant table that ventia_app cannot read
# at all is invisible to every tenant-scoped query. Reported so the drill
# surfaces it rather than a merchant discovering it as an empty screen.
UNREACHABLE="$(dst "
  SELECT coalesce(string_agg(c.relname, ' ' ORDER BY c.relname), '') FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
    AND NOT has_table_privilege('ventia_app', c.oid, 'SELECT')")"
[ -n "$UNREACHABLE" ] && echo "  NOTE  RLS tables ventia_app cannot even SELECT: $UNREACHABLE"
echo

echo "--- Step 5: tenant isolation actually enforced -------------"
# Checks 3 and 4 prove the policies are PRESENT. This one proves they BITE,
# by querying the restored data as ventia_app the way tenant-client.ts does
# (SET ROLE + app.tenant_id GUC) and comparing against ground truth read as
# the owner, for whom RLS does not apply.
read -r TENANT_A TENANT_A_PRODUCTS <<<"$(dst "
  SELECT t.id, count(p.id) FROM \"Tenant\" t LEFT JOIN \"Product\" p ON p.\"tenantId\" = t.id
  GROUP BY t.id ORDER BY count(p.id) DESC, t.id LIMIT 1" | tr '|' ' ')"
read -r TENANT_B TENANT_B_PRODUCTS <<<"$(dst "
  SELECT t.id, count(p.id) FROM \"Tenant\" t LEFT JOIN \"Product\" p ON p.\"tenantId\" = t.id
  GROUP BY t.id ORDER BY count(p.id) DESC, t.id OFFSET 1 LIMIT 1" | tr '|' ' ')"

if [ -z "${TENANT_A:-}" ] || [ -z "${TENANT_B:-}" ]; then
  check no "Two tenants available to test isolation with" "the restored database has fewer than 2 Tenant rows — isolation NOT exercised"
else
  echo "        tenant A = $TENANT_A ($TENANT_A_PRODUCTS products)"
  echo "        tenant B = $TENANT_B ($TENANT_B_PRODUCTS products)"

  # `psql -c` with several statements echoes a command tag per statement
  # (BEGIN / SET / SET / <count> / ROLLBACK), so the count is picked out by
  # shape rather than by position — `head -n1` would return "BEGIN".
  only_number() { grep -Ex '[0-9]+' | head -n1; }
  SEEN_A="$(dst "BEGIN; SET LOCAL ROLE ventia_app; SET LOCAL app.tenant_id = '$TENANT_A'; SELECT count(*) FROM \"Product\"; ROLLBACK;" | only_number)"
  SEEN_B="$(dst "BEGIN; SET LOCAL ROLE ventia_app; SET LOCAL app.tenant_id = '$TENANT_B'; SELECT count(*) FROM \"Product\"; ROLLBACK;" | only_number)"
  SEEN_NONE="$(dst "BEGIN; SET LOCAL ROLE ventia_app; SELECT count(*) FROM \"Product\"; ROLLBACK;" | only_number)"
  # Cross-tenant read: A's context must not see a single one of B's rows,
  # which is a strictly stronger statement than "A sees A's count".
  CROSS="$(dst "BEGIN; SET LOCAL ROLE ventia_app; SET LOCAL app.tenant_id = '$TENANT_A'; SELECT count(*) FROM \"Product\" WHERE \"tenantId\" = '$TENANT_B'; ROLLBACK;" | only_number)"

  if [ "$SEEN_A" = "$TENANT_A_PRODUCTS" ] && [ "$SEEN_B" = "$TENANT_B_PRODUCTS" ]; then
    check yes "Each tenant's GUC sees exactly its own products" "A: $SEEN_A/$TENANT_A_PRODUCTS, B: $SEEN_B/$TENANT_B_PRODUCTS"
  else
    check no "Each tenant's GUC sees exactly its own products" "A: $SEEN_A (expected $TENANT_A_PRODUCTS), B: $SEEN_B (expected $TENANT_B_PRODUCTS)"
  fi

  if [ "$CROSS" = "0" ]; then
    check yes "Tenant A's context sees 0 of tenant B's products"
  else
    check no "Tenant A's context sees 0 of tenant B's products" "saw $CROSS — CROSS-TENANT LEAK in the restored data"
  fi

  if [ "$SEEN_NONE" = "0" ]; then
    check yes "No app.tenant_id set => 0 rows (fails closed)"
  else
    check no "No app.tenant_id set => 0 rows (fails closed)" "saw $SEEN_NONE rows with no tenant context"
  fi

  # WITH CHECK, the write half of the policy. A restore that kept USING but
  # lost WITH CHECK reads correctly and lets any tenant write into any other.
  WRITE_BLOCKED="$(dst "
    BEGIN;
    SET LOCAL ROLE ventia_app;
    SET LOCAL app.tenant_id = '$TENANT_A';
    DO \$\$
    BEGIN
      INSERT INTO \"Product\" (id, \"tenantId\", name, slug, \"priceCents\", \"updatedAt\")
      VALUES (gen_random_uuid(), '$TENANT_B', 'drill-probe', 'drill-probe', 1, now());
      RAISE WARNING 'WRITE_ALLOWED';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'WRITE_BLOCKED';
    END \$\$;
    ROLLBACK;" 2>&1 | grep -o 'WRITE_[A-Z]*' | head -n1)"
  if [ "$WRITE_BLOCKED" = "WRITE_BLOCKED" ]; then
    check yes "Cross-tenant INSERT refused by the policy's WITH CHECK clause"
  else
    check no "Cross-tenant INSERT refused by the policy's WITH CHECK clause" "result: ${WRITE_BLOCKED:-<no marker — probe did not run>}"
  fi
fi
echo

echo "--- Step 6: schema version ---------------------------------"
DST_MIGRATIONS="$(dst 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')"
EXPECTED_MIGRATIONS="$(jq -r '.migrationCount' "$MANIFEST")"
if [ "$DST_MIGRATIONS" = "$EXPECTED_MIGRATIONS" ]; then
  check yes "$DST_MIGRATIONS applied migrations restored" "latest: $(dst 'SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS LAST LIMIT 1')"
else
  check no "Applied migrations restored" "expected $EXPECTED_MIGRATIONS, got $DST_MIGRATIONS"
fi
echo

echo "=============================================================="
echo " Restore drill: $PASS passed, $FAIL failed"
echo "=============================================================="
[ "$FAIL" -eq 0 ] || exit 1
