#!/usr/bin/env bash
set -euo pipefail

# Installs a locally built, reviewed Nova agent. This script does not install a panel,
# fetch executable code, or change the node until all prerequisites have been checked.
if [[ ${EUID} -ne 0 ]]; then echo 'Run as root.' >&2; exit 1; fi
if [[ $# -ne 2 ]]; then echo "Usage: $0 /path/to/nova-agent /path/to/agent.env" >&2; exit 2; fi
BINARY=$(realpath "$1")
ENV_SOURCE=$(realpath "$2")
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

[[ -f "$BINARY" && -x "$BINARY" ]] || { echo 'Agent binary must be a regular executable file.' >&2; exit 1; }
[[ -f "$ENV_SOURCE" && ! -L "$ENV_SOURCE" ]] || { echo 'Environment file must be a regular, non-symlink file.' >&2; exit 1; }
[[ $(stat -c '%u' "$ENV_SOURCE") -eq 0 ]] || { echo 'Environment file must be owned by root.' >&2; exit 1; }
PERMS=$(stat -c '%a' "$ENV_SOURCE")
(( (8#$PERMS & 077) == 0 )) || { echo 'Environment file permissions must not grant group/other access (use chmod 600).' >&2; exit 1; }
command -v systemctl >/dev/null || { echo 'systemd is required.' >&2; exit 1; }
command -v nginx >/dev/null || { echo 'Nginx must be installed and configured before agent installation.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'OpenSSL is required to validate the agent TLS certificate.' >&2; exit 1; }
[[ -x /usr/bin/certbot ]] || { echo 'Install the distribution Certbot package at /usr/bin/certbot before installing the Nova agent.' >&2; exit 1; }
nginx -t

value() { sed -n "s/^$1=//p" "$ENV_SOURCE" | tail -n 1 | tr -d '"'; }
for key in NOVA_NODE_ID NOVA_SHARED_SECRET NOVA_CONTROL_URL NOVA_TLS_CERT NOVA_TLS_KEY NOVA_ACME_EMAIL; do
  grep -q "^${key}=" "$ENV_SOURCE" || { echo "Missing $key in environment file." >&2; exit 1; }
done
CERT=$(value NOVA_TLS_CERT)
KEY=$(value NOVA_TLS_KEY)
SECRET=$(value NOVA_SHARED_SECRET)
SITE_ROOT=$(value NOVA_SITE_ROOT)
NGINX_AVAILABLE=$(value NOVA_NGINX_AVAILABLE)
NGINX_ENABLED=$(value NOVA_NGINX_ENABLED)
[[ -z "$SITE_ROOT" || "$SITE_ROOT" == "/srv/nova/sites" ]] || { echo 'This systemd unit is sandboxed for NOVA_SITE_ROOT=/srv/nova/sites; customize the unit explicitly before using another path.' >&2; exit 1; }
[[ -z "$NGINX_AVAILABLE" || "$NGINX_AVAILABLE" == "/etc/nginx/sites-available" ]] || { echo 'Customize the systemd sandbox before changing NOVA_NGINX_AVAILABLE.' >&2; exit 1; }
[[ -z "$NGINX_ENABLED" || "$NGINX_ENABLED" == "/etc/nginx/sites-enabled" ]] || { echo 'Customize the systemd sandbox before changing NOVA_NGINX_ENABLED.' >&2; exit 1; }
grep -Eq 'include[[:space:]]+/etc/nginx/sites-enabled/[*]' /etc/nginx/nginx.conf || { echo 'Nginx main config must include /etc/nginx/sites-enabled/*.' >&2; exit 1; }
[[ -r "$CERT" && -r "$KEY" ]] || { echo 'Agent TLS certificate/key paths must exist and be readable by root.' >&2; exit 1; }
DECODED_SECRET_BYTES=$(printf '%s' "$SECRET" | base64 --decode 2>/dev/null | wc -c)
[[ "$DECODED_SECRET_BYTES" -ge 32 ]] || { echo 'Shared secret must decode to at least 32 bytes.' >&2; exit 1; }
grep -Eq '^NOVA_CONTROL_URL=https://[^[:space:]]+$' "$ENV_SOURCE" || { echo 'NOVA_CONTROL_URL must use HTTPS.' >&2; exit 1; }
grep -Eq '^NOVA_ACME_EMAIL=[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}$' "$ENV_SOURCE" || { echo 'NOVA_ACME_EMAIL must be a valid, unquoted email address.' >&2; exit 1; }
STAGING=$(value NOVA_ACME_STAGING)
[[ -z "$STAGING" || "$STAGING" == "true" || "$STAGING" == "false" ]] || { echo 'NOVA_ACME_STAGING must be true or false.' >&2; exit 1; }
openssl x509 -in "$CERT" -noout -checkend 86400 >/dev/null || { echo 'Agent TLS certificate is invalid or expires within 24 hours.' >&2; exit 1; }

install -d -o root -g root -m 0755 /etc/nova-agent /srv/nova/sites /etc/nginx/sites-available /etc/nginx/sites-enabled /var/log/nginx /etc/letsencrypt/renewal-hooks/deploy /var/lib/letsencrypt /var/log/letsencrypt
install -o root -g root -m 0755 "$BINARY" /usr/local/sbin/nova-agent
install -o root -g root -m 0600 "$ENV_SOURCE" /etc/nova-agent/agent.env
install -o root -g root -m 0644 "$HERE/nova-agent.service" /etc/systemd/system/nova-agent.service
install -o root -g root -m 0644 "$HERE/nova-certbot-renew.service" /etc/systemd/system/nova-certbot-renew.service
install -o root -g root -m 0644 "$HERE/nova-certbot-renew.timer" /etc/systemd/system/nova-certbot-renew.timer
install -o root -g root -m 0755 "$HERE/nova-certbot-deploy-hook.sh" /etc/letsencrypt/renewal-hooks/deploy/50-nova-nginx-reload
systemctl daemon-reload
systemctl enable --now nova-agent.service nova-certbot-renew.timer
systemctl --no-pager --full status nova-agent.service
