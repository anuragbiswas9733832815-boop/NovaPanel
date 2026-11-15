import { z } from 'zod';

export const customerInput = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  websiteLimit: z.number().int().min(1).max(1000).default(5),
});

export const customerStatusInput = z.object({ active: z.boolean() });

export const passwordChangeInput = z.object({
  currentPassword: z.string().max(128).optional(),
  newPassword: z.string().min(12).max(128),
});

export const loginInput = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});

const dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const websiteInput = z.object({
  primaryDomain: z.string().trim().toLowerCase().regex(dnsName),
  runtime: z.literal('static').default('static'),
});

const agentUrlInput = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/' || url.pathname === '');
  } catch { return false; }
}, 'Agent URL must be HTTPS and must not contain credentials, query strings, or fragments.');
export const localAgentUrlInput = z.object({ agentUrl: agentUrlInput });
export const nodeRegistrationInput = z.object({
  name: z.string().trim().min(2).max(80),
  hostname: z.string().trim().min(1).max(253),
  region: z.string().trim().max(80).optional(),
  agentUrl: agentUrlInput,
});

const byteCounter = z.string().regex(/^\d{1,20}$/);
const relativeFilePath = z.string().min(1).max(1024).refine((value) => !value.startsWith('/') && !value.includes('\\') && !value.includes('\u0000') && !value.split('/').includes('..'), 'File paths must stay inside the website document root.');
export const fileReadQuery = z.object({ action: z.enum(['list', 'read']).default('list'), path: z.string().max(1024).default('') }).refine((value) => value.action !== 'read' || (value.path.length > 0 && relativeFilePath.safeParse(value.path).success), 'A safe file path is required for reads.').refine((value) => value.action !== 'list' || value.path === '' || relativeFilePath.safeParse(value.path).success, 'Invalid directory path.');
export const fileMutationInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('files.write'), path: relativeFilePath.min(1), contentBase64: z.string().max(11_184_812).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }),
  z.object({ operation: z.literal('files.mkdir'), path: relativeFilePath.min(1) }),
  z.object({ operation: z.literal('files.delete'), path: relativeFilePath.min(1) }),
  z.object({ operation: z.literal('files.rename'), path: relativeFilePath.min(1), newPath: relativeFilePath.min(1) }),
]);

export const jobListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  status: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']).optional(),
});

export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_.-]*$/).optional(),
});

export const heartbeatInput = z.object({
  agentVersion: z.string().min(1).max(40),
  cpuPercent: z.number().finite().min(0).max(100),
  memoryUsed: byteCounter,
  memoryTotal: byteCounter,
  diskUsed: byteCounter,
  diskTotal: byteCounter,
  networkRxBytes: byteCounter,
  networkTxBytes: byteCounter,
  hostname: z.string().min(1).max(253).optional(),
  operatingSystem: z.string().min(1).max(120).optional(),
  cpuCores: z.number().int().min(1).max(4096).optional(),
  ipAddresses: z.array(z.string().min(2).max(45)).max(32).optional(),
  systemInfo: z.object({ architecture: z.string().max(40), virtualization: z.string().max(80), services: z.array(z.string().max(60)).max(32) }).optional(),
}).refine((value) => {
  const maximum = 9_223_372_036_854_775_807n;
  const counters = [value.memoryUsed, value.memoryTotal, value.diskUsed, value.diskTotal, value.networkRxBytes, value.networkTxBytes].map(BigInt);
  return BigInt(value.memoryUsed) <= BigInt(value.memoryTotal) && BigInt(value.diskUsed) <= BigInt(value.diskTotal) && counters.every((counter) => counter <= maximum);
}, 'Resource counters are out of range.');
