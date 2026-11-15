import test from 'node:test';
import assert from 'node:assert/strict';
import { activityQuery, customerInput, customerStatusInput, fileMutationInput, fileReadQuery, heartbeatInput, jobListQuery, loginInput, localAgentUrlInput, nodeRegistrationInput, passwordChangeInput, websiteInput } from './validation.js';

test('customer status changes accept explicit booleans only', () => {
  assert.equal(customerStatusInput.safeParse({ active: false }).success, true);
  assert.equal(customerStatusInput.safeParse({ active: 'false' }).success, false);
  assert.equal(customerStatusInput.safeParse({ active: 1 }).success, false);
});

test('customer onboarding and password changes enforce bounded, strong inputs', () => {
  assert.equal(customerInput.safeParse({ name: 'Customer', email: 'user@example.test' }).data?.websiteLimit, 5);
  assert.equal(customerInput.safeParse({ name: 'Customer', email: 'user@example.test', websiteLimit: 100 }).success, true);
  assert.equal(customerInput.safeParse({ name: 'Customer', email: 'user@example.test', websiteLimit: 1001 }).success, false);
  assert.equal(customerInput.safeParse({ name: 'x', email: 'not-an-email' }).success, false);
  assert.equal(passwordChangeInput.safeParse({ newPassword: 'correct horse battery' }).success, true);
  assert.equal(passwordChangeInput.safeParse({ currentPassword: 'x', newPassword: 'short' }).success, false);
});

test('login accepts a bounded username or email identifier and a bounded password', () => {
  assert.equal(loginInput.safeParse({ identifier: 'admin', password: 'x' }).success, true);
  assert.equal(loginInput.safeParse({ identifier: 'admin@example.test', password: 'x' }).success, true);
  assert.equal(loginInput.safeParse({ identifier: '', password: 'x' }).success, false);
  assert.equal(loginInput.safeParse({ identifier: 'admin', password: 'x'.repeat(129) }).success, false);
});

test('website provisioning accepts canonical DNS names, not config injection', () => {
  assert.equal(websiteInput.safeParse({ primaryDomain: 'WWW.Example.com' }).data?.primaryDomain, 'www.example.com');
  assert.equal(websiteInput.safeParse({ primaryDomain: 'bad.example.com;return 200' }).success, false);
  assert.equal(websiteInput.safeParse({ primaryDomain: '*.example.com' }).success, false);
});

test('node registration requires HTTPS and rejects URL credentials', () => {
  const base = { name: 'node one', hostname: 'node.example.net', agentUrl: 'https://node.example.net:8443' };
  assert.equal(nodeRegistrationInput.safeParse(base).success, true);
  assert.equal(nodeRegistrationInput.safeParse({ ...base, agentUrl: 'http://node.example.net:8443' }).success, false);
  assert.equal(nodeRegistrationInput.safeParse({ ...base, agentUrl: 'https://user:pass@node.example.net' }).success, false);
  assert.equal(localAgentUrlInput.safeParse({ agentUrl: 'https://agent.example.net:8443' }).success, true);
  assert.equal(localAgentUrlInput.safeParse({ agentUrl: 'http://127.0.0.1:8443' }).success, false);
  assert.equal(localAgentUrlInput.safeParse({ agentUrl: 'https://agent.example.net/operations' }).success, false);
});

test('file manager blocks traversal and caps content inputs', () => {
  assert.equal(fileReadQuery.safeParse({ action: 'list', path: 'assets' }).success, true);
  assert.equal(fileReadQuery.safeParse({ action: 'read', path: '../outside' }).success, false);
  assert.equal(fileReadQuery.safeParse({ action: 'list', path: '/etc' }).success, false);
  assert.equal(fileMutationInput.safeParse({ operation: 'files.write', path: 'index.html', contentBase64: 'PGgxPjwvSDE+' }).success, true);
  assert.equal(fileMutationInput.safeParse({ operation: 'files.delete', path: '../secret' }).success, false);
});

test('job list query caps page size and accepts only known statuses', () => {
  assert.deepEqual(jobListQuery.safeParse({}).data, { limit: 30 });
  assert.equal(jobListQuery.safeParse({ limit: '100', status: 'FAILED' }).success, true);
  assert.equal(jobListQuery.safeParse({ limit: '101' }).success, false);
  assert.equal(jobListQuery.safeParse({ status: 'SECRET' }).success, false);
});

test('activity log filters and page sizes are bounded', () => {
  assert.deepEqual(activityQuery.safeParse({}).data, { limit: 50 });
  assert.equal(activityQuery.safeParse({ limit: '100', action: 'website.provisioned' }).success, true);
  assert.equal(activityQuery.safeParse({ limit: '1000' }).success, false);
  assert.equal(activityQuery.safeParse({ action: 'website.provisioned; DROP TABLE' }).success, false);
});

test('heartbeat telemetry is bounded and used capacity cannot exceed totals', () => {
  const sample = { agentVersion: '0.2.0', cpuPercent: 7.25, memoryUsed: '100', memoryTotal: '200', diskUsed: '10', diskTotal: '20', networkRxBytes: '0', networkTxBytes: '0', hostname: 'node.example.test', operatingSystem: 'linux', cpuCores: 4, ipAddresses: ['192.0.2.1'], systemInfo: { architecture: 'amd64', virtualization: 'kvm', services: ['nginx', 'certbot'] } };
  assert.equal(heartbeatInput.safeParse(sample).success, true);
  assert.equal(heartbeatInput.safeParse({ ...sample, cpuPercent: 101 }).success, false);
  assert.equal(heartbeatInput.safeParse({ ...sample, memoryUsed: '300' }).success, false);
});
