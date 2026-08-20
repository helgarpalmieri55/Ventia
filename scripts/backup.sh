#!/usr/bin/env bash
# P6 Definition-of-Done: nightly logical backup of the platform Postgres
# (SPEC.md §10 "Reliability": nightly `pg_dump` to R2, 30-day retention).
#
# Produces FOUR files per run, all sharing one timestamped basename:
#
#   <base>.dump        pg_dump custom format (-Fc) — the database itself.
#   <base>.globals.sql pg_dumpall --globals-only — CLUSTER-WIDE roles.
#   <base>.manifest.json
#                      What was true at dump time: pg version, row counts per
#                      tenant-owned table, RLS policy count, migration count.
#   <base>.sha256      Checksums of the three files above.
#
# The globals file is NOT redundant. `pg_dump` dumps a single database and
# deliberately omits roles — but every RLS policy in this schema is written
# against the `ventia_app` role (packages/db/prisma/migrations/
# 20260723182728_rls), and `packages/db/src/tenant-client.ts` reaches it via
# SET LOCAL ROLE on every tenant-scoped query. Restoring the .dump alone into
# a cluster that has never seen `ventia_app` fails on the very first GRANT,
# and a hand-patched "just skip the grants" restore would come up with tenant
# isolation silently switched off. Backing the roles up alongside the data is
# what makes the restore drill (scripts/restore-drill.sh) able to prove
# isolation survived, rather than assume it.
#
# The manifest exists for the same reason: scripts/restore-drill.sh compares
# the restored database against these numbers. Row counts are taken BEFORE
# and AFTER the dump; if they differ, the source was being written to while
# pg_dump ran and the drill downgrades its count comparison to advisory
# (pg_dump's snapshot is consistent, but it is a snapshot of an instant this
# script cannot observe from outside).
#
# Usage:
#   bash scripts/backup.sh
#   BACKUP_DIR=/mnt/backups bash scripts/backup.sh
#
# Env overrides:
#   DATABASE_URL            source database (default: local dev stack)
#   BACKUP_DIR              output directory (default:
#                           ${TMPDIR:-/tmp}/ventia-backups — deliberately
#                           OUTSIDE the repo, which has no .gitignore entry
#                           for a backup directory and must never accrue
#                           multi-megabyte dumps as untracked files. A real
#                           deployment points this at mounted storage and
#                           syncs it to R2 (SPEC.md §10).)
#   BACKUP_RETENTION_DAYS   prune older runs (default: 30, per SPEC.md §10;
#                           set to 0 to disable pruning entirely)
set -euo pipefail

: "${DATABASE_URL:=postgresql://ventia:ventia@localhost:5432/ventia}"
: "${BACKUP_DIR:=${TMPDIR:-/tmp}/ventia-backups}"
: "${BACKUP_RETENTION_DAYS:=30}"

for bin in pg_dump pg_dumpall psql pg_restore; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "error: $bin not found on PATH. Install the postgresql-client package (v16+)." >&2
    exit 1
  }
done

# Every tenant-owned table (the ones carrying a tenantId + an RLS policy),
# plus the platform tables a restore must not lose. Kept as an explicit list
# rather than "every table in public" on purpose: the manifest is a
# CONTRACT the drill asserts against, so a table added to the schema without
# being added here should show up as an unchecked table in the drill's
# table-set comparison, not silently vanish from both sides at once.
TENANT_TABLES=(
  TenantDomain TenantLimits Category Product ProductCategory ProductVariant
  ProductImage InventoryMovement Cart CartItem Customer Order OrderItem
  OrderEvent Payment Conversation Message AgentUsage TenantContent
  NotificationLog Subscription Shipment Invoice StaffInvite
)
PLATFORM_TABLES=(Tenant User Session Account Verification Membership WebhookEvent AuditLog)

# `psql -tA` = tuples only, unaligned — one bare value per line, safe to read
# into a shell variable without trimming.
psql_val() { psql "$DATABASE_URL" -tA -c "$1"; }

# Emits `"Table": <count>,` lines for the manifest's JSON. One round trip for
# all tables (a UNION ALL) rather than one per table, so the "before" and
# "after" snapshots are each internally consistent — counted in a single
# statement, hence a single MVCC snapshot.
count_tables_json() {
  local sql="" t
  for t in "${TENANT_TABLES[@]}" "${PLATFORM_TABLES[@]}"; do
    [ -n "$sql" ] && sql+=" UNION ALL "
    sql+="SELECT '$t' AS t, count(*) AS n FROM \"$t\""
  done
  psql "$DATABASE_URL" -tA -F$'\t' -c "SELECT t, n FROM ($sql) s ORDER BY t"
}

mkdir -p "$BACKUP_DIR"

DB_NAME="$(psql_val 'SELECT current_database()')"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$BACKUP_DIR/ventia-${DB_NAME}-${STAMP}"

echo "==> Source: ${DATABASE_URL%%\?*} (database '$DB_NAME')"
echo "==> Target: $BASE.*"

SERVER_VERSION="$(psql_val 'SELECT version()')"
echo "==> Server: $SERVER_VERSION"

echo "==> Counting rows (pre-dump)..."
COUNTS_BEFORE="$(count_tables_json)"

echo "==> pg_dump (custom format)..."
# -Fc: the only format pg_restore can restore selectively and in parallel,
# and the only one that survives a partial-restore drill without hand-editing
# SQL. --no-password so a missing credential fails loudly instead of hanging
# on an interactive prompt in a cron job.
pg_dump "$DATABASE_URL" --format=custom --no-password --file="$BASE.dump"

echo "==> pg_dumpall --globals-only (roles + cluster grants)..."
# --no-role-passwords: avoids needing to read pg_authid (superuser-only on
# managed Postgres), and a backup file should not carry role password hashes
# anyway. The restore drill re-creates roles from this, not their passwords —
# `ventia_app` is NOLOGIN and has none.
pg_dumpall --dbname="$DATABASE_URL" --globals-only --no-role-passwords --no-password --file="$BASE.globals.sql"

echo "==> Counting rows (post-dump)..."
COUNTS_AFTER="$(count_tables_json)"

QUIESCENT=true
if [ "$COUNTS_BEFORE" != "$COUNTS_AFTER" ]; then
  QUIESCENT=false
  echo "warning: row counts changed while pg_dump ran — the source was live." >&2
  echo "         The drill will treat its row-count comparison as advisory." >&2
fi

POLICY_COUNT="$(psql_val "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")"
RLS_TABLE_COUNT="$(psql_val "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity")"
MIGRATION_COUNT="$(psql_val 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')"

# The exact policy definitions, hashed. The drill recomputes this hash on the
# restored database and compares: a pg_dump that silently dropped or altered
# a USING/WITH CHECK clause changes this digest, which is the single check
# that would have caught the catastrophic-and-invisible failure mode (data
# restores fine, isolation quietly gone).
POLICY_DIGEST="$(psql "$DATABASE_URL" -tA -c "
  SELECT md5(string_agg(sig, E'\n' ORDER BY sig)) FROM (
    SELECT tablename || '|' || policyname || '|' || permissive || '|' || cmd
           || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '') AS sig
    FROM pg_policies WHERE schemaname = 'public'
  ) p")"

echo "==> Verifying the dump is readable (pg_restore --list)..."
# A dump nobody has opened is not a backup either. pg_restore --list parses
# the whole custom-format archive's table of contents, so a truncated or
# corrupt file fails HERE, at backup time, rather than during an incident.
TOC_ENTRIES="$(pg_restore --list "$BASE.dump" | grep -cv '^;' || true)"
if [ "$TOC_ENTRIES" -lt 1 ]; then
  echo "error: dump has no restorable entries — refusing to keep it." >&2
  rm -f "$BASE.dump" "$BASE.globals.sql"
  exit 1
fi
echo "==> Archive TOC entries: $TOC_ENTRIES"

# Same idea for the globals file: its ONLY load-bearing content is the
# ventia_app role, so a globals dump missing it is worse than useless —
# it would restore "successfully" into a cluster with no RLS-subject role.
if ! grep -q 'CREATE ROLE ventia_app' "$BASE.globals.sql"; then
  echo "error: globals dump does not create the ventia_app role — refusing to keep it." >&2
  rm -f "$BASE.dump" "$BASE.globals.sql"
  exit 1
fi

DUMP_BYTES="$(stat -c %s "$BASE.dump")"

{
  echo '{'
  echo "  \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"database\": \"$DB_NAME\","
  echo "  \"serverVersion\": \"$SERVER_VERSION\","
  echo "  \"dumpFile\": \"$(basename "$BASE.dump")\","
  echo "  \"globalsFile\": \"$(basename "$BASE.globals.sql")\","
  echo "  \"dumpBytes\": $DUMP_BYTES,"
  echo "  \"tocEntries\": $TOC_ENTRIES,"
  echo "  \"sourceQuiescent\": $QUIESCENT,"
  echo "  \"policyCount\": $POLICY_COUNT,"
  echo "  \"rlsTableCount\": $RLS_TABLE_COUNT,"
  echo "  \"policyDigest\": \"$POLICY_DIGEST\","
  echo "  \"migrationCount\": $MIGRATION_COUNT,"
  echo '  "rowCounts": {'
  # `sed '$ s/,$//'` strips the trailing comma from the last line only —
  # JSON has no trailing-comma tolerance.
  echo "$COUNTS_AFTER" | awk -F'\t' '{printf "    \"%s\": %s,\n", $1, $2}' | sed '$ s/,$//'
  echo '  }'
  echo '}'
} > "$BASE.manifest.json"

( cd "$BACKUP_DIR" && sha256sum "$(basename "$BASE.dump")" "$(basename "$BASE.globals.sql")" "$(basename "$BASE.manifest.json")" > "$(basename "$BASE.sha256")" )

echo "==> Wrote:"
ls -l "$BASE.dump" "$BASE.globals.sql" "$BASE.manifest.json" "$BASE.sha256"

if [ "$BACKUP_RETENTION_DAYS" -gt 0 ]; then
  echo "==> Pruning backups older than $BACKUP_RETENTION_DAYS days..."
  # -mtime +N is "modified more than N*24h ago", which is what a day-based
  # retention window means here. Scoped to this script's own filename prefix
  # so pointing BACKUP_DIR at a shared directory can never delete a
  # bystander's files.
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ventia-*' -mtime "+$BACKUP_RETENTION_DAYS" -print -delete
fi

echo "==> Backup OK: $BASE.dump"
# The last line is the dump path with no decoration, so a caller (notably
# scripts/restore-drill.sh) can `tail -n1` it.
echo "$BASE.dump"
