import { randomUUID } from 'node:crypto';
import { decryptNodeSecret, signAgentRequest } from './agent-auth.js';
import type { PrismaClient } from './generated/prisma/client.js';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 180_000;
const AGENT_TIMEOUT_MS = 160_000;

type OperationPayload = {
  operation: 'website.create' | 'website.delete' | 'website.ssl.enable';
  websiteId: string;
  ownerId: string;
  primaryDomain: string;
  nodeId: string;
};

function parsePayload(value: unknown): OperationPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (!['website.create', 'website.delete', 'website.ssl.enable'].includes(String(data.operation))) return null;
  if (![data.websiteId, data.ownerId, data.primaryDomain, data.nodeId].every((v) => typeof v === 'string' && v.length > 0)) return null;
  return data as OperationPayload;
}

async function deliver(prisma: PrismaClient, job: { id: string; attempts: number; payload: unknown }): Promise<void> {
  const payload = parsePayload(job.payload);
  if (!payload) throw Object.assign(new Error('Invalid provisioning job payload.'), { permanent: true });
  const node = await prisma.node.findUnique({ where: { id: payload.nodeId }, select: { id: true, agentUrl: true, agentSecretCiphertext: true, lastHeartbeat: true, status: true } });
  if (!node?.agentUrl || !node.agentSecretCiphertext || node.status !== 'online' || !node.lastHeartbeat || Date.now() - node.lastHeartbeat.getTime() > 90_000) throw new Error('The assigned hosting node is not reachable or its heartbeat is stale.');

  const endpoint = new URL('/v1/operations', node.agentUrl);
  if (endpoint.protocol !== 'https:') throw Object.assign(new Error('Agent endpoint must use HTTPS.'), { permanent: true });
  const body = Buffer.from(JSON.stringify({ operation: payload.operation, siteId: payload.websiteId, domain: payload.primaryDomain, requestId: job.id }));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().replaceAll('-', '');
  const signature = signAgentRequest(decryptNodeSecret(node.agentSecretCiphertext), 'POST', endpoint.pathname, timestamp, nonce, body);
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    headers: { 'content-type': 'application/json', 'x-nova-timestamp': timestamp, 'x-nova-nonce': nonce, 'x-nova-signature': signature },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    const message = text.slice(0, 240).replace(/[\r\n\t]/g, ' ');
    throw Object.assign(new Error(`Agent rejected operation (${response.status}): ${message}`), { permanent: response.status >= 400 && response.status < 500 && response.status !== 429 });
  }
}

async function claimOne(prisma: PrismaClient) {
  const now = new Date();
  await prisma.job.updateMany({ where: { status: 'RUNNING', lockedUntil: { lt: now } }, data: { status: 'QUEUED', lockedUntil: null, availableAt: now } });
  const job = await prisma.job.findFirst({ where: { status: 'QUEUED', availableAt: { lte: now }, type: { in: ['website.create', 'website.delete', 'website.ssl.enable'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (!job) return null;
  const lockedUntil = new Date(Date.now() + LEASE_MS);
  const result = await prisma.job.updateMany({ where: { id: job.id, status: 'QUEUED', availableAt: { lte: now } }, data: { status: 'RUNNING', attempts: { increment: 1 }, lockedUntil } });
  if (result.count !== 1) return null;
  return { id: job.id, payload: job.payload, attempts: job.attempts + 1 };
}

async function complete(prisma: PrismaClient, jobId: string, payload: OperationPayload) {
  await prisma.$transaction(async (tx) => {
    const marked = await tx.job.updateMany({ where: { id: jobId, status: 'RUNNING' }, data: { status: 'SUCCEEDED', lockedUntil: null, lastError: null } });
    if (marked.count !== 1) return;
    if (payload.operation === 'website.create') {
      await tx.website.updateMany({ where: { id: payload.websiteId, ownerId: payload.ownerId, status: 'PENDING' }, data: { status: 'ACTIVE' } });
    } else if (payload.operation === 'website.delete') {
      await tx.website.deleteMany({ where: { id: payload.websiteId, ownerId: payload.ownerId, status: 'SUSPENDED' } });
    } else {
      await tx.website.updateMany({ where: { id: payload.websiteId, ownerId: payload.ownerId, status: 'ACTIVE', tlsStatus: 'pending' }, data: { tlsStatus: 'active' } });
    }
    const action = payload.operation === 'website.create' ? 'website.provisioned' : payload.operation === 'website.delete' ? 'website.deleted' : 'website.tls_enabled';
    await tx.auditLog.create({ data: { actorId: payload.ownerId, action, resource: 'website', resourceId: payload.websiteId, metadata: { domain: payload.primaryDomain, nodeId: payload.nodeId } } });
  });
}

async function fail(prisma: PrismaClient, jobId: string, attempts: number, payload: OperationPayload | null, error: unknown) {
  const detail = error instanceof Error ? error.message.slice(0, 500) : 'Unknown agent operation failure.';
  const permanent = Boolean(error && typeof error === 'object' && 'permanent' in error && error.permanent);
  const terminal = permanent || attempts >= MAX_ATTEMPTS;
  const availableAt = new Date(Date.now() + Math.min(300_000, 2 ** attempts * 2_000));
  await prisma.$transaction(async (tx) => {
    const updated = await tx.job.updateMany({ where: { id: jobId, status: 'RUNNING' }, data: { status: terminal ? 'FAILED' : 'QUEUED', lockedUntil: null, availableAt, lastError: detail } });
    if (updated.count !== 1 || !terminal || !payload) return;
    if (payload.operation === 'website.create') await tx.website.updateMany({ where: { id: payload.websiteId, status: 'PENDING' }, data: { status: 'FAILED' } });
    else if (payload.operation === 'website.delete') await tx.website.updateMany({ where: { id: payload.websiteId, status: 'SUSPENDED' }, data: { status: 'FAILED' } });
    else await tx.website.updateMany({ where: { id: payload.websiteId, tlsStatus: 'pending' }, data: { tlsStatus: 'failed' } });
    const action = payload.operation === 'website.ssl.enable' ? 'website.tls_failed' : 'website.provisioning_failed';
    await tx.auditLog.create({ data: { actorId: payload.ownerId, action, resource: 'website', resourceId: payload.websiteId, metadata: { domain: payload.primaryDomain, nodeId: payload.nodeId, reason: detail } } });
  });
}

export function startProvisioningWorker(prisma: PrismaClient) {
  let running = false;
  let lastNonceCleanup = 0;
  let lastNodeHealthSweep = 0;
  let cooldownUntil = 0;
  const tick = async () => {
    if (running || Date.now() < cooldownUntil) return;
    running = true;
    try {
      if (Date.now() - lastNonceCleanup > 3_600_000) {
        await prisma.agentNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } });
        lastNonceCleanup = Date.now();
      }
      if (Date.now() - lastNodeHealthSweep > 30_000) {
        const cutoff = new Date(Date.now() - 90_000);
        const stale = await prisma.node.findMany({ where: { status: 'online', lastHeartbeat: { lt: cutoff } }, select: { id: true, hostname: true } });
        for (const node of stale) {
          const changed = await prisma.node.updateMany({ where: { id: node.id, status: 'online', lastHeartbeat: { lt: cutoff } }, data: { status: 'offline' } });
          if (changed.count) await prisma.auditLog.create({ data: { action: 'node.heartbeat_lost', resource: 'node', resourceId: node.id, metadata: { hostname: node.hostname } } });
        }
        lastNodeHealthSweep = Date.now();
      }
      const job = await claimOne(prisma);
      if (!job) return;
      const payload = parsePayload(job.payload);
      try {
        await deliver(prisma, job);
        if (payload) await complete(prisma, job.id, payload);
        else throw new Error('Invalid provisioning job payload.');
      } catch (error) {
        console.error(`[provisioner] job ${job.id} attempt ${job.attempts} failed:`, error instanceof Error ? error.message : 'unknown error');
        await fail(prisma, job.id, job.attempts, payload, error);
      }
    } catch (error) {
      cooldownUntil = Date.now() + 5_000;
      console.error('[provisioner] worker cycle failed:', error instanceof Error ? error.message : 'unknown error');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 1_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
