#!/usr/bin/env bash
# Turns docs/deploying.md §7 ("Backups, which are not optional and are not
# automatic") into actual scheduled jobs on this host.
#
# What it installs, in ONE marker-delimited block in a user's crontab:
#
#   nightly 03:15 UTC   backup.sh && backup-upload.mjs
#                       && backup-objects.mjs && backup-objects.mjs --upload
#   Sunday  04:00 UTC   restore-drill.sh --latest
#   Sunday  05:00 UTC   backup-objects.mjs --drill --latest
#
# THE `&&` IS THE POINT of the nightly line. A failed dump followed by an
# upload that runs anyway produces the worst possible artifact: a bucket whose
# newest object is yesterday's good backup, with today's failure invisible.
# Chained, the run stops at the first failure and the alert names the step.
#
# ALERTING IS ALSO THE POINT. Every line runs inside scripts/cron-run.sh, which
# sources the env file, holds a lock, logs, and routes a non-zero exit to
# scripts/notify.sh. This script REFUSES to install a schedule with no alert
# channel configured (--allow-no-alerts overrides, loudly) because a nightly
# backup whose failures reach nobody is the exact thing docs/operations.md
# warns about, and installing it would let everyone believe the problem is
# solved.
#
# Idempotent: the block is delimited by BEGIN/END markers and rewritten whole.
# Re-running replaces it; it never appends a second copy. Anything else already
# in the crontab is preserved byte for byte.
#
# Usage:
#   bash scripts/install-cron.sh --dry-run      # print the block + preflight, change nothing
#   bash scripts/install-cron.sh                # install for the current user
#   sudo bash scripts/install-cron.sh --user ventia
#   bash scripts/install-cron.sh --uninstall
#
# Options:
#   --user <name>        install into that user's crontab (needs root)
#   --env-file <path>    default /etc/ventia/cron.env
#   --backup-dir <path>  default /var/backups/ventia
#   --allow-no-alerts    install even with no alert channel configured
#   --force              install even if preflight checks failed
#   --dry-run            print everything, install nothing
#   --uninstall          remove the managed block
#
# What this does NOT do: it does not monitor that the jobs ran. A cron entry
# that was removed, a machine that was off at 03:15, or a crond that died all
# look identical to "no alert, so everything is fine". cron-run.sh writes
# /var/lib/ventia/<job>.last after every run; something outside this box should
# check that file's age. That check is not installed here because it has to
# live somewhere that survives this host dying, which is precisely the case it
# exists for.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET_USER="$(id -un)"
ENV_FILE="/etc/ventia/cron.env"
BACKUP_DIR="/var/backups/ventia"
DRY_RUN=0
UNINSTALL=0
FORCE=0
ALLOW_NO_ALERTS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user) TARGET_USER="${2:?--user needs a name}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:?--backup-dir needs a path}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --force) FORCE=1; shift ;;
    --allow-no-alerts) ALLOW_NO_ALERTS=1; shift ;;
    -h | --help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

BEGIN_MARK="# BEGIN ventia — managed by scripts/install-cron.sh, do not edit between the markers"
END_MARK="# END ventia"

PASS=0
FAIL=0
WARN=0
check() {
  local ok="$1" desc="$2" detail="${3:-}"
  case "$ok" in
    yes)  PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m  %s\n' "$desc" ;;
    warn) WARN=$((WARN + 1)); printf '  \033[33mWARN\033[0m  %s\n' "$desc" ;;
    *)    FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m  %s\n' "$desc" ;;
  esac
  [ -n "$detail" ] && printf '        %s\n' "$detail"
  return 0
}

crontab_read() {
  if [ "$TARGET_USER" = "$(id -un)" ]; then crontab -l 2>/dev/null || true
  else crontab -u "$TARGET_USER" -l 2>/dev/null || true; fi
}
crontab_write() {
  if [ "$TARGET_USER" = "$(id -un)" ]; then crontab -; else crontab -u "$TARGET_USER" -; fi
}

# ---------------------------------------------------------------------------
# Uninstall is deliberately the simplest path in the file: at 3am, "make the
# scheduled thing stop" must not depend on any of the preflight below.
# ---------------------------------------------------------------------------
if [ "$UNINSTALL" = "1" ]; then
  command -v crontab >/dev/null 2>&1 || { echo "error: no crontab binary; nothing to uninstall." >&2; exit 1; }
  CURRENT="$(crontab_read)"
  if ! printf '%s\n' "$CURRENT" | grep -qF "$BEGIN_MARK"; then
    echo "No ventia block in ${TARGET_USER}'s crontab — nothing to do."
    exit 0
  fi
  NEW="$(printf '%s\n' "$CURRENT" | sed "\|^${BEGIN_MARK}\$|,\|^${END_MARK}\$|d")"
  if [ "$DRY_RUN" = "1" ]; then
    echo "--- crontab after uninstall (DRY RUN, not written) ---"
    printf '%s\n' "$NEW"
    exit 0
  fi
  printf '%s\n' "$NEW" | crontab_write
  echo "Removed the ventia block from ${TARGET_USER}'s crontab."
  echo "NOTE: nothing is scheduled now. Backups are manual again."
  exit 0
fi

echo "=============================================================="
echo " Ventia scheduled jobs — install"
echo "=============================================================="
echo "  repo:      $ROOT_DIR"
echo "  user:      $TARGET_USER"
echo "  env file:  $ENV_FILE"
echo "  backups:   $BACKUP_DIR"
echo

# ---------------------------------------------------------------------------
# The env file. Created (0600) with placeholders if absent, NEVER overwritten:
# a re-run must not blank out working credentials.
# ---------------------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "==> $ENV_FILE does not exist; a template would be created (dry run: not created)."
  elif mkdir -p "$(dirname "$ENV_FILE")" 2>/dev/null && touch "$ENV_FILE" 2>/dev/null; then
    chmod 600 "$ENV_FILE"
    if [ "$(id -u)" = "0" ]; then chown "$TARGET_USER" "$ENV_FILE"; fi
    cat > "$ENV_FILE" <<ENV_EOF
# Sourced by scripts/cron-run.sh before every scheduled job. Shell syntax.
# 0600 and owned by $TARGET_USER: it holds database and object-store
# credentials, and the crontab deliberately holds none.

# --- Postgres, as reached FROM THE HOST -----------------------------------
# The compose stack should publish Postgres on 127.0.0.1 only (never
# 0.0.0.0 — ufw does not filter Docker-published ports).
DATABASE_URL=postgresql://ventia:CHANGE_ME@127.0.0.1:5432/ventia

# --- Local backup output ---------------------------------------------------
BACKUP_DIR=$BACKUP_DIR
BACKUP_RETENTION_DAYS=30

# --- Offsite (R2 or any S3). All four, or none: backup-upload.mjs refuses
# --- to run half-configured rather than silently skipping the upload.
BACKUP_S3_ENDPOINT=
BACKUP_S3_BUCKET=
BACKUP_S3_ACCESS_KEY=
BACKUP_S3_SECRET_KEY=

# --- Source object store (product images), as reached FROM THE HOST.
# --- Same values as the API's own S3_* — this is the bucket being backed up.
S3_ENDPOINT=http://127.0.0.1:9000
S3_BUCKET=ventia
S3_ACCESS_KEY=
S3_SECRET_KEY=

# --- Alerting. Set ONE of these. See scripts/notify.sh for the contract.
# VENTIA_ALERT_COMMAND='mail -s "\$1" ops@example.co'
# VENTIA_ALERT_WEBHOOK_URL=https://hooks.example.com/...
VENTIA_ALERT_COMMAND=
VENTIA_ALERT_WEBHOOK_URL=
ENV_EOF
    echo "==> Wrote a template to $ENV_FILE (0600). Fill it in before the first run."
  else
    echo "warning: cannot create $ENV_FILE (need root, or pass --env-file somewhere writable)." >&2
  fi
fi

echo "--- Preflight ------------------------------------------------"

if command -v crontab >/dev/null 2>&1; then
  check yes "crontab is available"
else
  check no "crontab is available" "apt-get install cron"
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet cron 2>/dev/null || systemctl is-active --quiet crond 2>/dev/null; then
    check yes "the cron daemon is running"
  else
    # Fatal, not cosmetic: a crontab installed against a dead daemon is the
    # purest form of the failure this whole file exists to prevent — it looks
    # installed and never runs.
    check no "the cron daemon is running" "systemctl enable --now cron"
  fi
else
  check warn "cron daemon state unknown (no systemctl)" "verify by hand that cron actually runs"
fi

MISSING_SCRIPTS=""
for f in scripts/backup.sh scripts/backup-upload.mjs scripts/restore-drill.sh scripts/backup-objects.mjs scripts/cron-run.sh scripts/notify.sh; do
  [ -f "$ROOT_DIR/$f" ] || MISSING_SCRIPTS+="$f "
done
if [ -z "$MISSING_SCRIPTS" ]; then
  check yes "every script the schedule calls exists under $ROOT_DIR"
else
  check no "every script the schedule calls exists under $ROOT_DIR" "missing: $MISSING_SCRIPTS"
fi

MISSING_BINS=""
for bin in node psql pg_dump pg_dumpall pg_restore jq flock; do
  command -v "$bin" >/dev/null 2>&1 || MISSING_BINS+="$bin "
done
if [ -z "$MISSING_BINS" ]; then
  check yes "backup toolchain on PATH (node, psql, pg_dump, pg_dumpall, pg_restore, jq, flock)"
else
  check no "backup toolchain on PATH" "missing: $MISSING_BINS — scripts/provision-ubuntu.sh installs these"
fi

# cron's PATH is /usr/bin:/bin. A node installed under /usr/local/bin or a
# version manager works from an interactive shell and vanishes under cron —
# a failure that only shows up at 03:15.
NODE_BIN="$(command -v node 2>/dev/null || true)"
case "$NODE_BIN" in
  /usr/bin/node | /bin/node) check yes "node is on cron's PATH ($NODE_BIN)" ;;
  "") check no "node is installed" ;;
  *) check warn "node is at $NODE_BIN, which is NOT on cron's default PATH" \
       "the block below sets PATH explicitly, so this works — but keep them in sync" ;;
esac

if [ -n "$NODE_BIN" ]; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -ge 22 ]; then
    check yes "node $(node -v) meets the repo's >= 22.12 engine"
  else
    check no "node >= 22" "found $(node -v 2>/dev/null || echo none)"
  fi
  # backup-upload.mjs and backup-objects.mjs import @aws-sdk/client-s3 from
  # the repo's node_modules. On a build-on-the-VPS host it is easy to have
  # never run an install outside Docker, in which case both scripts fail at
  # import time — at 03:15, nightly, forever.
  if (cd "$ROOT_DIR" && node -e 'import("@aws-sdk/client-s3").then(()=>process.exit(0),()=>process.exit(1))' 2>/dev/null); then
    check yes "@aws-sdk/client-s3 resolves from $ROOT_DIR"
  else
    check no "@aws-sdk/client-s3 resolves from $ROOT_DIR" "run: cd $ROOT_DIR && pnpm install --frozen-lockfile"
  fi
fi

# The env file's own contents, checked in a subshell so nothing leaks into
# this one.
ENV_REPORT="$(
  set +e
  # shellcheck source=/dev/null
  [ -r "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
  printf 'DATABASE_URL=%s\n' "${DATABASE_URL:-}"
  printf 'S3=%s|%s|%s|%s\n' "${S3_ENDPOINT:-}" "${S3_BUCKET:-}" "${S3_ACCESS_KEY:-}" "${S3_SECRET_KEY:-}"
  printf 'OFFSITE=%s|%s|%s|%s\n' "${BACKUP_S3_ENDPOINT:-}" "${BACKUP_S3_BUCKET:-}" "${BACKUP_S3_ACCESS_KEY:-}" "${BACKUP_S3_SECRET_KEY:-}"
  printf 'ALERT=%s|%s\n' "${VENTIA_ALERT_COMMAND:-}" "${VENTIA_ALERT_WEBHOOK_URL:-}"
)"
env_field() { printf '%s\n' "$ENV_REPORT" | sed -n "s/^$1=//p"; }

DB_URL_CFG="$(env_field DATABASE_URL)"
if [ -z "$DB_URL_CFG" ] || [ "${DB_URL_CFG#*CHANGE_ME}" != "$DB_URL_CFG" ]; then
  check no "DATABASE_URL is set in $ENV_FILE" "still the placeholder, or absent"
elif psql "$DB_URL_CFG" -tAc 'SELECT 1' >/dev/null 2>&1; then
  check yes "DATABASE_URL connects from this host"
else
  # Refusing here rather than at 03:15. The most common cause on this
  # architecture is a compose stack that does not publish 5432 to the host
  # at all, which no amount of retrying fixes.
  check no "DATABASE_URL connects from this host" "psql could not connect — is Postgres published on 127.0.0.1:5432?"
fi

IFS='|' read -r S3_EP S3_BK S3_AK S3_SK <<<"$(env_field S3)"
if [ -n "$S3_EP" ] && [ -n "$S3_BK" ] && [ -n "$S3_AK" ] && [ -n "$S3_SK" ]; then
  check yes "product-image bucket configured ($S3_EP/$S3_BK)"
else
  check no "product-image bucket configured (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY)" \
    "without these the nightly job backs up Postgres only, and a lost box loses every merchant's images"
fi

IFS='|' read -r O_EP O_BK O_AK O_SK <<<"$(env_field OFFSITE)"
if [ -n "$O_EP" ] && [ -n "$O_BK" ] && [ -n "$O_AK" ] && [ -n "$O_SK" ]; then
  check yes "offsite target configured ($O_EP/$O_BK)"
elif [ -z "$O_EP$O_BK$O_AK$O_SK" ]; then
  check no "offsite target configured" "all four BACKUP_S3_* are empty — backups would live only on the host they protect"
else
  check no "offsite target configured" "HALF configured; backup-upload.mjs refuses to run like this"
fi

if [ "$DRY_RUN" = "1" ]; then
  check warn "backup directory $BACKUP_DIR (dry run: not created)"
elif mkdir -p "$BACKUP_DIR" 2>/dev/null; then
  if [ "$(id -u)" = "0" ]; then chown "$TARGET_USER" "$BACKUP_DIR" 2>/dev/null || true; fi
  check yes "backup directory $BACKUP_DIR exists"
else
  check no "backup directory $BACKUP_DIR is creatable" "create it and chown it to $TARGET_USER"
fi

IFS='|' read -r A_CMD A_URL <<<"$(env_field ALERT)"
if [ -n "$A_CMD" ] || [ -n "$A_URL" ]; then
  check yes "an alert channel is configured in $ENV_FILE"
  ALERTS_OK=1
elif [ "$ALLOW_NO_ALERTS" = "1" ]; then
  check warn "NO alert channel configured, and --allow-no-alerts was passed" \
    "failures will reach syslog and $BACKUP_DIR's logs and nowhere else"
  ALERTS_OK=1
else
  check no "an alert channel is configured in $ENV_FILE" \
    "set VENTIA_ALERT_COMMAND or VENTIA_ALERT_WEBHOOK_URL, or pass --allow-no-alerts to install anyway"
  ALERTS_OK=0
fi

echo
echo "  $PASS passed, $WARN warning(s), $FAIL failed"
echo

# ---------------------------------------------------------------------------
# The block itself.
#
# MAILTO="" because cron's own failure mail goes to a local spool that nobody
# reads on a box with no MTA; notification is cron-run.sh's job and it must be
# the only one, or "no mail" starts meaning "probably fine".
#
# PATH is set explicitly: cron's default is /usr/bin:/bin, and node from
# NodeSource lands in /usr/bin but pnpm/corepack shims do not.
#
# CRON_TZ=UTC so these times mean what docs/operations.md says they mean
# regardless of the host's timezone. (Debian/Ubuntu's cron supports CRON_TZ;
# if a `crontab -l` on some other cron shows it as a plain comment, the times
# are local instead — check once, after installing.)
# ---------------------------------------------------------------------------
NIGHTLY_CHAIN="bash scripts/backup.sh && node scripts/backup-upload.mjs && node scripts/backup-objects.mjs && node scripts/backup-objects.mjs --upload"

# If node lives somewhere cron would not find it (a version manager, /opt),
# its directory is added to the block's PATH. The WARN above tells you it
# happened; this makes the schedule work anyway instead of failing nightly on
# "node: command not found".
CRON_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if [ -n "$NODE_BIN" ]; then
  NODE_DIR="$(dirname "$NODE_BIN")"
  case ":$CRON_PATH:" in
    *":$NODE_DIR:"*) : ;;
    *) CRON_PATH="$NODE_DIR:$CRON_PATH" ;;
  esac
fi

BLOCK="$(cat <<BLOCK_EOF
$BEGIN_MARK
MAILTO=""
PATH=$CRON_PATH
CRON_TZ=UTC
VENTIA_CRON_ENV=$ENV_FILE
#
# Nightly, 03:15 UTC — Postgres dump + globals + manifest, offsite, then the
# product-image bucket and ITS offsite copy. Chained with && so a failed step
# stops the run instead of being papered over by the next one.
15 3 * * * cd $ROOT_DIR && bash scripts/cron-run.sh backup '$NIGHTLY_CHAIN'
#
# Weekly, Sunday 04:00 UTC — restore the newest dump into a scratch database
# and prove tenant isolation survived. A backup nobody has restored is an
# assumption (scripts/restore-drill.sh).
0 4 * * 0 cd $ROOT_DIR && bash scripts/cron-run.sh restore-drill 'bash scripts/restore-drill.sh --latest'
#
# Weekly, Sunday 05:00 UTC — the same posture for product images: unpack the
# newest object archive into a scratch bucket and re-hash every object.
# Separate entry rather than chained onto the line above, because the two
# drills are independent and a failed database drill must not silently cancel
# the image one.
0 5 * * 0 cd $ROOT_DIR && bash scripts/cron-run.sh objects-drill 'node scripts/backup-objects.mjs --drill --latest'
$END_MARK
BLOCK_EOF
)"

echo "--- crontab block --------------------------------------------"
printf '%s\n' "$BLOCK"
echo "--------------------------------------------------------------"
echo

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN — nothing was installed."
  if [ "$FAIL" -gt 0 ]; then
    echo "Preflight found $FAIL problem(s); a real run would refuse (use --force to override)."
    exit 1
  fi
  exit 0
fi

if [ "$FAIL" -gt 0 ] && [ "$FORCE" != "1" ]; then
  echo "error: $FAIL preflight check(s) failed — refusing to install a schedule that cannot work." >&2
  echo "       Fix them, or re-run with --force if you know better than this list." >&2
  exit 1
fi
if [ "$ALERTS_OK" != "1" ] && [ "$FORCE" != "1" ]; then
  echo "error: refusing to schedule backups with no alert channel." >&2
  exit 1
fi

command -v crontab >/dev/null 2>&1 || { echo "error: crontab is not installed." >&2; exit 1; }

CURRENT="$(crontab_read)"
# Strip any previous block first, then append the new one — this is what makes
# re-running safe. sed with `|` delimiters because the markers contain no `|`
# but do contain `/`-free prose; the range deletes marker lines inclusive.
STRIPPED="$(printf '%s\n' "$CURRENT" | sed "\|^${BEGIN_MARK}\$|,\|^${END_MARK}\$|d")"
HAD_BLOCK=no
if printf '%s\n' "$CURRENT" | grep -qF "$BEGIN_MARK"; then HAD_BLOCK=yes; fi

{
  printf '%s\n' "$STRIPPED" | sed '/^$/d'
  echo
  printf '%s\n' "$BLOCK"
} | crontab_write

INSTALLED="$(crontab_read)"
# Verify by reading the crontab back, not by trusting `crontab -`'s exit code:
# a crontab rejected for a syntax error leaves the OLD one in place and the
# only evidence is on stderr.
BLOCK_COUNT="$(printf '%s\n' "$INSTALLED" | grep -cF "$BEGIN_MARK" || true)"
JOB_COUNT="$(printf '%s\n' "$INSTALLED" | grep -cE '^[0-9]+ [0-9]+ .*cron-run\.sh ' || true)"
if [ "$BLOCK_COUNT" != "1" ] || [ "$JOB_COUNT" != "3" ]; then
  echo "error: read-back failed — expected 1 managed block and 3 jobs, found $BLOCK_COUNT and $JOB_COUNT." >&2
  exit 1
fi

echo "=============================================================="
echo " Installed into ${TARGET_USER}'s crontab (previous block: $HAD_BLOCK)"
echo " Verified by read-back: 1 block, 3 jobs."
echo "=============================================================="
echo
echo "Next, and none of it is optional:"
echo "  1. Prove the alert channel works — you have not seen it deliver yet:"
echo "       bash $ROOT_DIR/scripts/notify.sh --test"
echo "     Then go and LOOK at the destination. 'Delivered' only means the"
echo "     request was accepted."
echo "  2. Run the nightly chain by hand once, tonight's schedule is too late"
echo "     to find out it cannot connect:"
echo "       cd $ROOT_DIR && bash scripts/cron-run.sh backup '$NIGHTLY_CHAIN'"
echo "  3. Logs land in \${VENTIA_LOG_DIR:-/var/log/ventia}/<job>.log and the"
echo "     last-run status in /var/lib/ventia/<job>.last. Nothing on this box"
echo "     watches that file's age — see the note at the top of this script."
