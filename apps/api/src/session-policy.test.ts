import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionAccessBlockReason } from './session-policy.js';

const active = { sessionVersion: 4, disabledAt: null, mustChangePassword: false };

test('session version changes revoke stale tokens', () => {
  assert.equal(sessionAccessBlockReason(3, active), 'stale-session');
  assert.equal(sessionAccessBlockReason(4, active), null);
});

test('disabled accounts are blocked even during password setup', () => {
  const suspended = { ...active, disabledAt: new Date() };
  assert.equal(sessionAccessBlockReason(4, suspended, true), 'account-disabled');
});

test('temporary credentials can only access the password setup route', () => {
  const needsSetup = { ...active, mustChangePassword: true };
  assert.equal(sessionAccessBlockReason(4, needsSetup), 'password-change-required');
  assert.equal(sessionAccessBlockReason(4, needsSetup, true), null);
});
