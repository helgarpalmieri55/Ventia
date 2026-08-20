#!/usr/bin/env bash
# One place that answers "how does this box tell a human something broke".
#
# docs/deploying.md §7 and docs/operations.md both say the same thing: a backup
# whose failures go to a logfile nobody reads is a backup nobody has. Every
# scheduled job on this host routes its failures through here, so there is
# exactly one thing to configure and exactly one thing to test.
#
# THE DEFAULT IS UNCONFIGURED, ON PURPOSE. No integration is invented here —
# nothing in this repo has credentials for Slack, PagerDuty, email or anything
# else, and a notifier that silently pretends to deliver is worse than no
# notifier, because it converts "we have no alerting" (visible) into "we have
# alerting" (false). With no channel set this script writes to stderr and
# syslog and exits 78 (EX_CONFIG), which its callers report as "the alert
# could NOT be delivered" rather than swallowing.
#
# Two ways to configure it, both a single value:
#
#   VENTIA_ALERT_COMMAND   An arbitrary shell command. It is run as
#                            sh -c "$VENTIA_ALERT_COMMAND" ventia-notify "<subject>"
#                          so "$1" is the subject and the full body arrives on
#                          stdin. This is the escape hatch that covers every
#                          service, including ones that need auth headers,
#                          a different JSON shape, or an MTA:
#                            VENTIA_ALERT_COMMAND='mail -s "$1" ops@example.co'
#                            VENTIA_ALERT_COMMAND='curl -sS --fail -H "Title: $1" -d @- https://ntfy.sh/my-topic'
#
#   VENTIA_ALERT_WEBHOOK_URL
#                          POSTs {"text": "<subject>\n\n<body>"} as JSON. That
#                          is the Slack incoming-webhook shape and is accepted
#                          by several others. NOT VERIFIED AGAINST ANY REAL
#                          SERVICE — no account existed to test against. If
#                          your endpoint wants a different field name, use
#                          VENTIA_ALERT_COMMAND with curl instead of guessing.
#
# If both are set, both are attempted; delivery to either one counts as
# delivered, and a failure of the other is reported. Two channels configured
# means you asked for redundancy, not for one to mask the other's failure.
#
# Usage:
#   bash scripts/notify.sh "subject line" < body
#   bash scripts/notify.sh "subject line" /path/to/body
#   bash scripts/notify.sh --test            # send a test alert, then say so
#
# Exit codes: 0 delivered on at least one channel; 78 no channel configured;
#             1 a configured channel was tried and failed.
set -euo pipefail

: "${VENTIA_ALERT_COMMAND:=}"
: "${VENTIA_ALERT_WEBHOOK_URL:=}"
: "${VENTIA_ALERT_TIMEOUT:=15}"
: "${VENTIA_ALERT_RETRIES:=3}"

TEST_MODE=0
if [ "${1:-}" = "--test" ]; then
  TEST_MODE=1
  shift
fi
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,50p' "$0"
  exit 0
fi

HOSTNAME_S="$(hostname -f 2>/dev/null || hostname)"
if [ "$TEST_MODE" = "1" ]; then
  SUBJECT="[ventia] test alert from $HOSTNAME_S"
  BODY="This is a deliberate test from scripts/notify.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ).

If you are reading this in the place you expect to be paged, the alert channel
works. If you are not, then every nightly backup failure on $HOSTNAME_S is
currently going nowhere."
else
  SUBJECT="${1:-}"
  [ -n "$SUBJECT" ] || { echo "usage: notify.sh <subject> [body-file]   (body may also come on stdin)" >&2; exit 2; }
  if [ -n "${2:-}" ]; then
    [ -f "$2" ] || { echo "error: body file not found: $2" >&2; exit 2; }
    BODY="$(cat "$2")"
  elif [ ! -t 0 ]; then
    BODY="$(cat)"
  else
    BODY=""
  fi
fi

# Always leave a local trace, whatever happens next. journald is the one place
# an operator investigating this box will look without being told to, and it is
# what survives when the outbound channel is the thing that is broken.
if command -v logger >/dev/null 2>&1; then
  logger -t ventia-alert -p daemon.err -- "$SUBJECT" || true
fi

if [ -z "$VENTIA_ALERT_COMMAND" ] && [ -z "$VENTIA_ALERT_WEBHOOK_URL" ]; then
  {
    echo "================================================================"
    echo " ALERT (NOT DELIVERED — no alert channel configured)"
    echo " $SUBJECT"
    echo "----------------------------------------------------------------"
    [ -n "$BODY" ] && echo "$BODY"
    echo "----------------------------------------------------------------"
    echo " Set VENTIA_ALERT_COMMAND or VENTIA_ALERT_WEBHOOK_URL (see the"
    echo " header of scripts/notify.sh, and /etc/ventia/cron.env for the"
    echo " scheduled jobs). Until then failures on this host are visible"
    echo " only in syslog and the job logs."
    echo "================================================================"
  } >&2
  exit 78
fi

DELIVERED=0
FAILED=0

if [ -n "$VENTIA_ALERT_COMMAND" ]; then
  # `sh -c CMD name arg` — "name" becomes $0 and the subject becomes $1, so an
  # operator's one-liner can interpolate "$1" without this script doing any
  # string surgery on their command (which is how quoting bugs and injection
  # both start).
  if printf '%s\n' "$BODY" | sh -c "$VENTIA_ALERT_COMMAND" ventia-notify "$SUBJECT"; then
    echo "notify: delivered via VENTIA_ALERT_COMMAND" >&2
    DELIVERED=$((DELIVERED + 1))
  else
    echo "notify: VENTIA_ALERT_COMMAND FAILED (exit $?)" >&2
    FAILED=$((FAILED + 1))
  fi
fi

if [ -n "$VENTIA_ALERT_WEBHOOK_URL" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    # Refusing rather than hand-rolling JSON escaping: a subject containing a
    # quote or a newline would produce a malformed body, the endpoint would
    # 400, and the alert would be lost at exactly the moment it mattered.
    echo "notify: jq is required for VENTIA_ALERT_WEBHOOK_URL (apt-get install jq); not sending" >&2
    FAILED=$((FAILED + 1))
  else
    PAYLOAD="$(jq -Rn --arg s "$SUBJECT" --arg b "$BODY" '{text: ($s + "\n\n" + $b)}')"
    ok=0
    for attempt in $(seq 1 "$VENTIA_ALERT_RETRIES"); do
      # Retried because a single transient network blip must not be the reason
      # nobody heard about a failed backup. --fail-with-body so a 4xx/5xx is a
      # non-zero exit AND the response body is shown, which is how a wrong URL
      # or a revoked token identifies itself.
      if RESPONSE="$(printf '%s' "$PAYLOAD" | curl -sS --fail-with-body --max-time "$VENTIA_ALERT_TIMEOUT" \
        -X POST -H 'Content-Type: application/json' --data-binary @- "$VENTIA_ALERT_WEBHOOK_URL" 2>&1)"; then
        ok=1
        break
      fi
      # The endpoint's own response is what identifies a wrong URL, a revoked
      # token or a rejected payload shape, so it is quoted rather than
      # swallowed — this line is the only diagnostic the operator will get.
      echo "notify: webhook attempt $attempt/$VENTIA_ALERT_RETRIES failed: $(printf '%s' "$RESPONSE" | head -c 300 | tr '\n' ' ')" >&2
      sleep $((attempt * 2))
    done
    if [ "$ok" = "1" ]; then
      echo "notify: delivered via VENTIA_ALERT_WEBHOOK_URL" >&2
      DELIVERED=$((DELIVERED + 1))
    else
      echo "notify: VENTIA_ALERT_WEBHOOK_URL FAILED after $VENTIA_ALERT_RETRIES attempts" >&2
      FAILED=$((FAILED + 1))
    fi
  fi
fi

if [ "$TEST_MODE" = "1" ]; then
  echo "notify: test alert — $DELIVERED channel(s) delivered, $FAILED failed."
  echo "notify: a channel that reports 'delivered' has only told you the request"
  echo "        was accepted. Go and look at the destination before you rely on it."
fi

[ "$DELIVERED" -gt 0 ] || exit 1
[ "$FAILED" -eq 0 ] || echo "notify: delivered on $DELIVERED channel(s) but $FAILED configured channel(s) failed" >&2
exit 0
