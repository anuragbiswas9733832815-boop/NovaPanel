# Nova Hosting

Nova is an independent hosting control plane. It does not install, embed, wrap, or call another hosting panel. It owns the panel source, API, database schema, job dispatcher, node protocol, and Go node agent.

## What works now

This checkout has an end-to-end **static-site hosting slice**:

- Next.js 16 dashboard with a resumable first-run initializer, forced initial password rotation, live Local Node/agent setup progress, node enrollment, website provisioning, and a tenant-scoped file manager. Fresh installs initialize `admin` / `admin` exactly once; existing users are never reset.
- Fastify 5 REST API using PostgreSQL and Prisma 7. Passwords are Argon2-hashed; sessions use signed HttpOnly/SameSite cookies. Protected requests reload the user role from the database, and non-admin website/file queries are owner-scoped.
- An encrypted-at-rest per-node HMAC key, one-time admin node enrollment, signed heartbeats with persisted replay nonces, and host CPU/memory/disk/network telemetry.
- A PostgreSQL-backed durable website job queue with idempotency keys, leases, retries/backoff, stale-node detection, least-active-site placement, and audit events.
- An independent Go 1.24 Linux agent. It accepts only an allowlist of signed HTTPS operations, confines customer file paths under per-site document roots, and provisions/deletes **static** sites using generated Nginx virtual hosts. It does not expose shell commands. Agent process execution is limited to fixed `nginx -t` and `systemctl reload nginx` arguments.
- Debian/Ubuntu-style systemd service and preflight installer for an already-built agent binary. The agent denies PHP script execution; PHP, app runtimes, ACME/SSL, and customer Linux-user isolation are not implemented yet.

The dashboard does not fabricate live data. Modules without real service implementations remain marked unavailable.

## Debian/Ubuntu VPS installer

The root-level `installer.sh` clones this GitHub repository (default branch `main`), then provisions PostgreSQL, Node.js 22+, a checksum-verified Go toolchain, Nginx, Certbot, the API/web systemd services, TLS, database migrations, the one-time initial admin, and the Local Node agent. It is designed for a clean Debian/Ubuntu systemd VPS; it does not use or install another hosting panel.

First point a public DNS A/AAAA record at the VPS and allow TCP 80, 443 and 8443 in the provider firewall. Review the script before running it with root privileges:

```sh
curl -fsSL https://raw.githubusercontent.com/anuragbiswas9733832815-boop/NovaPanel/main/installer.sh -o installer.sh
less installer.sh
sudo bash installer.sh                  # prompts for domain and ACME email
# Non-interactive alternative:
sudo env NOVA_DOMAIN=panel.example.com NOVA_EMAIL=ops@example.com NOVA_CONFIRM_INSTALL=YES bash installer.sh
```

The installer does not enable UFW automatically (to avoid locking out a VPS on a nonstandard SSH port). If UFW is already active it allows SSH, 80, 443 and 8443. It binds PostgreSQL to its local default and panel processes to loopback; do not expose ports 3000, 4000 or 5432. A failed step can be retried by rerunning the installer; it preserves panel keys and existing accounts, and never resets the initial admin. It intentionally uses the required initial `admin` / `admin` password, so log in over HTTPS and change it immediately. Keep `/etc/nova-panel/api.env` and `/etc/nova-agent/agent.env` backed up securely.

Requirements/limitations: a supported Debian/Ubuntu x86_64 or arm64 VPS, working systemd and apt, public DNS already resolving, outbound HTTPS for package/toolchain downloads, and an ACME-reachable TCP 80. Certbot/TLS issuance will stop and report an error if DNS/firewall/IPv6 routing is wrong. Review systemd/Nginx settings and your VPS firewall before production use; no installer can verify the provider firewall or DNS ownership for you.

## Local control-plane development

Requirements: Node.js 22+, npm, Docker Compose (or an existing PostgreSQL 16 server), and access to Prisma’s engine download host for client generation/migrations.

```sh
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
# Set POSTGRES_PASSWORD and keep DATABASE_URL's password in sync. The sample DB binds to loopback.
docker compose up -d postgres
npm install
npm run dev
```

The API `predev` hook creates durable random `JWT_SECRET` and `NODE_ENCRYPTION_KEY` values in `apps/api/.env` (mode 0600), then deploys pending Prisma migrations before starting. Production `npm run start:api` also applies pending migrations before launching Fastify. Keep a secure backup of that env file; losing the encryption key makes existing node credentials unrecoverable. The PostgreSQL server/database itself must exist and `DATABASE_URL` must reach it; schema migration is automatic but database-server installation/creation is not.

Open `http://localhost:3000`. The first-run screen initializes the first Super Administrator as `admin` / `admin` exactly once, immediately forces a strong password change, and records the control-plane host as the unique Local Node. After rotating the password, the dashboard can issue a one-time agent key. The Go agent still requires an operator to build/review and install it with root/systemd privileges, configure its TLS certificate, Nginx/Certbot prerequisites and `NOVA_CONTROL_URL`, and open required firewall routes; the wizard waits for a signed agent heartbeat and detected inventory instead of claiming those privileged steps succeeded. Rotating the displayed key invalidates the previous key.

For production, use `NODE_ENV=production`, HTTPS at a trusted reverse proxy, an exact `PANEL_ORIGIN`, a managed database, and backed-up secrets stored outside the source checkout. Set `TRUSTED_PROXY_ADDRESSES` only to real trusted proxy addresses/CIDRs, configure the proxy to overwrite forwarded headers, and replace development PostgreSQL credentials. The default bootstrap password is deliberately fixed by the requested behavior and must be changed before normal panel use; do not expose a fresh install to untrusted networks before initialization.

## Build and install a hosting node

The agent targets Linux and Go 1.24. It requires systemd, Nginx, OpenSSL, Certbot at `/usr/bin/certbot`, an Nginx main configuration that includes `/etc/nginx/sites-enabled/*`, and a public/trusted TLS certificate whose SAN matches the agent hostname. Website certificates use HTTP-01 validation; public DNS must resolve to the node and inbound TCP port 80 must be reachable. The installer sets up a twice-daily renewal timer and a deploy hook that validates/reloads Nginx and restarts the agent so it reloads its renewed TLS certificate.

```sh
cd apps/agent
go test ./...
go build -trimpath -buildvcs=false -ldflags='-s -w' -o bin/nova-agent .
```

1. The API startup hook creates and persists `NODE_ENCRYPTION_KEY`; keep its `apps/api/.env` backup safe. For the initial Local Node, use the dashboard installation panel to set its trusted HTTPS agent URL and issue a one-time bootstrap. For other machines, log in as an administrator.
2. In **Servers → Register node**, enter the remote node hostname and `https://<node-hostname>:8443`. Copy the one-time `NOVA_NODE_ID` and `NOVA_SHARED_SECRET` bootstrap values; the secret is not displayed again.
3. On the Linux node, create a root-owned TLS key/certificate and an environment file with mode `0600`, for example:

   ```ini
   NOVA_NODE_ID=<issued-node-id>
   NOVA_SHARED_SECRET=<issued-base64-secret>
   NOVA_CONTROL_URL=https://panel.example.com
   NOVA_TLS_CERT=/etc/letsencrypt/live/agent.example.com/fullchain.pem
   NOVA_TLS_KEY=/etc/letsencrypt/live/agent.example.com/privkey.pem
   NOVA_SITE_ROOT=/srv/nova/sites
   NOVA_ACME_EMAIL=ops@example.com
   NOVA_ACME_STAGING=false
   ```

   Point `NOVA_CONTROL_URL` at the HTTPS origin whose `/api/agent/nodes/.../heartbeat` route reaches the Fastify API. Configure network/firewall policy so port 8443 is reachable only from the control plane where practical; do not expose it without TLS.
4. Copy the locally reviewed binary and `apps/agent/deploy/` to the node and run:

   ```sh
   chmod 600 /root/nova-agent.env
   sudo apps/agent/deploy/install-agent.sh ./nova-agent /root/nova-agent.env
   ```

   The installer checks prerequisites and `nginx -t` before changing the host, installs a hardened systemd unit, and starts the service. It does not install Nginx or fetch/execute remote code. The agent runs as root because Nginx config and service reloads are privileged; access is constrained by HMAC authentication, timestamp/nonce replay checks, the typed operation allowlist, fixed command arguments, systemd filesystem/capability restrictions, and Go `os.Root` path confinement. Review the unit and systemd sandbox against your distribution before production use.
5. Point a domain’s DNS A/AAAA record at the node, then create a **Static HTML** website in the panel. Provisioning creates a managed Nginx vhost on port 80 and a starter index page. Upload site files from **Files**. PHP files are deliberately served as 404 rather than executed or disclosed.
6. After the domain resolves publicly and inbound port 80 reaches the node, select **Enable** under HTTPS. A queued agent operation requests a Let’s Encrypt certificate using the fixed Certbot webroot flow, atomically switches the managed vhost to HTTPS, and redirects ordinary HTTP requests. `NOVA_ACME_STAGING=true` can be used for ACME staging tests; those certificates are not browser-trusted. Verify a production certificate with `curl -I https://your-domain.example` and check renew scheduling with `systemctl list-timers nova-certbot-renew.timer`; run `sudo /usr/bin/certbot renew --dry-run` before relying on automatic renewal.

The node and panel clocks must be synchronized; signed requests expire after 30 seconds. The HMAC secret is encrypted in PostgreSQL using `NODE_ENCRYPTION_KEY`; losing that key makes existing node credentials unrecoverable. Rotate it only with a planned re-enrollment/re-encryption procedure.

## API surface

- `GET /api/health` — API and PostgreSQL health.
- `GET /api/auth/setup-status`, `POST /api/install/initialize`, `GET /api/install/status`, `POST /api/install/local-node`, `PUT /api/install/local-agent-url`, `POST /api/install/local-agent-bootstrap`, loopback/token-protected `POST /api/install/installer-agent-bootstrap`, `/api/auth/login`, `/api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password` — one-time fresh-install bootstrap, resumable Local Node/agent progress, authenticated bootstrap-key issue/rotation, sessions, and forced password rotation. The installer-only bootstrap capability is bound to a root-owned token and loopback API access; the Nginx configuration blocks remote access to the public initialization endpoint. The legacy `/api/auth/setup` endpoint returns `410`; it cannot create or reset accounts.
- `GET/POST /api/customers`, `PATCH /api/customers/:id/status`, `POST /api/customers/:id/reset-password` — admin-only customer account management. Create/reset returns a random temporary password once; customers must change it before using protected panel features. Admins can set a per-account website-count quota (default 5); website creation checks the quota transactionally. Password changes invalidate older sessions.
- `GET /api/overview`, `GET/POST /api/websites`, `DELETE /api/websites/:id`, `POST /api/websites/:id/ssl` — tenant-aware static-site provisioning, deletion, and queued HTTPS issuance.
- `GET/POST /api/nodes` — admin-only node enrollment/inventory. The POST response contains the node secret once.
- `POST /api/agent/nodes/:id/heartbeat` — signed telemetry with body, path, method, timestamp, nonce, and HMAC validation.
- `GET/POST /api/websites/:id/files` — tenant-scoped, active-site file list/read/write/mkdir/delete/rename, forwarded over signed HTTPS to the correct agent.
- `GET /api/jobs?limit=30&status=QUEUED` — tenant-scoped, bounded job history. The dashboard shows operation state and attempt counts without exposing internal node error details.
- `GET /api/activity?limit=50&action=website.provisioned` — admin-only bounded audit feed; sensitive request metadata and IP addresses are excluded from the response.

The job worker uses PostgreSQL leases and retries, not Redis/BullMQ yet. Node choice currently uses least active/pending website count among fresh heartbeats; CPU/RAM/disk capacity weighting is not implemented.

## Tests and remaining scope

```sh
npm test                         # API validation, session policy, encryption, and HMAC tests
npm --workspace @nova/web run typecheck
npm --workspace @nova/web run build
npm audit
(cd apps/agent && go test ./...) # Must run in a Go 1.24 environment
```

This is meaningful infrastructure, **not yet a complete production hosting product**. The agent/installer and Nginx operations still require real Linux integration tests before production deployment. Not implemented: PHP-FPM, Node/Python runtimes, DNS/PowerDNS and DNS-01/wildcard certificates, databases, email, FTP/SFTP, WordPress, backups, disk quotas/cgroups, malware/security integrations, billing/payments, resellers, support, plugin execution, AI assistance, Redis jobs, multi-node recovery/migration, MFA, and full customer/admin permission management. No operation for these systems is exposed as a fake API feature.
