import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptNodeSecret, encryptNodeSecret, signAgentRequest, verifyAgentRequest } from './agent-auth.js';

process.env.NODE_ENCRYPTION_KEY = randomBytes(32).toString('base64');

test('node credentials are authenticated-encrypted at rest', () => {
  const secret = randomBytes(32);
  const ciphertext = encryptNodeSecret(secret);
  assert.notEqual(ciphertext, secret.toString('base64'));
  assert.deepEqual(decryptNodeSecret(ciphertext), secret);
});

test('agent signatures bind method, path, payload, time, and nonce', () => {
  const secret = randomBytes(32);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const body = Buffer.from('{"cpuPercent":5}');
  const signature = signAgentRequest(secret, 'POST', '/api/heartbeat', timestamp, nonce, body);
  assert.deepEqual(verifyAgentRequest(secret, 'POST', '/api/heartbeat', body, { timestamp, nonce, signature }), { ok: true, nonce });
  assert.equal(verifyAgentRequest(secret, 'POST', '/api/heartbeat', Buffer.from('{}'), { timestamp, nonce, signature }).ok, false);
  assert.equal(verifyAgentRequest(secret, 'GET', '/api/heartbeat', body, { timestamp, nonce, signature }).ok, false);
});
