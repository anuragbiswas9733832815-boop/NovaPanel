import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = process.env.NOVA_ENV_FILE ? resolve(process.env.NOVA_ENV_FILE) : resolve(root, 'apps/api/.env');
const examplePath = resolve(root, 'apps/api/.env.example');
await mkdir(dirname(envPath), { recursive: true });
let source;
try { source = await readFile(envPath, 'utf8'); }
catch { source = await readFile(examplePath, 'utf8'); }

function readValue(key) {
  const match = source.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
}
function writeValue(key, value) {
  const line = `${key}="${value}"`;
  const expression = new RegExp(`^${key}=.*$`, 'm');
  source = expression.test(source) ? source.replace(expression, line) : `${source.trimEnd()}\n${line}\n`;
}
function usable(value, minimum) {
  return value.length >= minimum && !/^(replace|change|local-development-secret)/i.test(value);
}
const original = source;
if (!usable(readValue('JWT_SECRET'), 32)) writeValue('JWT_SECRET', randomBytes(48).toString('base64url'));
const encryptionKey = readValue('NODE_ENCRYPTION_KEY');
let validEncryptionKey = false;
try { validEncryptionKey = Buffer.from(encryptionKey, 'base64').length === 32; } catch { /* generate below */ }
if (!validEncryptionKey || /^(replace|change)/i.test(encryptionKey)) writeValue('NODE_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
if (!usable(readValue('NOVA_INSTALLER_TOKEN'), 32)) writeValue('NOVA_INSTALLER_TOKEN', randomBytes(48).toString('base64url'));
if (source === original) {
  if (!process.env.NOVA_ENV_FILE) await chmod(envPath, 0o600);
  console.log(`Persistent API secrets are present in ${envPath}.`);
  process.exit(0);
}

const temporary = `${envPath}.tmp-${process.pid}`;
const handle = await open(temporary, 'wx', 0o600);
try { await handle.writeFile(source, 'utf8'); await handle.sync(); }
finally { await handle.close(); }
await chmod(temporary, 0o600);
await rename(temporary, envPath);
console.log(`Persistent API secrets are present in ${envPath} (mode 0600). Back up this file securely; losing NODE_ENCRYPTION_KEY invalidates encrypted node credentials.`);
