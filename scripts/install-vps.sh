#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_DIR=/opt/nova-panel
while (($#)); do
  case "$1" in
    --install-dir) [[ $# -ge 2 ]] || { echo 'Missing value for --install-dir' >&2; exit 2; }; INSTALL_DIR=$2; shift 2 ;;
    *) echo "Unknown installer argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ! "$INSTALL_DIR" =~ ^/[^[:space:]]+$ || "$INSTALL_DIR" == *..* ]]; then echo 'Installation directory must be an absolute path without spaces or parent traversal.' >&2; exit 2; fi
if [[ ${EUID} -ne 0 ]]; then echo 'Run this script as root.' >&2; exit 1; fi
[[ -f "$INSTALL_DIR/package.json" && -f "$INSTALL_DIR/apps/agent/go.mod" ]] || { echo "NovaPanel source is not present in $INSTALL_DIR." >&2; exit 1; }

if [[ ! -r /etc/os-release ]]; then echo 'Cannot identify this Linux distribution.' >&2; exit 1; fi
. /etc/os-release
if [[ "$ID" != ubuntu && "$ID" != debian ]]; then echo "Unsupported distribution: $ID (supported: Debian/Ubuntu with systemd)." >&2; exit 1; fi
if ! command -v systemctl >/dev/null || ! command -v apt-get >/dev/null; then echo 'systemd and apt are required.' >&2; exit 1; fi

NOVA_DOMAIN_INPUT=${NOVA_DOMAIN:-}
NOVA_EMAIL_INPUT=${NOVA_EMAIL:-}
if [[ -t 0 ]]; then
  [[ -n "$NOVA_DOMAIN_INPUT" ]] || read -r -p 'Panel DNS name (A/AAAA records must point to this VPS): ' NOVA_DOMAIN_INPUT
  [[ -n "$NOVA_EMAIL_INPUT" ]] || read -r -p 'ACME certificate email: ' NOVA_EMAIL_INPUT
fi
DOMAIN=$NOVA_DOMAIN_INPUT
EMAIL=$NOVA_EMAIL_INPUT
DOMAIN=${DOMAIN,,}
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || { echo 'Set NOVA_DOMAIN to a valid public fully qualified domain name.' >&2; exit 2; }
[[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] || { echo 'Set NOVA_EMAIL to a valid ACME contact email.' >&2; exit 2; }
if ! getent ahosts "$DOMAIN" >/dev/null; then echo "$DOMAIN does not resolve yet. Configure public DNS and retry." >&2; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git jq xz-utils build-essential nginx certbot python3-certbot-nginx postgresql postgresql-contrib openssl
systemctl enable --now postgresql nginx

# Do not silently enable UFW on a remote host (which can lock out nonstandard SSH ports).
# If the operator already enabled UFW, allow the panel and node-agent ports.
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow OpenSSH || true
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 8443/tcp
fi

TOOLCHAIN_DIR=/opt/nova-toolchains
install -d -o root -g root -m 0755 "$TOOLCHAIN_DIR"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) NODE_ARCH=x64; GO_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; GO_ARCH=arm64 ;;
  *) echo "Unsupported CPU architecture: $ARCH (supported: x86_64 and aarch64)." >&2; exit 1 ;;
esac

NODE_BIN_DIR=''
EXISTING_NODE=$(command -v node 2>/dev/null || true)
if [[ -n "$EXISTING_NODE" && "$EXISTING_NODE" != /root/* && "$EXISTING_NODE" != /home/* ]] && [[ $(node -p 'Number(process.versions.node.split(".")[0])') -ge 22 ]] && command -v npm >/dev/null 2>&1; then
  NODE_BIN_DIR=$(dirname "$EXISTING_NODE")
else
  NODE_INDEX=$(curl --fail --silent --show-error https://nodejs.org/dist/index.json)
  NODE_VERSION=$(printf '%s' "$NODE_INDEX" | jq -r '[.[] | select(.version | startswith("v22."))][0].version // empty')
  [[ -n "$NODE_VERSION" ]] || { echo 'Could not locate an official Node.js 22 release.' >&2; exit 1; }
  NODE_ARCHIVE="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  NODE_TMP=$(mktemp -d)
  trap 'rm -rf "${NODE_TMP:-}"' EXIT
  curl --fail --silent --show-error "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}" -o "$NODE_TMP/$NODE_ARCHIVE"
  curl --fail --silent --show-error "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" -o "$NODE_TMP/SHASUMS256.txt"
  NODE_SHA=$(awk -v name="$NODE_ARCHIVE" '$2 == name { print $1 }' "$NODE_TMP/SHASUMS256.txt")
  [[ "$NODE_SHA" =~ ^[a-f0-9]{64}$ ]] || { echo 'The Node.js checksum list did not contain the downloaded archive.' >&2; exit 1; }
  echo "$NODE_SHA  $NODE_TMP/$NODE_ARCHIVE" | sha256sum --check --status || { echo 'Node.js archive checksum verification failed.' >&2; exit 1; }
  tar -xJf "$NODE_TMP/$NODE_ARCHIVE" -C "$NODE_TMP"
  NODE_HOME="$TOOLCHAIN_DIR/node-${NODE_VERSION}"
  if [[ ! -d "$NODE_HOME" ]]; then mv "$NODE_TMP/node-${NODE_VERSION}" "$NODE_HOME"; fi
  NODE_BIN_DIR="$NODE_HOME/bin"
  rm -rf "$NODE_TMP"
  trap - EXIT
fi
export PATH="$NODE_BIN_DIR:$PATH"
node --version | grep -Eq '^v(22|2[3-9]|[3-9][0-9])\.' || { echo 'Node.js 22 or later is required.' >&2; exit 1; }
npm --version >/dev/null

GO_BIN=''
if command -v go >/dev/null 2>&1; then
  GO_CURRENT=$(go version | awk '{print $3}' | sed 's/^go//')
  if [[ $(printf '%s\n' '1.24.0' "$GO_CURRENT" | sort -V | head -n1) == '1.24.0' ]]; then GO_BIN=$(command -v go); fi
fi
if [[ -z "$GO_BIN" ]]; then
  GO_INDEX=$(curl --fail --silent --show-error 'https://go.dev/dl/?mode=json')
  GO_VERSION=$(printf '%s' "$GO_INDEX" | jq -r '.[0].version // empty')
  GO_ARCHIVE="${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
  GO_SHA=$(printf '%s' "$GO_INDEX" | jq -r --arg version "$GO_VERSION" --arg arch "$GO_ARCH" '.[] | select(.version == $version) | .files[] | select(.os == "linux" and .arch == $arch and .kind == "archive") | .sha256' | head -n1)
  [[ "$GO_VERSION" =~ ^go[0-9]+\.[0-9]+(\.[0-9]+)?$ && "$GO_SHA" =~ ^[a-f0-9]{64}$ ]] || { echo 'Could not find a checksum-verified official Go toolchain.' >&2; exit 1; }
  GO_TMP=$(mktemp -d)
  trap 'rm -rf "${GO_TMP:-}"' EXIT
  curl --fail --silent --show-error "https://go.dev/dl/${GO_ARCHIVE}" -o "$GO_TMP/$GO_ARCHIVE"
  echo "$GO_SHA  $GO_TMP/$GO_ARCHIVE" | sha256sum --check --status || { echo 'Go archive checksum verification failed.' >&2; exit 1; }
  tar -xzf "$GO_TMP/$GO_ARCHIVE" -C "$GO_TMP"
  GO_HOME="$TOOLCHAIN_DIR/${GO_VERSION}"
  if [[ ! -d "$GO_HOME" ]]; then mv "$GO_TMP/go" "$GO_HOME"; else rm -rf "$GO_TMP/go"; fi
  GO_BIN="$GO_HOME/bin/go"
  rm -rf "$GO_TMP"
  trap - EXIT
fi
export PATH="$(dirname "$GO_BIN"):$PATH"

if ! id nova-api >/dev/null 2>&1; then useradd --system --home-dir /var/lib/nova-api --create-home --shell /usr/sbin/nologin nova-api; fi
if ! id nova-web >/dev/null 2>&1; then useradd --system --home-dir /var/lib/nova-web --create-home --shell /usr/sbin/nologin nova-web; fi
install -d -o root -g nova-api -m 0750 /etc/nova-panel
install -d -o nova-api -g nova-api -m 0750 /var/lib/nova-api
install -d -o nova-web -g nova-web -m 0750 /var/lib/nova-web
install -d -o root -g root -m 0755 /srv/nova/sites

API_ENV=/etc/nova-panel/api.env
get_env() {
  local key=$1
  [[ -f "$API_ENV" ]] || return 0
  sed -n "s/^${key}=//p" "$API_ENV" | tail -n1 | sed -E 's/^"(.*)"$/\1/'
}
DB_PASSWORD=$(get_env NOVA_DB_PASSWORD)
JWT_SECRET=$(get_env JWT_SECRET)
NODE_ENCRYPTION_KEY=$(get_env NODE_ENCRYPTION_KEY)
NOVA_INSTALLER_TOKEN=$(get_env NOVA_INSTALLER_TOKEN)
[[ "$DB_PASSWORD" =~ ^[a-f0-9]{64}$ ]] || DB_PASSWORD=$(openssl rand -hex 32)
[[ ${#JWT_SECRET} -ge 32 ]] || JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
if [[ $(printf '%s' "$NODE_ENCRYPTION_KEY" | base64 -d 2>/dev/null | wc -c) -ne 32 ]]; then NODE_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n'); fi
[[ ${#NOVA_INSTALLER_TOKEN} -ge 32 ]] || NOVA_INSTALLER_TOKEN=$(openssl rand -hex 48)

DB_USER=nova_panel
DB_NAME=nova_panel
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}?schema=public"
PANEL_ORIGIN="https://${DOMAIN}"
LOCAL_AGENT_URL="https://${DOMAIN}:8443"
cat > "$API_ENV" <<EOF
DATABASE_URL="$DATABASE_URL"
NOVA_DB_PASSWORD="$DB_PASSWORD"
JWT_SECRET="$JWT_SECRET"
NODE_ENCRYPTION_KEY="$NODE_ENCRYPTION_KEY"
NOVA_INSTALLER_TOKEN="$NOVA_INSTALLER_TOKEN"
NOVA_ENV_FILE="$API_ENV"
PANEL_ORIGIN="$PANEL_ORIGIN"
NOVA_CONTROL_URL="$PANEL_ORIGIN"
LOCAL_AGENT_URL="$LOCAL_AGENT_URL"
NODE_ENV=production
HOST=127.0.0.1
PORT=4000
TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1
EOF
chown root:nova-api "$API_ENV"
chmod 0640 "$API_ENV"

runuser -u postgres -- psql -v ON_ERROR_STOP=1 -v db_user="$DB_USER" -v db_password="$DB_PASSWORD" -v db_name="$DB_NAME" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'db_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'db_user', :'db_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'db_user') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SQL
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "ALTER SCHEMA public OWNER TO ${DB_USER}; GRANT ALL ON SCHEMA public TO ${DB_USER};"

# The source tree and compiled artifacts are root-owned/read-only to the service user.
chown -R root:root "$INSTALL_DIR"
chmod 0755 "$INSTALL_DIR"
export DATABASE_URL JWT_SECRET NODE_ENCRYPTION_KEY NOVA_INSTALLER_TOKEN
export NOVA_ENV_FILE="$API_ENV" PANEL_ORIGIN NOVA_CONTROL_URL LOCAL_AGENT_URL
export NODE_ENV=production HOST=127.0.0.1 PORT=4000 TRUSTED_PROXY_ADDRESSES=127.0.0.1,::1
export PATH="$NODE_BIN_DIR:$PATH"
export NEXT_TELEMETRY_DISABLED=1
cd "$INSTALL_DIR"
npm ci --include=dev
npm run build
install -d -o nova-web -g nova-web -m 0750 "$INSTALL_DIR/apps/web/.next/cache"

NGINX_SITE="/etc/nginx/sites-available/nova-panel-${DOMAIN}"
NGINX_ENABLED="/etc/nginx/sites-enabled/nova-panel-${DOMAIN}"
cat > "$NGINX_SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    client_max_body_size 14m;
    location = /api/install/initialize { return 404; }
    location = /api/install/installer-agent-bootstrap { return 404; }
    location / { proxy_pass http://127.0.0.1:3000; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 300s; }
}
EOF
ln -sfn "$NGINX_SITE" "$NGINX_ENABLED"
nginx -t
systemctl reload nginx
certbot certonly --non-interactive --agree-tos --email "$EMAIL" --nginx -d "$DOMAIN"

cat > "$NGINX_SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};
    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 14m;
    location = /api/install/initialize { return 404; }
    location = /api/install/installer-agent-bootstrap { return 404; }
    location / { proxy_pass http://127.0.0.1:3000; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 300s; }
}
EOF
nginx -t
systemctl reload nginx

# The API applies all Prisma migrations before listening. It runs as an unprivileged account.
cat > /etc/systemd/system/nova-api.service <<EOF
[Unit]
Description=Nova Hosting API
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service

[Service]
Type=simple
User=nova-api
Group=nova-api
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${API_ENV}
Environment=HOME=/var/lib/nova-api
Environment=PATH=${NODE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=NOVA_ENV_FILE=${API_ENV}
ExecStart=${NODE_BIN_DIR}/npm run start:api
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${INSTALL_DIR}
ReadWritePaths=${INSTALL_DIR}/apps/web/.next/cache

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/nova-web.service <<EOF
[Unit]
Description=Nova Hosting Web Dashboard
After=network-online.target nova-api.service
Wants=network-online.target

[Service]
Type=simple
User=nova-web
Group=nova-web
WorkingDirectory=${INSTALL_DIR}
Environment=HOME=/var/lib/nova-web
Environment=NODE_ENV=production
Environment=API_INTERNAL_URL=http://127.0.0.1:4000
Environment=NEXT_TELEMETRY_DISABLED=1
Environment=PATH=${NODE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${NODE_BIN_DIR}/npm --workspace @nova/web start
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${INSTALL_DIR}
ReadWritePaths=${INSTALL_DIR}/apps/web/.next/cache

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now nova-api.service nova-web.service

ready=false
for _ in $(seq 1 60); do
  if curl --silent --fail http://127.0.0.1:4000/api/health | jq -e '.database == "connected" and .schema == "ready"' >/dev/null; then ready=true; break; fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  journalctl -u nova-api.service -n 80 --no-pager >&2 || true
  echo 'The API/database did not become ready. Correct the error and rerun this idempotent installer.' >&2
  exit 1
fi

# Create the mandated one-time admin only on an empty database; 409 on an existing
# installation is expected and never resets or recreates an existing administrator.
INIT_CODE=$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
  -X POST http://127.0.0.1:4000/api/install/initialize \
  -H 'Content-Type: application/json' -d '{}')
if [[ "$INIT_CODE" != 201 && "$INIT_CODE" != 409 ]]; then
  echo "Initial installation request failed with HTTP $INIT_CODE." >&2
  exit 1
fi

# This root-only capability is accepted by the API only over loopback. It rotates
# the Local Node HMAC key on retries so the agent env file and encrypted DB key stay in sync.
BOOTSTRAP_RESPONSE=$(curl --silent --show-error --fail \
  -X POST http://127.0.0.1:4000/api/install/installer-agent-bootstrap \
  -H "X-Nova-Installer-Token: $NOVA_INSTALLER_TOKEN" -H 'Content-Type: application/json' -d '{}')
NODE_ID=$(printf '%s' "$BOOTSTRAP_RESPONSE" | jq -er '.bootstrap.nodeId')
SHARED_SECRET=$(printf '%s' "$BOOTSTRAP_RESPONSE" | jq -er '.bootstrap.sharedSecret')
[[ "$NODE_ID" =~ ^[A-Za-z0-9_-]{1,64}$ && $(printf '%s' "$SHARED_SECRET" | base64 -d 2>/dev/null | wc -c) -ge 32 ]] || { echo 'The installer received invalid node credentials.' >&2; exit 1; }

AGENT_ENV=/etc/nova-agent/agent.env
install -d -o root -g root -m 0755 /etc/nova-agent
cat > "$AGENT_ENV" <<EOF
NOVA_NODE_ID=${NODE_ID}
NOVA_SHARED_SECRET=${SHARED_SECRET}
NOVA_CONTROL_URL=${PANEL_ORIGIN}
NOVA_TLS_CERT=/etc/letsencrypt/live/${DOMAIN}/fullchain.pem
NOVA_TLS_KEY=/etc/letsencrypt/live/${DOMAIN}/privkey.pem
NOVA_SITE_ROOT=/srv/nova/sites
NOVA_ACME_EMAIL=${EMAIL}
NOVA_ACME_STAGING=false
EOF
chown root:root "$AGENT_ENV"
chmod 0600 "$AGENT_ENV"

AGENT_TMP=$(mktemp)
trap 'rm -f "${AGENT_TMP:-}"' EXIT
(cd "$INSTALL_DIR/apps/agent" && GOOS=linux GOARCH="$GO_ARCH" "$GO_BIN" build -trimpath -buildvcs=false -ldflags='-s -w' -o "$AGENT_TMP" .)
install -o root -g root -m 0755 "$AGENT_TMP" /usr/local/sbin/nova-agent
rm -f "$AGENT_TMP"
trap - EXIT
"$INSTALL_DIR/apps/agent/deploy/install-agent.sh" /usr/local/sbin/nova-agent "$AGENT_ENV"

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: inactive'; then
  echo 'UFW is inactive; configure your VPS provider firewall to allow TCP 80, 443, and 8443 (and preserve your SSH port).' >&2
fi

cat <<EOF

Nova Hosting installation is up.
Panel: https://${DOMAIN}
Initial administrator: username admin / password admin
The first login requires an immediate password change. The password is never reset on reruns.
Local Node agent: systemd service installed; wait for its authenticated heartbeat/inventory in the dashboard.

Keep /etc/nova-panel/api.env (root:nova-api, 0640) and /etc/nova-agent/agent.env (root-only, 0600) backed up securely.
This installer configures PostgreSQL, Node.js, Go, Nginx, Certbot, the API/web services, migrations, TLS, and the Local Node agent. Review your provider firewall; only ports 80, 443, and 8443 need public access. Never expose 3000, 4000, or 5432.
EOF
