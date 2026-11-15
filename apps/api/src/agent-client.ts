import { randomUUID } from 'node:crypto';
import { decryptNodeSecret, signAgentRequest } from './agent-auth.js';

export type AgentOperation = {
  operation: string;
  siteId: string;
  domain: string;
  path?: string;
  newPath?: string;
  contentBase64?: string;
};

type AgentNode = { id: string; agentUrl: string | null; agentSecretCiphertext: string | null; lastHeartbeat?: Date | null; status?: string };

export async function callAgent(node: AgentNode, operation: AgentOperation) {
  if (!node.agentUrl || !node.agentSecretCiphertext) throw new Error('Hosting node agent is not enrolled.');
  if (node.status && node.status !== 'online') throw new Error('Hosting node is offline.');
  if (node.lastHeartbeat && Date.now() - node.lastHeartbeat.getTime() > 90_000) throw new Error('Hosting node heartbeat is stale.');
  const endpoint = new URL('/v1/operations', node.agentUrl);
  if (endpoint.protocol !== 'https:') throw new Error('Node agent endpoint must use HTTPS.');
  const requestId = randomUUID().replaceAll('-', '');
  const body = Buffer.from(JSON.stringify({ ...operation, requestId }));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID().replaceAll('-', '');
  const signature = signAgentRequest(decryptNodeSecret(node.agentSecretCiphertext), 'POST', endpoint.pathname, timestamp, nonce, body);
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(operation.operation === 'website.ssl.enable' ? 150_000 : 15_000), headers: { 'content-type': 'application/json', 'x-nova-timestamp': timestamp, 'x-nova-nonce': nonce, 'x-nova-signature': signature }, body });
  const maxResponseBytes = 4 * 1024 * 1024;
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > maxResponseBytes) throw new Error('Node agent response exceeded the response size limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Node agent returned an empty response stream.');
  const chunks: Uint8Array[] = [];
  let responseSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    responseSize += value.byteLength;
    if (responseSize > maxResponseBytes) { await reader.cancel(); throw new Error('Node agent response exceeded the response size limit.'); }
    chunks.push(value);
  }
  const responseBytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), responseSize);
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(responseBytes.toString('utf8')) as Record<string, unknown>; } catch { /* expose only a generic protocol error */ }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error.slice(0, 240) : `Node agent returned HTTP ${response.status}.`);
  return data;
}
