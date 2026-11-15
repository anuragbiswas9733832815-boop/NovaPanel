import 'dotenv/config';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname as systemHostname, platform as systemPlatform, release as systemRelease, arch as systemArch, cpus as systemCpus, networkInterfaces } from 'node:os';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient, type Role } from './generated/prisma/client.js';
import argon2 from 'argon2';
import { activityQuery, customerInput, customerStatusInput, fileMutationInput, fileReadQuery, heartbeatInput, jobListQuery, loginInput, localAgentUrlInput, nodeRegistrationInput, passwordChangeInput, websiteInput } from './validation.js';
import { decryptNodeSecret, encryptNodeSecret, verifyAgentRequest } from './agent-auth.js';
import { startProvisioningWorker } from './provisioning-worker.js';
import { sessionAccessBlockReason } from './session-policy.js';
import { callAgent } from './agent-client.js';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';
const panelOrigin = process.env.PANEL_ORIGIN ?? 'http://localhost:3000';
const publicControlUrl = (() => {
  for (const candidate of [process.env.NOVA_CONTROL_URL, panelOrigin]) {
    if (!candidate?.trim()) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '')) return url.origin;
    } catch { /* ignore malformed candidate and try the configured panel origin */ }
  }
  return null;
})();
const trustedProxyAddresses = (process.env.TRUSTED_PROXY_ADDRESSES ?? '').split(',').map((ip) => ip.trim()).filter(Boolean);
const app = Fastify({ logger: true, trustProxy: trustedProxyAddresses.length ? trustedProxyAddresses : false, bodyLimit: 64 * 1024 });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const jwtSecret = process.env.JWT_SECRET ?? '';
const encryptionKey = Buffer.from(process.env.NODE_ENCRYPTION_KEY ?? '', 'base64');

if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters.');
if (encryptionKey.length !== 32) throw new Error('NODE_ENCRYPTION_KEY must be a persistent base64-encoded 32-byte key.');

await app.register(cors, { origin: panelOrigin, credentials: true });
await app.register(cookie);
await app.register(jwt, { secret: jwtSecret, cookie: { cookieName: 'nova_session', signed: false } });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
app.addHook('onSend', async (request, reply, payload) => {
  if (request.url.startsWith('/api/')) {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
  }
  return payload;
});

const safeUser = (user: { id: string; email: string; username: string | null; name: string; role: Role; mustChangePassword: boolean }) => ({ id: user.id, email: user.email, username: user.username, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword });
type Session = { sub: string; role: Role; email: string; name: string; sessionVersion: number; websiteLimit: number };

function isLocalInstallerRequest(request: FastifyRequest): boolean {
  const token = process.env.NOVA_INSTALLER_TOKEN;
  const provided = request.headers['x-nova-installer-token'];
  const remoteAddress = request.raw.socket.remoteAddress?.toLowerCase();
  const effectiveAddress = request.ip.toLowerCase();
  const loopback = (value: string | undefined) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value ?? '');
  if (!token || typeof provided !== 'string' || !loopback(remoteAddress) || !loopback(effectiveAddress)) return false;
  const expectedBytes = Buffer.from(token);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

async function requireUser(request: FastifyRequest<any, any, any, any, any, any, any, any>, reply: FastifyReply, allowPasswordSetup = false): Promise<Session | null> {
  let payload: Session;
  try {
    payload = await request.jwtVerify<Session>();
  } catch {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  try {
    const current = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, email: true, name: true, role: true, sessionVersion: true, mustChangePassword: true, disabledAt: true, websiteLimit: true } });
    if (!current) {
      await reply.code(401).send({ error: 'Session is no longer valid.' });
      return null;
    }
    const blockReason = sessionAccessBlockReason(payload.sessionVersion, current, allowPasswordSetup);
    if (blockReason === 'stale-session') {
      await reply.code(401).send({ error: 'Session is no longer valid.' });
      return null;
    }
    if (blockReason === 'account-disabled') {
      reply.clearCookie('nova_session', { path: '/' });
      await reply.code(401).send({ error: 'This account is disabled.' });
      return null;
    }
    if (blockReason === 'password-change-required') {
      await reply.code(403).send({ error: 'Change your temporary password before using the panel.' });
      return null;
    }
    return { sub: current.id, email: current.email, name: current.name, role: current.role, sessionVersion: current.sessionVersion, websiteLimit: current.websiteLimit };
  } catch {
    await reply.code(503).send({ error: 'Control-plane database is unavailable.' });
    return null;
  }
}

app.addHook('onRequest', async (request, reply) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin && origin !== panelOrigin) return reply.code(403).send({ error: 'Origin not allowed.' });
  }
});

app.get('/api/health', async () => {
  let database: 'connected' | 'unavailable' = 'unavailable';
  let schema: 'ready' | 'migrations-required' | 'unavailable' = 'unavailable';
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = 'connected';
    try { await prisma.user.count(); schema = 'ready'; } catch { schema = 'migrations-required'; }
  } catch { /* dependency status is reported, not hidden */ }
  return { service: 'nova-control-plane', status: 'ok', database, schema, timestamp: new Date().toISOString() };
});

app.get('/api/auth/setup-status', async () => {
  try {
    const [users, installation] = await Promise.all([prisma.user.count(), prisma.installation.findUnique({ where: { id: 'singleton' } })]);
    return { setupEnabled: users === 0, administratorExists: users > 0, installationStatus: installation?.status ?? (users ? 'EXISTING_INSTALL' : 'NOT_STARTED') };
  } catch {
    return { setupEnabled: false, administratorExists: false, installationStatus: 'DATABASE_OR_MIGRATION_REQUIRED' };
  }
});

app.get('/api/install/status', async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Super Administrator permission required.' });
  try {
    const [adminCount, localNodes, installation] = await Promise.all([
      prisma.user.count({ where: { role: 'ADMIN' } }),
      prisma.node.findMany({ where: { nodeType: 'local' }, select: { id: true, hostname: true, operatingSystem: true, cpuCores: true, ipAddresses: true, systemInfo: true, status: true, agentVersion: true, lastHeartbeat: true, bootstrapIssuedAt: true, agentUrl: true } }),
      prisma.installation.findUnique({ where: { id: 'singleton' } }),
    ]);
    const agentOnline = localNodes.some((node) => node.status === 'online' && node.lastHeartbeat && Date.now() - node.lastHeartbeat.getTime() < 90_000);
    const steps = [
      { id: 'database', label: 'PostgreSQL schema and data store', status: 'complete' },
      { id: 'secrets', label: 'Persistent signing and encryption secrets', status: process.env.JWT_SECRET && process.env.NODE_ENCRYPTION_KEY ? 'complete' : 'action-required' },
      { id: 'administrator', label: 'Initial Super Administrator', status: adminCount ? 'complete' : 'action-required' },
      { id: 'local-node', label: 'Local Node registration', status: localNodes.length ? 'complete' : 'action-required' },
      { id: 'agent-url', label: 'HTTPS agent command endpoint configured', status: localNodes[0]?.agentUrl ? 'complete' : 'action-required' },
      { id: 'agent', label: 'Authenticated local agent heartbeat and inventory', status: agentOnline && Boolean(localNodes[0]?.systemInfo) && Boolean(localNodes[0]?.agentUrl) ? 'complete' : 'waiting' },
    ];
    return { status: installation?.status ?? (adminCount ? 'EXISTING_INSTALL' : 'NOT_STARTED'), completedAt: installation?.completedAt ?? null, lastError: installation?.lastError ?? null, steps, localNodes };
  } catch (error) {
    request.log.error(error);
    return reply.code(503).send({ status: 'DATABASE_OR_MIGRATION_REQUIRED', error: 'Database is unavailable or migrations have not been applied.' });
  }
});

app.post('/api/install/initialize', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
  if (!process.env.NODE_ENCRYPTION_KEY || !process.env.JWT_SECRET) return reply.code(503).send({ error: 'Persistent JWT_SECRET and NODE_ENCRYPTION_KEY must be configured before initialization.' });
  const passwordHash = await argon2.hash('admin');
  try {
    const result = await prisma.$transaction(async (tx) => {
      const count = await tx.user.count();
      if (count !== 0) throw new Error('INSTALL_ALREADY_INITIALIZED');
      const user = await tx.user.create({ data: { name: 'Super Administrator', email: 'admin@novahosting.local', username: 'admin', passwordHash, role: 'ADMIN', mustChangePassword: true } });
      const localHostname = systemHostname().toLowerCase();
      const ips = Object.values(networkInterfaces()).flatMap((items) => (items ?? []).filter((item) => !item.internal && item.family === 'IPv4').map((item) => item.address));
      const localSecret = randomBytes(32);
      const node = await tx.node.create({ data: { name: 'Local Node', hostname: localHostname, nodeType: 'local', operatingSystem: `${systemPlatform()} ${systemRelease()}`, cpuCores: systemCpus().length, ipAddresses: ips, systemInfo: { architecture: systemArch(), detectedBy: 'control-plane-process', services: [], virtualization: 'awaiting-agent' }, agentUrl: process.env.LOCAL_AGENT_URL && localAgentUrlInput.safeParse({ agentUrl: process.env.LOCAL_AGENT_URL }).success ? new URL(process.env.LOCAL_AGENT_URL).origin : null, agentSecretCiphertext: encryptNodeSecret(localSecret), status: 'pending' } });
      await tx.installation.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', status: 'WAITING_FOR_AGENT', steps: [{ id: 'database', status: 'complete' }, { id: 'secrets', status: 'complete' }, { id: 'administrator', status: 'complete' }, { id: 'local-node', status: 'complete' }, { id: 'agent-url', status: node.agentUrl ? 'complete' : 'pending' }, { id: 'agent', status: 'waiting' }] }, update: { status: 'WAITING_FOR_AGENT', lastError: null } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'installation.initialized', resource: 'installation', resourceId: 'singleton', ipAddress: request.ip } });
      return user;
    }, { isolationLevel: 'Serializable' });
    const token = app.jwt.sign({ sub: result.id, role: result.role, email: result.email, name: result.name, sessionVersion: result.sessionVersion }, { expiresIn: '8h' });
    reply.setCookie('nova_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 });
    return reply.code(201).send({ user: safeUser(result), initialCredentials: { username: 'admin', password: 'admin' }, mustChangePassword: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'INSTALL_ALREADY_INITIALIZED') return reply.code(409).send({ error: 'An account already exists. Initialization will never reset or recreate it.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'Initialization failed; retry is safe after correcting the reported database or secret configuration.' });
  }
});

app.post('/api/install/local-node', async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Super Administrator permission required.' });
  try {
    const existing = await prisma.node.findFirst({ where: { nodeType: 'local' } });
    if (existing) return { node: { id: existing.id, hostname: existing.hostname, agentUrl: existing.agentUrl }, created: false };
    const host = systemHostname().toLowerCase();
    const ips = Object.values(networkInterfaces()).flatMap((items) => (items ?? []).filter((item) => !item.internal && item.family === 'IPv4').map((item) => item.address));
    const secret = randomBytes(32);
    const node = await prisma.$transaction(async (tx) => {
      const created = await tx.node.create({ data: { name: 'Local Node', hostname: host, nodeType: 'local', operatingSystem: `${systemPlatform()} ${systemRelease()}`, cpuCores: systemCpus().length, ipAddresses: ips, systemInfo: { architecture: systemArch(), detectedBy: 'control-plane-process', services: [], virtualization: 'not-detected' }, agentUrl: process.env.LOCAL_AGENT_URL && localAgentUrlInput.safeParse({ agentUrl: process.env.LOCAL_AGENT_URL }).success ? new URL(process.env.LOCAL_AGENT_URL).origin : null, agentSecretCiphertext: encryptNodeSecret(secret), status: 'pending' } });
      await tx.installation.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', status: 'WAITING_FOR_AGENT', steps: [{ id: 'database', status: 'complete' }, { id: 'secrets', status: 'complete' }, { id: 'administrator', status: 'complete' }, { id: 'local-node', status: 'complete' }, { id: 'agent-url', status: 'pending' }, { id: 'agent', status: 'waiting' }] }, update: { status: 'WAITING_FOR_AGENT', completedAt: null, lastError: null } });
      await tx.auditLog.create({ data: { actorId: session.sub, action: 'node.local_registered', resource: 'node', resourceId: created.id, ipAddress: request.ip } });
      return created;
    });
    return reply.code(201).send({ node: { id: node.id, hostname: node.hostname, agentUrl: node.agentUrl }, created: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return reply.code(409).send({ error: 'A node with this host name already exists; resolve the conflict before registering the Local Node.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'Local Node could not be registered.' });
  }
});

app.put('/api/install/local-agent-url', async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Super Administrator permission required.' });
  const input = localAgentUrlInput.safeParse(request.body);
  if (!input.success) return reply.code(400).send({ error: 'Provide the Local Node agent HTTPS origin with a trusted certificate.' });
  try {
    const agentUrl = new URL(input.data.agentUrl).origin;
    const node = await prisma.node.findFirst({ where: { nodeType: 'local' } });
    if (!node) return reply.code(404).send({ error: 'Local Node registration is missing.' });
    const updated = await prisma.node.update({ where: { id: node.id }, data: { agentUrl } });
    await prisma.$transaction([
      prisma.auditLog.create({ data: { actorId: session.sub, action: 'node.local_agent_url_updated', resource: 'node', resourceId: node.id, ipAddress: request.ip } }),
      prisma.installation.updateMany({ where: { id: 'singleton' }, data: { status: 'WAITING_FOR_AGENT', completedAt: null, lastError: null } }),
    ]);
    return { node: { id: updated.id, agentUrl: updated.agentUrl } };
  } catch (error) {
    request.log.error(error);
    return reply.code(503).send({ error: 'Local agent URL could not be saved.' });
  }
});

app.post('/api/install/installer-agent-bootstrap', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
  if (!isLocalInstallerRequest(request)) return reply.code(403).send({ error: 'This bootstrap endpoint requires the root-owned installer token over loopback.' });
  const sharedSecret = randomBytes(32);
  const configuredAgentUrl = process.env.LOCAL_AGENT_URL && localAgentUrlInput.safeParse({ agentUrl: process.env.LOCAL_AGENT_URL }).success ? new URL(process.env.LOCAL_AGENT_URL).origin : null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      let node = await tx.node.findFirst({ where: { nodeType: 'local' } });
      if (node) {
        node = await tx.node.update({ where: { id: node.id }, data: { agentSecretCiphertext: encryptNodeSecret(sharedSecret), bootstrapIssuedAt: new Date(), status: 'pending', lastHeartbeat: null, agentVersion: null, ...(configuredAgentUrl ? { agentUrl: configuredAgentUrl } : {}) } });
      } else {
        const localHostname = systemHostname().toLowerCase();
        const ips = Object.values(networkInterfaces()).flatMap((items) => (items ?? []).filter((item) => !item.internal && item.family === 'IPv4').map((item) => item.address));
        node = await tx.node.create({ data: { name: 'Local Node', hostname: localHostname, nodeType: 'local', operatingSystem: `${systemPlatform()} ${systemRelease()}`, cpuCores: systemCpus().length, ipAddresses: ips, systemInfo: { architecture: systemArch(), detectedBy: 'control-plane-process', services: [], virtualization: 'awaiting-agent' }, agentUrl: configuredAgentUrl, agentSecretCiphertext: encryptNodeSecret(sharedSecret), bootstrapIssuedAt: new Date(), status: 'pending' } });
      }
      await tx.installation.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', status: 'WAITING_FOR_AGENT', steps: [{ id: 'database', status: 'complete' }, { id: 'secrets', status: 'complete' }, { id: 'administrator', status: 'complete' }, { id: 'local-node', status: 'complete' }, { id: 'agent-url', status: node.agentUrl ? 'complete' : 'pending' }, { id: 'agent', status: 'waiting' }] }, update: { status: 'WAITING_FOR_AGENT', completedAt: null, lastError: null } });
      await tx.auditLog.create({ data: { action: 'node.local_bootstrap_issued_by_installer', resource: 'node', resourceId: node.id } });
      return { nodeId: node.id, hostname: node.hostname, agentUrl: node.agentUrl };
    });
    return { bootstrap: { ...result, sharedSecret: sharedSecret.toString('base64') }, controlUrl: publicControlUrl };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return reply.code(409).send({ error: 'A node with this machine hostname already exists; resolve the node conflict before installing the Local Node agent.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'Installer bootstrap could not be prepared.' });
  }
});

app.post('/api/install/local-agent-bootstrap', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Super Administrator permission required.' });
  const rotate = Boolean(request.body && typeof request.body === 'object' && 'rotate' in request.body && (request.body as { rotate?: unknown }).rotate === true);
  const newSecret = randomBytes(32);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const node = await tx.node.findFirst({ where: { nodeType: 'local' } });
      if (!node?.agentSecretCiphertext) throw new Error('LOCAL_NODE_MISSING');
      if (node.bootstrapIssuedAt && !rotate) throw new Error('BOOTSTRAP_ALREADY_ISSUED');
      const now = new Date();
      if (node.bootstrapIssuedAt) {
        await tx.node.update({ where: { id: node.id }, data: { agentSecretCiphertext: encryptNodeSecret(newSecret), bootstrapIssuedAt: now, status: 'pending', lastHeartbeat: null, agentVersion: null } });
      } else {
        const updated = await tx.node.updateMany({ where: { id: node.id, bootstrapIssuedAt: null }, data: { bootstrapIssuedAt: now } });
        if (updated.count !== 1) throw new Error('BOOTSTRAP_ALREADY_ISSUED');
      }
      await tx.installation.updateMany({ where: { id: 'singleton' }, data: { status: 'WAITING_FOR_AGENT', completedAt: null } });
      await tx.auditLog.create({ data: { actorId: session.sub, action: rotate ? 'node.local_bootstrap_rotated' : 'node.local_bootstrap_issued', resource: 'node', resourceId: node.id, ipAddress: request.ip } });
      return { nodeId: node.id, hostname: node.hostname, sharedSecret: (node.bootstrapIssuedAt ? newSecret : decryptNodeSecret(node.agentSecretCiphertext)).toString('base64'), agentUrl: node.agentUrl };
    });
    return { bootstrap: result, controlUrl: publicControlUrl };
  } catch (error) {
    if (error instanceof Error && error.message === 'LOCAL_NODE_MISSING') return reply.code(404).send({ error: 'Local Node registration is missing.' });
    if (error instanceof Error && error.message === 'BOOTSTRAP_ALREADY_ISSUED') return reply.code(409).send({ error: 'Local agent credentials were already displayed. Confirm rotation to replace them; the old agent key will stop working.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'Local agent bootstrap could not be prepared.' });
  }
});

app.post('/api/auth/setup', async (_request, reply) => reply.code(410).send({ error: 'Use the one-time installation initializer. Existing accounts are never reset.' }));

app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const input = loginInput.safeParse(request.body);
  if (!input.success) return reply.code(400).send({ error: 'Email and password are required.' });
  try {
    const user = await prisma.user.findFirst({ where: { OR: [{ email: input.data.identifier.toLowerCase() }, { username: input.data.identifier.toLowerCase() }] } });
    if (!user || user.disabledAt || !(await argon2.verify(user.passwordHash, input.data.password))) return reply.code(401).send({ error: 'Email or password is incorrect.' });
    const token = app.jwt.sign({ sub: user.id, role: user.role, email: user.email, name: user.name, sessionVersion: user.sessionVersion }, { expiresIn: '8h' });
    reply.setCookie('nova_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 });
    return { user: safeUser(user) };
  } catch (error) {
    request.log.error(error);
    return reply.code(503).send({ error: 'Database is unavailable.' });
  }
});

app.post('/api/auth/logout', async (_request, reply) => {
  reply.clearCookie('nova_session', { path: '/' });
  return { ok: true };
});

app.get('/api/auth/me', async (request, reply) => {
  const session = await requireUser(request, reply, true);
  if (!session) return;
  const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { id: true, email: true, name: true, role: true, mustChangePassword: true } });
  if (!user) return reply.code(401).send({ error: 'Session is no longer valid.' });
  return { user };
});

app.get('/api/customers', async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Administrator permission required.' });
  try {
    const customers = await prisma.user.findMany({ where: { role: 'CUSTOMER' }, take: 200, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, email: true, mustChangePassword: true, disabledAt: true, websiteLimit: true, createdAt: true, _count: { select: { websites: true } } } });
    return { customers: customers.map(({ _count, ...customer }) => ({ ...customer, websiteCount: _count.websites })) };
  } catch (error) {
    request.log.error(error);
    return reply.code(503).send({ error: 'Customer records are unavailable.' });
  }
});

app.patch('/api/customers/:customerId/status', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Administrator permission required.' });
  const { customerId } = request.params as { customerId: string };
  const input = customerStatusInput.safeParse(request.body);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(customerId) || !input.success) return reply.code(400).send({ error: 'Invalid customer status request.' });
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id: customerId }, select: { id: true, role: true, disabledAt: true } });
      if (!existing || existing.role !== 'CUSTOMER') throw new Error('CUSTOMER_NOT_FOUND');
      const isActive = existing.disabledAt === null;
      if (isActive === input.data.active) return { id: existing.id, active: isActive };
      const updated = await tx.user.update({ where: { id: customerId }, data: { disabledAt: input.data.active ? null : new Date(), sessionVersion: { increment: 1 } } });
      await tx.auditLog.create({ data: { actorId: session.sub, action: input.data.active ? 'customer.activated' : 'customer.suspended', resource: 'user', resourceId: updated.id, ipAddress: request.ip } });
      return { id: updated.id, active: input.data.active };
    });
    return { customer: result };
  } catch (error) {
    if (error instanceof Error && error.message === 'CUSTOMER_NOT_FOUND') return reply.code(404).send({ error: 'Customer account not found.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'Customer status could not be updated.' });
  }
});

app.post('/api/customers/:customerId/reset-password', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Administrator permission required.' });
  const { customerId } = request.params as { customerId: string };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(customerId)) return reply.code(400).send({ error: 'Invalid customer identifier.' });
  const oneTimePassword = randomBytes(24).toString('base64url');
  try {
    const customer = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id: customerId }, select: { id: true, role: true } });
      if (!existing || existing.role !== 'CUSTOMER') throw new Error('CUSTOMER_NOT_FOUND');
      const updated = await tx.user.update({ where: { id: customerId }, data: { passwordHash: await argon2.hash(oneTimePassword), mustChangePassword: true, sessionVersion: { increment: 1 } } });
      await tx.auditLog.create({ data: { actorId: session.sub, action: 'customer.password_reset', resource: 'user', resourceId: updated.id, ipAddress: request.ip } });
      return updated;
    });
    return { customer: safeUser(customer), oneTimePassword };
  } catch (error) {
    if (error instanceof Error && error.message === 'CUSTOMER_NOT_FOUND') return reply.code(404).send({ error: 'Customer account not found.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'Customer password could not be reset.' });
  }
});

app.post('/api/customers', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Administrator permission required.' });
  const input = customerInput.safeParse(request.body);
  if (!input.success) return reply.code(400).send({ error: 'Provide a valid customer name and email address.' });
  const oneTimePassword = randomBytes(24).toString('base64url');
  try {
    const customer = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { name: input.data.name, email: input.data.email.toLowerCase(), passwordHash: await argon2.hash(oneTimePassword), role: 'CUSTOMER', mustChangePassword: true, websiteLimit: input.data.websiteLimit } });
      await tx.auditLog.create({ data: { actorId: session.sub, action: 'customer.created', resource: 'user', resourceId: created.id, ipAddress: request.ip } });
      return created;
    });
    return reply.code(201).send({ customer: safeUser(customer), oneTimePassword });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return reply.code(409).send({ error: 'A customer with that email address already exists.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'Customer account could not be created.' });
  }
});

app.post('/api/auth/password', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const session = await requireUser(request, reply, true);
  if (!session) return;
  const input = passwordChangeInput.safeParse(request.body);
  if (!input.success) return reply.code(400).send({ error: 'New password must contain 12 to 128 characters.' });
  try {
    const current = await prisma.user.findUnique({ where: { id: session.sub } });
    if (!current) return reply.code(401).send({ error: 'Session is no longer valid.' });
    if (!current.mustChangePassword && !input.data.currentPassword) return reply.code(400).send({ error: 'Current password is required.' });
    if (input.data.currentPassword && !(await argon2.verify(current.passwordHash, input.data.currentPassword))) return reply.code(401).send({ error: 'Current password is incorrect.' });
    if (await argon2.verify(current.passwordHash, input.data.newPassword)) return reply.code(400).send({ error: 'Choose a password different from the current password.' });
    const passwordHash = await argon2.hash(input.data.newPassword);
    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: session.sub }, data: { passwordHash, mustChangePassword: false, sessionVersion: { increment: 1 } } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'account.password_changed', resource: 'user', resourceId: user.id, ipAddress: request.ip } });
      return user;
    });
    const token = app.jwt.sign({ sub: updated.id, role: updated.role, email: updated.email, name: updated.name, sessionVersion: updated.sessionVersion }, { expiresIn: '8h' });
    reply.setCookie('nova_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 });
    return { user: safeUser(updated) };
  } catch (error) {
    request.log.error(error);
    return reply.code(503).send({ error: 'Password could not be changed.' });
  }
});

app.get('/api/activity', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Administrator permission required.' });
  const query = activityQuery.safeParse(request.query);
  if (!query.success) return reply.code(400).send({ error: 'Invalid activity filter.' });
  try {
    const events = await prisma.auditLog.findMany({
      where: query.data.action ? { action: query.data.action } : {},
      take: query.data.limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { actor: { select: { name: true, email: true } } },
    });
    return { events: events.map((event) => ({ id: event.id, actor: event.actor?.name ?? event.actor?.email ?? 'System', action: event.action, resource: event.resource, resourceId: event.resourceId, createdAt: event.createdAt })) };
  } catch (error) {
    request.log.error(error);
    return reply.code(503).send({ error: 'Activity records are unavailable.' });
  }
});

app.get('/api/overview', async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  try {
    const [nodes, websites, jobs, recentActivity] = await Promise.all([
      session.role === 'ADMIN' ? prisma.node.findMany({ select: { id: true, name: true, hostname: true, region: true, status: true, agentVersion: true, lastHeartbeat: true, cpuPercent: true, memoryUsed: true, memoryTotal: true, diskUsed: true, diskTotal: true }, orderBy: { name: 'asc' } }) : Promise.resolve([]),
      prisma.website.count({ where: session.role === 'ADMIN' ? {} : { ownerId: session.sub } }),
      prisma.job.count({ where: { status: { in: ['QUEUED', 'RUNNING'] }, ...(session.role === 'ADMIN' ? {} : { ownerId: session.sub }) } }),
      session.role === 'ADMIN' ? prisma.auditLog.findMany({ take: 6, orderBy: { createdAt: 'desc' }, include: { actor: { select: { name: true } } } }) : Promise.resolve([]),
    ]);
    const liveNodes = nodes.filter((node) => node.status === 'online' && node.lastHeartbeat && Date.now() - node.lastHeartbeat.getTime() < 90_000).length;
    return {
      user: { name: session.name, role: session.role },
      metrics: { nodes: nodes.length, liveNodes, websites, websiteLimit: session.role === 'CUSTOMER' ? session.websiteLimit : null, queuedJobs: jobs },
      nodes: nodes.map((n) => ({ ...n, memoryUsed: n.memoryUsed?.toString() ?? null, memoryTotal: n.memoryTotal?.toString() ?? null, diskUsed: n.diskUsed?.toString() ?? null, diskTotal: n.diskTotal?.toString() ?? null, online: Boolean(n.lastHeartbeat && Date.now() - n.lastHeartbeat.getTime() < 90_000 && n.status === 'online') })),
      activity: recentActivity.map((event) => ({ id: event.id, actor: event.actor?.name ?? 'System', action: event.action, resource: event.resource, createdAt: event.createdAt })),
      capabilities: { provisioning: liveNodes > 0 ? 'static-html' : 'unavailable', reason: liveNodes > 0 ? 'Static HTML provisioning is enabled on fresh, authenticated nodes.' : 'Connect and verify a Nova node agent to enable static website provisioning.', database: 'postgresql' },
    };
  } catch (error) {
    request.log.error(error);
    return reply.code(503).send({ error: 'Control-plane database is unavailable.' });
  }
});

app.get('/api/websites', async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  try {
    const websites = await prisma.website.findMany({ where: session.role === 'ADMIN' ? {} : { ownerId: session.sub }, include: { node: { select: { name: true, hostname: true } } }, orderBy: { createdAt: 'desc' } });
    return { websites };
  } catch {
    return reply.code(503).send({ error: 'Control-plane database is unavailable.' });
  }
});

app.get('/api/jobs', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  const query = jobListQuery.safeParse(request.query);
  if (!query.success) return reply.code(400).send({ error: 'Invalid job list filter.' });
  try {
    const jobs = await prisma.job.findMany({
      where: {
        ...(query.data.status ? { status: query.data.status } : {}),
        ...(session.role === 'ADMIN' ? {} : { ownerId: session.sub }),
      },
      take: query.data.limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, type: true, status: true, attempts: true, createdAt: true, updatedAt: true, website: { select: { primaryDomain: true } } },
    });
    return { jobs };
  } catch (error) {
    request.log.error(error);
    return reply.code(503).send({ error: 'Job history is unavailable.' });
  }
});

app.get('/api/websites/:websiteId/files', { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  const { websiteId } = request.params as { websiteId: string };
  const query = fileReadQuery.safeParse(request.query);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(websiteId) || !query.success) return reply.code(400).send({ error: 'Invalid website or file path.' });
  try {
    const website = await prisma.website.findFirst({ where: { id: websiteId, ...(session.role === 'ADMIN' ? {} : { ownerId: session.sub }) }, select: { id: true, nodeId: true, primaryDomain: true, status: true } });
    if (!website) return reply.code(404).send({ error: 'Website not found.' });
    if (website.status !== 'ACTIVE' || !website.nodeId) return reply.code(409).send({ error: 'File access requires an active website on a connected node.' });
    const node = await prisma.node.findUnique({ where: { id: website.nodeId }, select: { id: true, agentUrl: true, agentSecretCiphertext: true, lastHeartbeat: true, status: true } });
    if (!node) return reply.code(503).send({ error: 'Hosting node is unavailable.' });
    const result = await callAgent(node, { operation: query.data.action === 'read' ? 'files.read' : 'files.list', siteId: website.id, domain: website.primaryDomain, path: query.data.path });
    await prisma.auditLog.create({ data: { actorId: session.sub, action: query.data.action === 'read' ? 'website.file.read' : 'website.directory.listed', resource: 'website', resourceId: website.id, ipAddress: request.ip, metadata: { path: query.data.path } } });
    return result;
  } catch (error) {
    request.log.error(error);
    return reply.code(502).send({ error: error instanceof Error ? error.message.slice(0, 240) : 'File operation failed.' });
  }
});

app.post('/api/websites/:websiteId/files', { bodyLimit: 12 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  const { websiteId } = request.params as { websiteId: string };
  const input = fileMutationInput.safeParse(request.body);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(websiteId) || !input.success) return reply.code(400).send({ error: 'Invalid file operation or path.' });
  try {
    const website = await prisma.website.findFirst({ where: { id: websiteId, ...(session.role === 'ADMIN' ? {} : { ownerId: session.sub }) }, select: { id: true, nodeId: true, primaryDomain: true, status: true } });
    if (!website) return reply.code(404).send({ error: 'Website not found.' });
    if (website.status !== 'ACTIVE' || !website.nodeId) return reply.code(409).send({ error: 'File changes require an active website on a connected node.' });
    const node = await prisma.node.findUnique({ where: { id: website.nodeId }, select: { id: true, agentUrl: true, agentSecretCiphertext: true, lastHeartbeat: true, status: true } });
    if (!node) return reply.code(503).send({ error: 'Hosting node is unavailable.' });
    const result = await callAgent(node, { ...input.data, siteId: website.id, domain: website.primaryDomain });
    const details = input.data.operation === 'files.write' ? { path: input.data.path, size: Buffer.from(input.data.contentBase64, 'base64').byteLength } : { path: input.data.path, newPath: 'newPath' in input.data ? input.data.newPath : undefined };
    await prisma.auditLog.create({ data: { actorId: session.sub, action: input.data.operation, resource: 'website-file', resourceId: website.id, ipAddress: request.ip, metadata: details } });
    return { ok: true, result };
  } catch (error) {
    request.log.error(error);
    return reply.code(502).send({ error: error instanceof Error ? error.message.slice(0, 240) : 'File operation failed.' });
  }
});

app.post('/api/websites', async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  const input = websiteInput.safeParse(request.body);
  const rawKey = request.headers['idempotency-key'];
  if (!input.success) return reply.code(400).send({ error: 'Enter a valid domain. Static websites are the only runtime currently enabled.' });
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(rawKey)) return reply.code(400).send({ error: 'A unique Idempotency-Key header (8–128 safe characters) is required.' });
  const idempotencyKey = `${session.sub}:${rawKey}`;
  try {
    const prior = await prisma.job.findUnique({ where: { idempotencyKey }, include: { website: true } });
    if (prior) {
      const priorPayload = prior.payload as Record<string, unknown>;
      if (priorPayload.primaryDomain !== input.data.primaryDomain || priorPayload.operation !== 'website.create') return reply.code(409).send({ error: 'This idempotency key was already used for a different operation.' });
      return reply.code(202).send({ website: prior.website, job: { id: prior.id, status: prior.status } });
    }
    const nodes = await prisma.node.findMany({ where: { status: 'online', lastHeartbeat: { gte: new Date(Date.now() - 90_000) }, agentUrl: { not: null }, agentSecretCiphertext: { not: null } }, select: { id: true } });
    if (nodes.length === 0) return reply.code(503).send({ error: 'No healthy Nova hosting node is connected. Website provisioning is unavailable.' });
    const ranked = await Promise.all(nodes.map(async (node) => ({ id: node.id, load: await prisma.website.count({ where: { nodeId: node.id, status: { in: ['ACTIVE', 'PENDING'] } } }) })));
    ranked.sort((a, b) => a.load - b.load || a.id.localeCompare(b.id));
    const selectedNode = ranked[0];
    if (!selectedNode) return reply.code(503).send({ error: 'No suitable hosting node is available.' });
    const website = await prisma.$transaction(async (tx) => {
      if (session.role === 'CUSTOMER') {
        const currentCount = await tx.website.count({ where: { ownerId: session.sub } });
        if (currentCount >= session.websiteLimit) throw new Error('WEBSITE_QUOTA_REACHED');
      }
      const created = await tx.website.create({ data: { ownerId: session.sub, nodeId: selectedNode.id, primaryDomain: input.data.primaryDomain, runtime: 'static', status: 'PENDING' } });
      await tx.job.create({ data: { idempotencyKey, type: 'website.create', websiteId: created.id, ownerId: session.sub, payload: { operation: 'website.create', websiteId: created.id, ownerId: session.sub, primaryDomain: created.primaryDomain, nodeId: selectedNode.id } } });
      return created;
    }, { isolationLevel: 'Serializable' });
    return reply.code(202).send({ website, job: { status: 'QUEUED' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'WEBSITE_QUOTA_REACHED') return reply.code(409).send({ error: `This account has reached its ${session.websiteLimit}-website limit.` });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return reply.code(409).send({ error: 'That domain is already registered, or this request key has already been used.' });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') return reply.code(409).send({ error: 'A concurrent website request changed the account quota. Retry with a new request key.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'Website request could not be queued.' });
  }
});

app.post('/api/websites/:websiteId/ssl', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  const { websiteId } = request.params as { websiteId: string };
  const rawKey = request.headers['idempotency-key'];
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(websiteId)) return reply.code(400).send({ error: 'Invalid website identifier.' });
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(rawKey)) return reply.code(400).send({ error: 'A unique Idempotency-Key header is required.' });
  const idempotencyKey = `${session.sub}:${rawKey}`;
  try {
    const prior = await prisma.job.findUnique({ where: { idempotencyKey }, include: { website: true } });
    if (prior) {
      const priorPayload = prior.payload as Record<string, unknown>;
      if (priorPayload.websiteId !== websiteId || priorPayload.operation !== 'website.ssl.enable') return reply.code(409).send({ error: 'This idempotency key was already used for a different operation.' });
      return reply.code(202).send({ website: prior.website, job: { id: prior.id, status: prior.status } });
    }
    const website = await prisma.website.findFirst({ where: { id: websiteId, ...(session.role === 'ADMIN' ? {} : { ownerId: session.sub }) } });
    if (!website) return reply.code(404).send({ error: 'Website not found.' });
    if (website.status !== 'ACTIVE' || !website.nodeId) return reply.code(409).send({ error: 'TLS setup requires an active website on a connected node.' });
    if (website.tlsStatus === 'active') return reply.send({ website, job: { status: 'SUCCEEDED' } });
    if (website.tlsStatus === 'pending') return reply.code(409).send({ error: 'TLS setup is already in progress.' });
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.website.updateMany({ where: { id: website.id, status: 'ACTIVE', tlsStatus: website.tlsStatus }, data: { tlsStatus: 'pending' } });
      if (updated.count !== 1) throw new Error('TLS_STATE_CHANGED');
      return tx.job.create({ data: { idempotencyKey, type: 'website.ssl.enable', websiteId: website.id, ownerId: website.ownerId, payload: { operation: 'website.ssl.enable', websiteId: website.id, ownerId: website.ownerId, primaryDomain: website.primaryDomain, nodeId: website.nodeId } } });
    });
    return reply.code(202).send({ job: { id: result.id, status: result.status } });
  } catch (error) {
    if (error instanceof Error && error.message === 'TLS_STATE_CHANGED') return reply.code(409).send({ error: 'Website TLS status changed concurrently. Refresh and retry.' });
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return reply.code(409).send({ error: 'This TLS operation or request key already exists.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'TLS request could not be queued.' });
  }
});

app.delete('/api/websites/:websiteId', async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  const { websiteId } = request.params as { websiteId: string };
  const rawKey = request.headers['idempotency-key'];
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(websiteId)) return reply.code(400).send({ error: 'Invalid website identifier.' });
  if (typeof rawKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(rawKey)) return reply.code(400).send({ error: 'A unique Idempotency-Key header is required.' });
  const idempotencyKey = `${session.sub}:${rawKey}`;
  try {
    const prior = await prisma.job.findUnique({ where: { idempotencyKey }, include: { website: true } });
    if (prior) {
      const priorPayload = prior.payload as Record<string, unknown>;
      if (priorPayload.websiteId !== websiteId || priorPayload.operation !== 'website.delete') return reply.code(409).send({ error: 'This idempotency key was already used for a different operation.' });
      return reply.code(202).send({ website: prior.website, job: { id: prior.id, status: prior.status } });
    }
    const website = await prisma.website.findFirst({ where: { id: websiteId, ...(session.role === 'ADMIN' ? {} : { ownerId: session.sub }) } });
    if (!website) return reply.code(404).send({ error: 'Website not found.' });
    if (!website.nodeId) return reply.code(409).send({ error: 'Website has no assigned hosting node.' });
    if (!['ACTIVE', 'FAILED'].includes(website.status)) return reply.code(409).send({ error: `Cannot delete a website while it is ${website.status.toLowerCase()}.` });
    if (website.tlsStatus === 'pending') return reply.code(409).send({ error: 'Wait for TLS setup to finish before deleting this website.' });
    await prisma.$transaction(async (tx) => {
      const marked = await tx.website.updateMany({ where: { id: website.id, status: website.status, tlsStatus: website.tlsStatus }, data: { status: 'SUSPENDED' } });
      if (marked.count !== 1) throw new Error('WEBSITE_STATE_CHANGED');
      await tx.job.create({ data: { idempotencyKey, type: 'website.delete', websiteId: website.id, ownerId: website.ownerId, payload: { operation: 'website.delete', websiteId: website.id, ownerId: website.ownerId, primaryDomain: website.primaryDomain, nodeId: website.nodeId } } });
    });
    return reply.code(202).send({ ok: true, job: { status: 'QUEUED' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'WEBSITE_STATE_CHANGED') return reply.code(409).send({ error: 'Website state changed concurrently. Refresh before retrying.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'Website deletion could not be queued.' });
  }
});

app.post('/api/nodes', async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Administrator permission required.' });
  const input = nodeRegistrationInput.safeParse(request.body);
  if (!input.success) return reply.code(400).send({ error: 'Provide a node name, hostname, region, and HTTPS agent URL.' });
  if (!process.env.NODE_ENCRYPTION_KEY) return reply.code(503).send({ error: 'NODE_ENCRYPTION_KEY must be configured before registering nodes.' });
  const secret = randomBytes(32);
  try {
    const agentUrl = new URL(input.data.agentUrl).origin;
    const node = await prisma.$transaction(async (tx) => {
      const created = await tx.node.create({ data: { name: input.data.name, hostname: input.data.hostname.toLowerCase(), region: input.data.region || null, agentUrl, agentSecretCiphertext: encryptNodeSecret(secret), status: 'pending' } });
      await tx.auditLog.create({ data: { actorId: session.sub, action: 'node.registered', resource: 'node', resourceId: created.id, ipAddress: request.ip, metadata: { hostname: created.hostname, agentUrl } } });
      return created;
    });
    return reply.code(201).send({ node: { id: node.id, name: node.name, hostname: node.hostname, agentUrl: node.agentUrl, status: node.status }, bootstrap: { nodeId: node.id, sharedSecret: secret.toString('base64') } });
  } catch (error) {
    request.log.error(error);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return reply.code(409).send({ error: 'That node hostname is already registered.' });
    return reply.code(503).send({ error: 'Node registration could not be completed.' });
  }
});

app.get('/api/nodes', async (request, reply) => {
  const session = await requireUser(request, reply);
  if (!session) return;
  if (session.role !== 'ADMIN') return reply.code(403).send({ error: 'Administrator permission required.' });
  try {
    const nodes = await prisma.node.findMany({ select: { id: true, name: true, hostname: true, agentUrl: true, region: true, status: true, agentVersion: true, lastHeartbeat: true, cpuPercent: true, memoryUsed: true, memoryTotal: true, diskUsed: true, diskTotal: true, networkRxBytes: true, networkTxBytes: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
    return { nodes: nodes.map((n) => ({ ...n, memoryUsed: n.memoryUsed?.toString() ?? null, memoryTotal: n.memoryTotal?.toString() ?? null, diskUsed: n.diskUsed?.toString() ?? null, diskTotal: n.diskTotal?.toString() ?? null, networkRxBytes: n.networkRxBytes?.toString() ?? null, networkTxBytes: n.networkTxBytes?.toString() ?? null })) };
  } catch {
    return reply.code(503).send({ error: 'Control-plane database is unavailable.' });
  }
});

app.post('/api/agent/nodes/:nodeId/heartbeat', async (request, reply) => {
  const { nodeId } = request.params as { nodeId: string };
  const input = heartbeatInput.safeParse(request.body);
  if (!input.success) return reply.code(400).send({ error: 'Invalid node telemetry payload.' });
  try {
    const node = await prisma.node.findUnique({ where: { id: nodeId }, select: { id: true, status: true, nodeType: true, agentUrl: true, agentSecretCiphertext: true } });
    if (!node?.agentSecretCiphertext) return reply.code(401).send({ error: 'Unknown node credentials.' });
    const body = Buffer.from(JSON.stringify({ agentVersion: input.data.agentVersion, cpuPercent: input.data.cpuPercent, memoryUsed: input.data.memoryUsed, memoryTotal: input.data.memoryTotal, diskUsed: input.data.diskUsed, diskTotal: input.data.diskTotal, networkRxBytes: input.data.networkRxBytes, networkTxBytes: input.data.networkTxBytes, ...(input.data.hostname ? { hostname: input.data.hostname } : {}), ...(input.data.operatingSystem ? { operatingSystem: input.data.operatingSystem } : {}), ...(input.data.cpuCores ? { cpuCores: input.data.cpuCores } : {}), ...(input.data.ipAddresses ? { ipAddresses: input.data.ipAddresses } : {}), ...(input.data.systemInfo ? { systemInfo: input.data.systemInfo } : {}) }));
    const requestPath = request.url.split('?')[0] ?? request.url;
    const verification = verifyAgentRequest(decryptNodeSecret(node.agentSecretCiphertext), request.method, requestPath, body, { timestamp: request.headers['x-nova-timestamp'] as string | undefined, nonce: request.headers['x-nova-nonce'] as string | undefined, signature: request.headers['x-nova-signature'] as string | undefined });
    if (!verification.ok) return reply.code(401).send({ error: 'Agent request authentication failed.' });
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.agentNonce.create({ data: { nodeId: node.id, nonce: verification.nonce, expiresAt: new Date(now.getTime() + 5 * 60_000) } });
      await tx.node.update({ where: { id: node.id }, data: { status: 'online', agentVersion: input.data.agentVersion, lastHeartbeat: now, cpuPercent: input.data.cpuPercent, memoryUsed: BigInt(input.data.memoryUsed), memoryTotal: BigInt(input.data.memoryTotal), diskUsed: BigInt(input.data.diskUsed), diskTotal: BigInt(input.data.diskTotal), networkRxBytes: BigInt(input.data.networkRxBytes), networkTxBytes: BigInt(input.data.networkTxBytes), operatingSystem: input.data.operatingSystem ?? undefined, cpuCores: input.data.cpuCores ?? undefined, ipAddresses: input.data.ipAddresses ?? undefined, systemInfo: input.data.systemInfo ?? undefined, ...(node.nodeType === 'local' && input.data.hostname ? { hostname: input.data.hostname.toLowerCase() } : {}) } });
      if (node.nodeType === 'local') {
        if (node.agentUrl && input.data.systemInfo && input.data.hostname && input.data.operatingSystem && input.data.cpuCores) {
          const completeSteps = [{ id: 'database', status: 'complete' }, { id: 'secrets', status: 'complete' }, { id: 'administrator', status: 'complete' }, { id: 'local-node', status: 'complete' }, { id: 'agent-url', status: 'complete' }, { id: 'agent', status: 'complete' }];
          await tx.installation.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', status: 'COMPLETE', completedAt: now, steps: completeSteps }, update: { status: 'COMPLETE', completedAt: now, lastError: null, steps: completeSteps } });
        } else {
          await tx.installation.updateMany({ where: { id: 'singleton' }, data: { status: 'AGENT_CONNECTED', completedAt: null, lastError: node.agentUrl ? 'Agent connected, but system inventory is incomplete.' : 'Agent heartbeat received, but the HTTPS command endpoint is not configured.' } });
        }
      }
      if (node.status !== 'online') await tx.auditLog.create({ data: { action: 'node.heartbeat_restored', resource: 'node', resourceId: node.id, metadata: { agentVersion: input.data.agentVersion } } });
    });
    return { accepted: true, serverTime: now.toISOString() };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return reply.code(409).send({ error: 'Signed heartbeat nonce has already been used.' });
    request.log.error(error);
    return reply.code(503).send({ error: 'Heartbeat could not be recorded.' });
  }
});

app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Route not found.' }));
app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(500).send({ error: 'Unexpected control-plane error.' });
});

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

const stopProvisioningWorker = startProvisioningWorker(prisma);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopProvisioningWorker();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
