#!/usr/bin/env bash
set -Eeuo pipefail

# One-line VPS entry point. The repository is cloned first; the reviewed installer
# inside the clone performs package, database, TLS, panel, and Local Node setup.
REPOSITORY=https://github.com/anuragbiswas9733832815-boop/NovaPanel.git
BRANCH=${NOVA_BRANCH:-main}
INSTALL_DIR=${NOVA_INSTALL_DIR:-/opt/nova-panel}

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
if [[ ! "$BRANCH" =~ ^[A-Za-z0-9._/-]{1,100}$ || "$BRANCH" == -* || "$BRANCH" == *..* ]]; then
  echo 'NOVA_BRANCH contains invalid characters.' >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates git
install -d -o root -g root -m 0755 "$(dirname "$INSTALL_DIR")"

if [[ -e "$INSTALL_DIR" ]]; then
  [[ -d "$INSTALL_DIR/.git" ]] || { echo "$INSTALL_DIR exists and is not a Git checkout; refusing to overwrite it." >&2; exit 1; }
  [[ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ]] || { echo "The checkout at $INSTALL_DIR has local changes; preserve them and retry with a clean install directory." >&2; exit 1; }
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  if git -C "$INSTALL_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$INSTALL_DIR" checkout "$BRANCH"
  else
    git -C "$INSTALL_DIR" checkout -b "$BRANCH" FETCH_HEAD
  fi
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  git clone --depth 1 --single-branch --branch "$BRANCH" "$REPOSITORY" "$INSTALL_DIR"
fi

if [[ ${NOVA_CONFIRM_INSTALL:-} == YES ]]; then
  :
elif [[ -t 0 ]]; then
  read -r -p "The repository is cloned at $INSTALL_DIR. Review scripts/install-vps.sh, then type INSTALL to continue: " CONFIRM
  [[ "$CONFIRM" == INSTALL ]] || { echo 'Installation cancelled.' >&2; exit 1; }
else
  echo 'Non-interactive root install requires NOVA_CONFIRM_INSTALL=YES after reviewing the cloned installer.' >&2
  exit 2
fi

exec bash "$INSTALL_DIR/scripts/install-vps.sh" --install-dir "$INSTALL_DIR"
