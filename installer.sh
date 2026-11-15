#!/usr/bin/env bash
set -Eeuo pipefail

# GitHub entry point. It reuses an existing checkout under /opt or /root; if only
# a root-owned checkout exists, it stages a clean Git clone under /opt for services.
REPOSITORY=https://github.com/anuragbiswas9733832815-boop/NovaPanel.git
EXPLICIT_INSTALL_DIR=${NOVA_INSTALL_DIR:-}
INSTALL_DIR=${EXPLICIT_INSTALL_DIR:-/opt/nova-panel}
OPT_REPO=''
ROOT_REPO=''

is_nova_repo() {
  local path=$1
  [[ -e "$path/.git" && -f "$path/package.json" && -f "$path/apps/api/src/server.ts" && -f "$path/apps/agent/go.mod" ]]
}

if [[ -z "$EXPLICIT_INSTALL_DIR" ]]; then
  # Prefer an existing service-ready checkout under /opt.
  for candidate in /opt/nova-panel /opt/NovaPanel /opt/novapanel; do
    if is_nova_repo "$candidate"; then OPT_REPO=$candidate; break; fi
  done
  if [[ -z "$OPT_REPO" ]]; then
    for candidate in /opt/*; do
      [[ -d "$candidate" ]] || continue
      if is_nova_repo "$candidate"; then OPT_REPO=$candidate; break; fi
    done
  fi
  # A clone under /root is still detected, but services are staged into /opt because
  # systemd's unprivileged users must not need traversal access to /root.
  if [[ -z "$OPT_REPO" ]]; then
    for candidate in /root/nova-panel /root/NovaPanel /root/novapanel; do
      if is_nova_repo "$candidate"; then ROOT_REPO=$candidate; break; fi
    done
    if [[ -z "$ROOT_REPO" ]]; then
      for candidate in /root/*; do
        [[ -d "$candidate" ]] || continue
        if is_nova_repo "$candidate"; then ROOT_REPO=$candidate; break; fi
      done
    fi
  fi
  if [[ -n "$OPT_REPO" ]]; then
    INSTALL_DIR=$OPT_REPO
  elif [[ -n "$ROOT_REPO" ]]; then
    INSTALL_DIR=/opt/nova-panel
  fi
elif is_nova_repo "$INSTALL_DIR"; then
  OPT_REPO=$INSTALL_DIR
fi

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run as root, for example: curl -fsSL <installer-url> | sudo bash' >&2
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo 'This installer currently supports Debian/Ubuntu (apt).' >&2
  exit 1
fi
if [[ ! "$INSTALL_DIR" =~ ^/[^[:space:]]+$ || "$INSTALL_DIR" == *..* ]]; then
  echo 'NOVA_INSTALL_DIR must be an absolute path without spaces or parent traversal.' >&2
  exit 2
fi

if [[ -n ${NOVA_BRANCH:-} ]]; then
  BRANCH=$NOVA_BRANCH
elif [[ -n "$OPT_REPO" ]]; then
  BRANCH=$(git -C "$OPT_REPO" branch --show-current)
  [[ -n "$BRANCH" ]] || BRANCH=main
elif [[ -n "$ROOT_REPO" ]]; then
  BRANCH=$(git -C "$ROOT_REPO" branch --show-current)
  [[ -n "$BRANCH" && "$BRANCH" != HEAD ]] || BRANCH=main
else
  BRANCH=main
fi
if [[ ! "$BRANCH" =~ ^[A-Za-z0-9._/-]{1,100}$ || "$BRANCH" == -* || "$BRANCH" == *..* ]]; then
  echo 'NOVA_BRANCH contains invalid characters.' >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates git
install -d -o root -g root -m 0755 "$(dirname "$INSTALL_DIR")"

if [[ -n "$OPT_REPO" ]]; then
  [[ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ]] || { echo "The checkout at $INSTALL_DIR has local changes; preserve them and retry with a clean checkout." >&2; exit 1; }
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  if git -C "$INSTALL_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$INSTALL_DIR" checkout "$BRANCH"
  else
    git -C "$INSTALL_DIR" checkout -b "$BRANCH" FETCH_HEAD
  fi
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
elif [[ -n "$ROOT_REPO" ]]; then
  [[ ! -e "$INSTALL_DIR" ]] || { echo "$INSTALL_DIR exists but is not a recognized NovaPanel checkout; refusing to overwrite it." >&2; exit 1; }
  [[ -z "$(git -C "$ROOT_REPO" status --porcelain)" ]] || { echo "The checkout at $ROOT_REPO has local changes; commit or preserve them before staging a service copy." >&2; exit 1; }
  git clone --local --no-hardlinks --single-branch --branch "$BRANCH" "$ROOT_REPO" "$INSTALL_DIR"
  git -C "$INSTALL_DIR" remote set-url origin "$REPOSITORY"
else
  [[ ! -e "$INSTALL_DIR" ]] || { echo "$INSTALL_DIR exists but is not a recognized NovaPanel checkout; refusing to overwrite it." >&2; exit 1; }
  git clone --depth 1 --single-branch --branch "$BRANCH" "$REPOSITORY" "$INSTALL_DIR"
fi

if [[ ${NOVA_CONFIRM_INSTALL:-} != YES && -t 0 ]]; then
  CONFIRM=''
  for attempt in 1 2 3; do
    read -r -p "Repository ready at $INSTALL_DIR. Review scripts/install-vps.sh, then type INSTALL to continue: " CONFIRM
    CONFIRM=${CONFIRM//[[:space:]]/}
    CONFIRM=${CONFIRM^^}
    case "$CONFIRM" in
      INSTALL|INST|YES|Y) break ;;
      CANCEL|C|NO|N) echo 'Installation cancelled.' >&2; exit 1 ;;
      *) echo 'Please type INSTALL (or INST) to proceed, or CANCEL to stop.' >&2 ;;
    esac
  done
  [[ "$CONFIRM" == INSTALL || "$CONFIRM" == INST || "$CONFIRM" == YES || "$CONFIRM" == Y ]] || { echo 'Too many invalid confirmations; installation cancelled.' >&2; exit 1; }
elif [[ ${NOVA_CONFIRM_INSTALL:-} != YES ]]; then
  echo 'Non-interactive root install requires NOVA_CONFIRM_INSTALL=YES after reviewing the cloned installer.' >&2
  exit 2
fi

exec bash "$INSTALL_DIR/scripts/install-vps.sh" --install-dir "$INSTALL_DIR"
