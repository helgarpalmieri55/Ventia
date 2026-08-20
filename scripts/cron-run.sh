#!/usr/bin/env bash
# The wrapper every scheduled job on this host runs inside. It exists because
# `cron` on its own gets three things wrong for backup jobs:
#
#   1. cron's idea of failure notification is mailing root, which on a fresh
#      VPS with no MTA means the message is written to a spool nobody opens.
#      Here a non-zero exit goes to scripts/notify.sh — one configurable
#      channel, and it says so loudly when it is unconfigured.
#   2. cron happily starts a second copy of a job while the first is still
#      running. Two concurrent pg_dumps on a 2 GB box is how a backup window
#      turns into an outage; a lock makes the overlap visible instead.
#   3. cron's environment is almost empty (no DATABASE_URL, no BACKUP_S3_*,
#      PATH=/usr/bin:/bin). Secrets do not belong in a crontab line, so they
#      are read from an env file that this script sources.
#
# Usage (this is exactly what scripts/install-cron.sh puts in the crontab):
#   bash scripts/cron-run.sh <job-name> '<shell command, may contain && >'
#
# The command is passed as ONE string and run with `bash -c`, so the `&&`
# chaining is visible in `crontab -l` rather than buried in a wrapper. That is
# deliberate: at 3am the crontab should show what actually runs.
#
# Env:
#   VENTIA_CRON_ENV    env file sourced before the job, default
#                      /etc/ventia/cron.env. Missing is allowed (with a
#                      warning); unreadable is not.
#   VENTIA_LOG_DIR     default /var/log/ventia
#   VENTIA_STATE_DIR   default /var/lib/ventia — last-run status per job
#   VENTIA_ALERT_*     see scripts/notify.sh
#
# Exit code is the job's own. Nothing here ever converts a failure into a
# success: if the alert itself cannot be delivered that is reported as a
# SECOND problem, and the job's failure still stands.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

JOB="${1:-}"
COMMAND="${2:-}"
if [ -z "$JOB" ] || [ -z "$COMMAND" ]; then
  echo "usage: cron-run.sh <job-name> '<command>'" >&2
  exit 2
fi
case "$JOB" in
  # The job name becomes part of a lock path, a log path and a state path.
  # Constraining it here means none of those three need to think about it.
  *[!a-zA-Z0-9._-]*) echo "error: job name must be [a-zA-Z0-9._-]+, got '$JOB'" >&2; exit 2 ;;
esac

: "${VENTIA_CRON_ENV:=/etc/ventia/cron.env}"
: "${VENTIA_LOG_DIR:=/var/log/ventia}"
: "${VENTIA_STATE_DIR:=/var/lib/ventia}"
: "${VENTIA_LOCK_DIR:=/var/lock}"

if [ -f "$VENTIA_CRON_ENV" ]; then
  if [ ! -r "$VENTIA_CRON_ENV" ]; then
    echo "error: $VENTIA_CRON_ENV exists but is not readable by $(id -un) — refusing to run a job with half its configuration." >&2
    exit 1
  fi
  # `set -a` so plain `KEY=value` lines in the file become environment for the
  # job, without every line needing `export`. The file is a shell fragment by
  # design (it can compute values); it is also 0600 and owned by the job user,
  # which install-cron.sh enforces.
  set -a
  # shellcheck source=/dev/null
  . "$VENTIA_CRON_ENV"
  set +a
else
  echo "warning: $VENTIA_CRON_ENV does not exist — the job runs with cron's bare environment." >&2
fi

mkdir -p "$VENTIA_LOG_DIR" 2>/dev/null || true
LOG_FILE="$VENTIA_LOG_DIR/$JOB.log"
if ! touch "$LOG_FILE" 2>/dev/null; then
  # Falling back rather than dying: losing the log is bad, losing the backup
  # because the log directory was not writable is worse.
  LOG_FILE="${TMPDIR:-/tmp}/ventia-$JOB.log"
  echo "warning: $VENTIA_LOG_DIR is not writable; logging to $LOG_FILE instead" >&2
fi

OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/ventia-$JOB.XXXXXX.out")"
LOCK_FILE="$VENTIA_LOCK_DIR/ventia-$JOB.lock"
touch "$LOCK_FILE" 2>/dev/null || LOCK_FILE="${TMPDIR:-/tmp}/ventia-$JOB.lock"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_EPOCH="$(date +%s)"
HOST="$(hostname -f 2>/dev/null || hostname)"

alert() {
  local subject="$1" body_file="$2"
  if VENTIA_ALERT_COMMAND="${VENTIA_ALERT_COMMAND:-}" VENTIA_ALERT_WEBHOOK_URL="${VENTIA_ALERT_WEBHOOK_URL:-}" \
     bash "$ROOT_DIR/scripts/notify.sh" "$subject" "$body_file"; then
    echo "cron-run: alert delivered" | tee -a "$LOG_FILE"
  else
    local rc=$?
    # Said out loud, twice, because "the job failed AND nobody was told" is a
    # strictly worse state than "the job failed" and must not look the same in
    # the log.
    echo "cron-run: ALERT NOT DELIVERED (notify.sh exit $rc) — this failure reached nobody" | tee -a "$LOG_FILE" >&2
  fi
}

{
  echo
  echo "=============================================================="
  echo " ventia cron job '$JOB' — $STARTED_AT on $HOST"
  echo " command: $COMMAND"
  echo "=============================================================="
} | tee -a "$LOG_FILE"

# flock -n: do not queue behind the running copy, report the overlap. A nightly
# backup still running when the next night's fires is a real incident (a hung
# pg_dump, a wedged upload) and is worth waking someone for; silently skipping
# it produces a gap in the backup history that nobody sees until a restore.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  MSG="ventia $JOB SKIPPED on $HOST — the previous run is STILL RUNNING (lock $LOCK_FILE held)"
  echo "$MSG" | tee -a "$LOG_FILE" >&2
  printf '%s\n\nStarted: %s\nLog: %s\n\nA scheduled run was skipped because the previous one has not finished.\nCheck for a hung process before assuming this is transient.\n' \
    "$MSG" "$STARTED_AT" "$LOG_FILE" > "$OUT_FILE"
  alert "$MSG" "$OUT_FILE"
  rm -f "$OUT_FILE"
  exit 75   # EX_TEMPFAIL — the job did not run, it also did not fail
fi

set +e
# Output is captured to a file AND streamed to the log, so the alert body can
# quote the tail of it. `2>&1` because the interesting part of a failed
# pg_dump/pg_restore is always on stderr.
bash -c "$COMMAND" >"$OUT_FILE" 2>&1
STATUS=$?
set -e

DURATION=$(( $(date +%s) - START_EPOCH ))
cat "$OUT_FILE" >> "$LOG_FILE"

# A tiny machine-readable record of the last run, so a health check (or a human
# with `cat`) can answer "when did the backup last succeed" without parsing a
# log. Best-effort: never fail the job over it.
if mkdir -p "$VENTIA_STATE_DIR" 2>/dev/null; then
  printf '{"job":"%s","startedAt":"%s","durationSeconds":%d,"exitCode":%d,"log":"%s"}\n' \
    "$JOB" "$STARTED_AT" "$DURATION" "$STATUS" "$LOG_FILE" > "$VENTIA_STATE_DIR/$JOB.last" 2>/dev/null || true
fi

if [ "$STATUS" -eq 0 ]; then
  echo "cron-run: '$JOB' OK in ${DURATION}s" | tee -a "$LOG_FILE"
else
  echo "cron-run: '$JOB' FAILED (exit $STATUS) after ${DURATION}s" | tee -a "$LOG_FILE" >&2
  BODY="$(mktemp "${TMPDIR:-/tmp}/ventia-$JOB-alert.XXXXXX")"
  {
    echo "host:     $HOST"
    echo "job:      $JOB"
    echo "started:  $STARTED_AT"
    echo "duration: ${DURATION}s"
    echo "exit:     $STATUS"
    echo "command:  $COMMAND"
    echo "log:      $LOG_FILE"
    echo
    echo "--- last 40 lines of output ------------------------------"
    tail -n 40 "$OUT_FILE"
  } > "$BODY"
  alert "ventia $JOB FAILED (exit $STATUS) on $HOST" "$BODY"
  rm -f "$BODY"
fi

rm -f "$OUT_FILE"
exit "$STATUS"
