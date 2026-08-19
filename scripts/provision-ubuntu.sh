#!/usr/bin/env bash
# Takes a fresh Ubuntu 24.04 VPS to the point where `scripts/deploy.sh` and
# `scripts/install-cron.sh` can run. One box: Docker builds the images here,
# Postgres and MinIO run here, backups are taken here and shipped offsite from
# here (docs/deploying.md).
#
# Idempotent. Every section checks the end state before touching anything and
# prints [ok] (already true) or [changed] (this run did it), so a re-run after
# a half-finished first attempt is safe and its output tells you what was
# actually left to do.
#
# Run it as root on the SERVER:
#   sudo bash scripts/provision-ubuntu.sh
#   sudo bash scripts/provision-ubuntu.sh --dry-run          # print, change nothing
#   sudo bash scripts/provision-ubuntu.sh --deploy-user bob
#
# ===========================================================================
# THE LOCKOUT RULE, which is the only thing here that can end your access:
#
# ufw is enabled only after SSH's actual listening port(s) are allowed, read
# from sshd's own effective config rather than assumed to be 22.
#
# Password authentication is disabled ONLY IF an authorized key already exists
# for the deploy user or for root. If neither has one, this script REFUSES to
# harden sshd and says so, because the alternative — guessing that you have a
# key somewhere — locks you out of your own server with no way back in except
# your provider's rescue console.
#
# Before you disconnect from the session that ran this: open a SECOND ssh
# session and confirm it works. Everything here is reversible from a shell and
# nothing is reversible without one.
# ===========================================================================
#
# What it does NOT do, deliberately:
#   * No fail2ban. With password auth off and key-only login, its value is
#     log noise reduction, not security, and it is one more moving part that
#     can ban you from your own box.
#   * No automatic reboots for kernel updates. Security updates install
#     unattended; the reboot they sometimes need is left to a human, because
#     an unannounced 3am reboot mid-checkout is not a safety feature. See the
#     summary — it tells you when a reboot is pending.
#   * No secrets. It creates /etc/ventia/ and the empty directories, and never
#     writes a credential.
#   * It does not clone the repo or deploy anything.
set -euo pipefail

DEPLOY_USER="ventia"
APP_DIR="/srv/ventia"
DRY_RUN=0
RESTART_DOCKER=0
# 4 GiB. Justification, not a round number: this box builds TWO Next.js
# production apps (apps/admin, apps/storefront) plus a Nest service in place,
# and a Next production build peaks around 1.5-2 GB of RSS on its own. With
# Postgres, Redis and MinIO resident at the same time, anything under 4 GB
# completes only by leaning on swap, slowly — or gets OOM-killed with an
# opaque exit 137.
MIN_RAM_MB=4096

while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-user) DEPLOY_USER="${2:?--deploy-user needs a name}"; shift 2 ;;
    --app-dir) APP_DIR="${2:?--app-dir needs a path}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --restart-docker) RESTART_DOCKER=1; shift ;;
    -h | --help) sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
CHANGES=""
MANUAL=""
ok()      { printf '  [ok]      %s\n' "$1"; }
changed() { printf '  %s[changed]%s %s\n' "$GREEN" "$OFF" "$1"; CHANGES+="  - $1"$'\n'; }
warn()    { printf '  %s[warn]%s    %s\n' "$YELLOW" "$OFF" "$1"; }
manual()  { MANUAL+="  - $1"$'\n'; }
section() { printf '\n%s== %s%s\n' "$BOLD" "$1" "$OFF"; }

# Every mutating command goes through run(), so --dry-run is honest: it cannot
# accidentally change something because one call site forgot to check a flag.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  %s[dry-run]%s %s\n' "$YELLOW" "$OFF" "$*"
    return 0
  fi
  "$@"
}
run_sh() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  %s[dry-run]%s sh -c %s\n' "$YELLOW" "$OFF" "$1"
    return 0
  fi
  sh -c "$1"
}

[ "$(id -u)" = "0" ] || { echo "error: run this as root (sudo bash $0)." >&2; exit 1; }

section "0. Host"
# shellcheck source=/dev/null
. /etc/os-release
echo "  $PRETTY_NAME, kernel $(uname -r), $(nproc) cpu(s)"
if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  # Warn rather than refuse: the package names below are Debian-family and
  # will very likely work. But the operator should know they are off the
  # tested path.
  warn "this script was written for Ubuntu 24.04; you are on ${PRETTY_NAME:-unknown}"
fi

RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
SWAP_MB="$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)"
DISK_FREE_MB="$(df -Pm / | awk 'NR==2 {print $4}')"
echo "  ram ${RAM_MB} MB, swap ${SWAP_MB} MB, free disk on / ${DISK_FREE_MB} MB"
if [ "$RAM_MB" -lt "$MIN_RAM_MB" ]; then
  echo
  echo "${RED}${BOLD}  ############################################################${OFF}"
  echo "${RED}${BOLD}  # ${RAM_MB} MB OF RAM IS BELOW THE ${MIN_RAM_MB} MB THIS DEPLOYMENT NEEDS${OFF}"
  echo "${RED}  #${OFF}"
  echo "${RED}  # This box builds two Next.js apps IN PLACE. Each build peaks"
  echo "${RED}  # around 1.5-2 GB on its own, on top of Postgres, Redis and"
  echo "${RED}  # MinIO. Swap (configured below) will keep the build from being"
  echo "${RED}  # OOM-killed, but swapping a build is slow: expect many minutes,"
  echo "${RED}  # and expect the box to be sluggish while it runs."
  echo "${RED}  #"
  echo "${RED}  # If this is a pilot with real merchants on it, resize the VPS."
  echo "${RED}  # If you keep this size, deploy at a quiet hour and consider"
  echo "${RED}  # building images somewhere else and loading them here.${OFF}"
  echo "${RED}${BOLD}  ############################################################${OFF}"
  echo
  manual "Consider resizing this VPS above ${MIN_RAM_MB} MB RAM, or building images off-box."
fi

section "1. Base packages"
export DEBIAN_FRONTEND=noninteractive
run apt-get update -qq
# postgresql-client-16 matches the pgvector/pgvector:pg16 image in the compose
# stack. pg_dump refuses to dump a server NEWER than itself, so the host
# client must not lag the server — and backup.sh/restore-drill.sh both run
# from the host, not from inside a container.
BASE_PKGS=(ca-certificates curl gnupg git jq tar cron ufw unattended-upgrades postgresql-client-16 util-linux)
MISSING_PKGS=()
for pkg in "${BASE_PKGS[@]}"; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING_PKGS+=("$pkg")
done
if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
  run apt-get install -y -qq "${MISSING_PKGS[@]}"
  changed "installed: ${MISSING_PKGS[*]}"
else
  ok "base packages already installed"
fi

if [ "$(timedatectl show -p Timezone --value 2>/dev/null || echo unknown)" = "UTC" ]; then
  ok "timezone is UTC"
else
  # Every timestamp this platform writes — backup filenames, log lines, cron
  # schedules in docs/operations.md — is UTC. A host in another zone means
  # correlating them costs an arithmetic step at exactly the wrong moment.
  run timedatectl set-timezone UTC
  changed "timezone set to UTC"
fi

section "2. Swap"
if [ "$SWAP_MB" -gt 0 ]; then
  ok "swap already active (${SWAP_MB} MB) — left alone"
else
  # Sizing: double the RAM on small boxes (where the build is the binding
  # constraint), match it on larger ones, clamped to [2 GB, 8 GB]. Swap here
  # is insurance against a build's peak, not a working set — if this box is
  # steadily IN swap, the answer is more RAM, not more swap.
  if [ "$RAM_MB" -lt 4096 ]; then WANT_MB=$((RAM_MB * 2)); else WANT_MB="$RAM_MB"; fi
  if [ "$WANT_MB" -lt 2048 ]; then WANT_MB=2048; fi
  if [ "$WANT_MB" -gt 8192 ]; then WANT_MB=8192; fi

  FSTYPE="$(stat -f -c %T / || echo unknown)"
  if [ "$FSTYPE" = "btrfs" ]; then
    # A btrfs swapfile needs a no-COW, non-snapshotted, unshared extent; doing
    # it wrong corrupts the file or hangs the kernel. Refusing to guess.
    warn "/ is btrfs — a swapfile there needs btrfs-specific setup this script will not guess at"
    manual "Create swap by hand (btrfs: chattr +C on a fresh file, or use a swap partition)."
  elif [ "$DISK_FREE_MB" -lt $((WANT_MB + 5120)) ]; then
    warn "only ${DISK_FREE_MB} MB free — not creating a ${WANT_MB} MB swapfile (needs 5 GB headroom for images)"
    manual "Free disk space, then re-run this script to get swap."
  else
    if [ -f /swapfile ]; then
      warn "/swapfile exists but is not active; leaving it alone rather than overwriting it"
      manual "Inspect /swapfile, then: swapon /swapfile"
    else
      # fallocate is instant; a swapfile with holes is rejected by swapon on
      # some filesystems, so the result is verified below and dd is the
      # fallback rather than the default.
      if ! run fallocate -l "${WANT_MB}M" /swapfile 2>/dev/null; then
        run dd if=/dev/zero of=/swapfile bs=1M count="$WANT_MB" status=none
      fi
      run chmod 600 /swapfile
      run mkswap -q /swapfile
      if ! run swapon /swapfile; then
        run rm -f /swapfile
        run dd if=/dev/zero of=/swapfile bs=1M count="$WANT_MB" status=none
        run chmod 600 /swapfile
        run mkswap -q /swapfile
        run swapon /swapfile
      fi
      changed "created and enabled a ${WANT_MB} MB swapfile at /swapfile"
    fi
  fi
fi

if grep -qs '^/swapfile' /etc/fstab; then
  ok "/swapfile is in /etc/fstab (survives reboot)"
elif [ -f /swapfile ]; then
  # Without this line the swap disappears at the next reboot and the first
  # deploy afterwards is the one that gets OOM-killed.
  run_sh "printf '/swapfile none swap sw 0 0\n' >> /etc/fstab"
  changed "added /swapfile to /etc/fstab"
fi

SYSCTL_FILE=/etc/sysctl.d/60-ventia.conf
if [ -f "$SYSCTL_FILE" ]; then
  ok "$SYSCTL_FILE already present"
else
  # Only two knobs, both justified, because a sysctl file full of copied
  # "tuning" is a liability nobody can explain later:
  #   swappiness=10       swap exists for the build's peak, not for steady
  #                       paging. The default of 60 will page out Postgres's
  #                       working set on a busy-but-fine box.
  #   vfs_cache_pressure  keep dentry/inode cache longer; Postgres and the
  #                       Node images touch many small files repeatedly.
  # Everything else (somaxconn, file-max) is already sane on 24.04 and is
  # deliberately not touched.
  run_sh "cat > $SYSCTL_FILE <<'EOF'
# Ventia. See scripts/provision-ubuntu.sh for why exactly these two.
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOF"
  run sysctl -q --system
  changed "wrote $SYSCTL_FILE (vm.swappiness=10, vm.vfs_cache_pressure=50)"
fi

section "3. Docker Engine (from Docker's apt repo, not distro docker.io)"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,) with the compose plugin"
else
  if dpkg -s docker.io >/dev/null 2>&1; then
    # The distro package lags by years and ships no compose plugin; having
    # both installed at once is a genuinely confusing state to debug.
    warn "the distro's docker.io package is installed and will conflict"
    manual "apt-get remove docker.io, then re-run this script."
  fi
  run install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    run_sh "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc"
    run chmod a+r /etc/apt/keyrings/docker.asc
  fi
  run_sh "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \$(# shellcheck source=/dev/null
. /etc/os-release && echo \${UBUNTU_CODENAME:-\$VERSION_CODENAME}) stable\" > /etc/apt/sources.list.d/docker.list"
  run apt-get update -qq
  run apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run systemctl enable --now docker
  changed "installed Docker Engine + compose plugin from download.docker.com"
fi

DAEMON_JSON=/etc/docker/daemon.json
# Two settings, both about surviving on a small single box:
#   log rotation — the default json-file driver grows without bound, and a
#                  chatty container filling / takes Postgres down with it.
#                  This is the single most common way a small VPS dies.
#   nofile       — Postgres and Node in containers inherit the daemon's
#                  ulimits, not the host's PAM limits, so /etc/security/
#                  limits.conf would do nothing here. 65536 is what Postgres
#                  wants once max_connections and the pooler are real.
WANT_DAEMON='{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"},"default-ulimits":{"nofile":{"Name":"nofile","Soft":65536,"Hard":65536}}}'
if [ -f "$DAEMON_JSON" ]; then
  if ! jq -e . "$DAEMON_JSON" >/dev/null 2>&1; then
    warn "$DAEMON_JSON exists but is not valid JSON — not touching it"
    manual "Fix $DAEMON_JSON by hand, then merge in: $WANT_DAEMON"
  elif [ "$(jq -S . "$DAEMON_JSON")" = "$(jq -S --argjson want "$WANT_DAEMON" '. * $want' "$DAEMON_JSON")" ]; then
    ok "$DAEMON_JSON already has log rotation and the nofile limits"
  else
    MERGED="$(jq -S --argjson want "$WANT_DAEMON" '. * $want' "$DAEMON_JSON")"
    run cp "$DAEMON_JSON" "$DAEMON_JSON.bak-$(date -u +%Y%m%d%H%M%S)"
    run_sh "printf '%s\n' '$MERGED' > $DAEMON_JSON"
    changed "merged log rotation + nofile limits into $DAEMON_JSON (backup kept)"
    DOCKER_NEEDS_RESTART=1
  fi
else
  run mkdir -p /etc/docker
  run_sh "printf '%s\n' '$WANT_DAEMON' | jq -S . > $DAEMON_JSON"
  changed "wrote $DAEMON_JSON (log rotation, nofile 65536)"
  DOCKER_NEEDS_RESTART=1
fi

if [ "${DOCKER_NEEDS_RESTART:-0}" = "1" ]; then
  RUNNING_CONTAINERS="$(docker ps -q 2>/dev/null | wc -l || echo 0)"
  if [ "$RUNNING_CONTAINERS" -gt 0 ] && [ "$RESTART_DOCKER" != "1" ]; then
    # Restarting dockerd stops every container. On a box already serving
    # merchants that is an outage, so it is never done implicitly.
    warn "$RUNNING_CONTAINERS container(s) are running; NOT restarting dockerd"
    manual "The new daemon.json applies after: systemctl restart docker (this STOPS every container). Re-run with --restart-docker to do it here."
  else
    run systemctl restart docker
    changed "restarted dockerd to pick up daemon.json"
  fi
fi

section "4. Node.js 22 + pnpm (host-side, for the backup scripts)"
# Not for running the app — that happens in containers. scripts/backup-upload.mjs
# and scripts/backup-objects.mjs run on the HOST from cron and need node plus
# @aws-sdk/client-s3 from the repo's node_modules.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -ge 22 ]; then
  ok "node $(node -v) (>= 22.12 as package.json requires)"
else
  if [ ! -f /etc/apt/keyrings/nodesource.gpg ]; then
    run_sh "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg"
  fi
  run_sh "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list"
  run apt-get update -qq
  run apt-get install -y -qq nodejs
  changed "installed Node.js 22 from NodeSource"
fi
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm --version 2>/dev/null || echo present)"
elif command -v corepack >/dev/null 2>&1; then
  run corepack enable
  run_sh "corepack prepare pnpm@9.15.0 --activate"
  changed "enabled corepack and activated pnpm@9.15.0 (the version in package.json)"
else
  manual "Install pnpm 9.15.0 by hand (corepack was not available)."
fi

section "5. Deploy user"
if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  ok "user $DEPLOY_USER exists"
else
  run useradd --create-home --shell /bin/bash "$DEPLOY_USER"
  changed "created user $DEPLOY_USER"
fi
if id -nG "$DEPLOY_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
  ok "$DEPLOY_USER is in the docker group"
else
  # Membership of the docker group is root-equivalent (a container can mount
  # /). That is accepted here: this user's job IS to run the stack, and the
  # alternative is deploying as root, which is worse.
  run usermod -aG docker "$DEPLOY_USER"
  changed "added $DEPLOY_USER to the docker group"
  manual "$DEPLOY_USER must log out and back in before 'docker ps' works for them."
fi

DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
[ -n "$DEPLOY_HOME" ] || DEPLOY_HOME="/home/$DEPLOY_USER"
DEPLOY_KEYS="$DEPLOY_HOME/.ssh/authorized_keys"
ROOT_KEYS="/root/.ssh/authorized_keys"
has_keys() { [ -s "$1" ] && grep -qE '^[[:space:]]*(ssh-|ecdsa-|sk-)' "$1"; }

if has_keys "$DEPLOY_KEYS"; then
  ok "$DEPLOY_USER has an authorized ssh key"
elif has_keys "$ROOT_KEYS"; then
  # Copying root's key is what makes the non-root user usable at all. Without
  # it the "deploy user" exists but nobody can log in as them, and everyone
  # keeps using root.
  run install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
  run_sh "cp $ROOT_KEYS $DEPLOY_KEYS"
  run chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_KEYS"
  run chmod 600 "$DEPLOY_KEYS"
  changed "copied root's authorized_keys to $DEPLOY_KEYS"
else
  warn "neither $DEPLOY_USER nor root has an authorized ssh key"
  manual "Add your public key to $DEPLOY_KEYS before disabling password auth."
fi

for d in "$APP_DIR" /var/backups/ventia /var/log/ventia /var/lib/ventia; do
  if [ -d "$d" ]; then
    ok "$d exists"
  else
    run install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0755 "$d"
    changed "created $d (owned by $DEPLOY_USER)"
  fi
done
if [ -d /etc/ventia ]; then
  ok "/etc/ventia exists"
else
  run install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /etc/ventia
  changed "created /etc/ventia (0750) — scripts/install-cron.sh writes cron.env here"
fi

section "6. Firewall (ufw)"
# sshd's EFFECTIVE port list, not a guess. A box moved to port 2222 that gets
# `ufw allow 22` and `ufw enable` is unreachable one second later.
SSH_PORTS="$(sshd -T 2>/dev/null | awk '/^port /{print $2}' | sort -u | tr '\n' ' ')"
if [ -z "$SSH_PORTS" ]; then
  SSH_PORTS="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/{print $2}' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | sort -u | tr '\n' ' ')"
fi
[ -n "$SSH_PORTS" ] || SSH_PORTS="22"
echo "  sshd listens on: $SSH_PORTS"

if ! command -v ufw >/dev/null 2>&1; then
  warn "ufw is not installed; skipping the firewall"
  manual "Install ufw and allow $SSH_PORTS, 80 and 443."
else
  for port in $SSH_PORTS; do
    if ufw status 2>/dev/null | grep -qE "^${port}/tcp .*ALLOW"; then
      ok "ufw already allows $port/tcp (ssh)"
    else
      run ufw allow "$port/tcp" comment "ssh"
      changed "ufw: allow $port/tcp (ssh)"
    fi
  done
  for port in 80 443; do
    if ufw status 2>/dev/null | grep -qE "^${port}/tcp .*ALLOW"; then
      ok "ufw already allows $port/tcp"
    else
      run ufw allow "$port/tcp" comment "http(s) — Caddy"
      changed "ufw: allow $port/tcp"
    fi
  done
  run ufw default deny incoming
  run ufw default allow outgoing

  if ufw status 2>/dev/null | grep -q '^Status: active'; then
    ok "ufw is already active"
  else
    # The refusal that matters: enabling a default-deny firewall with no ssh
    # rule is a one-way door.
    SSH_RULE_PRESENT=0
    for port in $SSH_PORTS; do
      if ufw status 2>/dev/null | grep -qE "^${port}/tcp .*ALLOW"; then SSH_RULE_PRESENT=1; fi
    done
    if [ "$SSH_RULE_PRESENT" != "1" ] && [ "$DRY_RUN" != "1" ]; then
      echo "${RED}error: refusing to enable ufw — no ALLOW rule for ssh ($SSH_PORTS) is present.${OFF}" >&2
      exit 1
    fi
    run_sh "ufw --force enable"
    changed "enabled ufw (default deny incoming; ssh + 80/443 allowed)"
  fi

  # This is not decoration. Docker publishes ports by writing its own iptables
  # rules in the DOCKER chain, which is consulted BEFORE ufw's. A compose file
  # that says `ports: ["5432:5432"]` exposes Postgres to the whole internet on
  # a box whose `ufw status` swears the port is denied. The fix is to publish
  # on loopback — "127.0.0.1:5432:5432" — not a firewall rule.
  manual "ufw does NOT filter Docker-published ports. In docker/compose.prod.yaml publish Postgres, Redis and MinIO as 127.0.0.1:PORT:PORT — only Caddy's 80/443 should be 0.0.0.0."
fi

section "7. Unattended security upgrades"
AUTO_FILE=/etc/apt/apt.conf.d/20auto-upgrades
if grep -qs 'Unattended-Upgrade "1"' "$AUTO_FILE"; then
  ok "unattended-upgrades is enabled"
else
  run_sh "cat > $AUTO_FILE <<'EOF'
APT::Periodic::Update-Package-Lists \"1\";
APT::Periodic::Unattended-Upgrade \"1\";
EOF"
  changed "enabled unattended-upgrades (security pocket only, the package default)"
fi
NOREBOOT_FILE=/etc/apt/apt.conf.d/51ventia-no-auto-reboot
if [ -f "$NOREBOOT_FILE" ]; then
  ok "automatic reboots are explicitly disabled"
else
  # Stated explicitly rather than relying on the default staying false: an
  # unannounced reboot during a checkout drops in-flight orders, and this
  # stack has no second node to take over.
  run_sh "printf 'Unattended-Upgrade::Automatic-Reboot \"false\";\n' > $NOREBOOT_FILE"
  changed "wrote $NOREBOOT_FILE (no automatic reboots)"
fi
if [ -f /var/run/reboot-required ]; then
  warn "a reboot is pending (kernel/libc update already installed)"
  manual "Schedule a reboot: updates are installed but not active until then."
fi

section "8. sshd hardening"
if has_keys "$DEPLOY_KEYS" || has_keys "$ROOT_KEYS"; then
  SSHD_DROPIN=/etc/ssh/sshd_config.d/60-ventia.conf
  if [ -f "$SSHD_DROPIN" ]; then
    ok "$SSHD_DROPIN already present"
  else
    # A drop-in rather than editing sshd_config: reversible with `rm`, and it
    # survives a package upgrade replacing the main file.
    run_sh "cat > $SSHD_DROPIN <<'EOF'
# Ventia. Written by scripts/provision-ubuntu.sh ONLY because an authorized
# key was already present — see the lockout rule in that script.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF"
    if run sshd -t; then
      run systemctl reload ssh
      changed "disabled ssh password auth and root password login ($SSHD_DROPIN)"
      manual "OPEN A SECOND SSH SESSION NOW and confirm it works before closing this one. To undo: rm $SSHD_DROPIN && systemctl reload ssh"
    else
      run rm -f "$SSHD_DROPIN"
      warn "sshd rejected the config; reverted and changed nothing"
    fi
  fi
else
  # The refusal the header promises. Guessing here is how an operator loses
  # their own server.
  warn "NOT disabling password authentication: no authorized ssh key exists for $DEPLOY_USER or root"
  manual "Add an ssh key, then re-run this script to harden sshd."
fi

section "9. cron"
if systemctl is-enabled --quiet cron 2>/dev/null; then
  ok "cron is enabled"
else
  run systemctl enable --now cron
  changed "enabled the cron daemon"
fi

echo
echo "=============================================================="
echo "${BOLD} Provisioning summary${OFF}"
echo "=============================================================="
if [ "$DRY_RUN" = "1" ]; then
  echo "${YELLOW} DRY RUN — nothing above was actually changed.${OFF}"
fi
echo
if [ -n "$CHANGES" ]; then
  echo "${BOLD}Changed by this run:${OFF}"
  printf '%s' "$CHANGES"
else
  echo "Nothing changed — this host was already provisioned."
fi
echo
echo "${BOLD}Still to do by hand:${OFF}"
printf '%s' "$MANUAL"
cat <<EOF
  - Clone the repo into $APP_DIR as $DEPLOY_USER, and run
    'pnpm install --frozen-lockfile' there (the backup scripts import
    @aws-sdk/client-s3 from node_modules).
  - Write $APP_DIR/.env (chmod 600) and check it with:
      bash scripts/deploy.sh --check-env
  - Back up PAYMENTS_ENCRYPTION_KEY somewhere that is NOT this box and NOT
    the same backup as the database. Losing it makes every merchant's stored
    gateway credentials permanently undecryptable (docs/deploying.md §1).
  - Deploy:        bash scripts/deploy.sh
  - Schedule backups and their alerting:
                   bash scripts/install-cron.sh --dry-run
  - Promote the platform admin with the UPDATE in docs/deploying.md §3.
EOF
echo
echo "${BOLD}Verify before you trust it:${OFF}"
echo "  ssh -p ${SSH_PORTS%% *} $DEPLOY_USER@<this host>   # from a SECOND terminal"
echo "  sudo -u $DEPLOY_USER docker ps                     # docker group works"
echo "  free -m && swapon --show                           # swap is on"
echo "  sudo ufw status verbose                            # 22/80/443 only"
