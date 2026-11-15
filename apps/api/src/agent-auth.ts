import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CIPHER = 'aes-256-gcm';
const MAX_CLOCK_SKEW_SECONDS = 30;

function encryptionKey(): Buffer {
  const raw = process.env.NODE_ENCRYPTION_KEY;
  if (!raw) throw new Error('NODE_ENCRYPTION_KEY is required for node secrets.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('NODE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return key;
}

export function encryptNodeSecret(secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

export function decryptNodeSecret(value: string): Buffer {
  const [version, ivText, tagText, dataText] = value.split('.');
  if (version !== 'v1' || !ivText || !tagText || !dataText) throw new Error('Unsupported encrypted node secret.');
  const decipher = createDecipheriv(CIPHER, encryptionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]);
}

export function signAgentRequest(secret: Buffer, method: string, requestPath: string, timestamp: string, nonce: string, body: Buffer): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${method.toUpperCase()}\n${requestPath}\n${bodyHash}`).digest('hex');
}

export function verifyAgentRequest(secret: Buffer, method: string, requestPath: string, body: Buffer, headers: { timestamp?: string; nonce?: string; signature?: string }): { ok: true; nonce: string } | { ok: false; reason: string } {
  const { timestamp, nonce, signature } = headers;
  if (!timestamp || !nonce || !signature || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{32,64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return { ok: false, reason: 'Missing or malformed signature headers.' };
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'Signed request is outside the allowed time window.' };
  const expected = Buffer.from(signAgentRequest(secret, method, requestPath, timestamp, nonce, body), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return { ok: false, reason: 'Invalid signature.' };
  return { ok: true, nonce };
}
