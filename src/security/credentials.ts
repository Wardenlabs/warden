/** Field encryption for persisted gateway credentials. The wrapping key is
 * supplied by the desktop OS vault or kept separately by a headless operator.
 * This protects copied data files, not a compromised process or OS account. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PREFIX = 'warden:v1:';
// Consume the desktop's key before any compiler or model worker is spawned.
const suppliedKey = process.env['WARDEN_CREDENTIAL_KEY'];
delete process.env['WARDEN_CREDENTIAL_KEY'];
let cachedKey: Buffer | undefined;
export class CredentialStorageError extends Error {
  constructor() { super('Credential storage cannot be unlocked. Restore the original credential key and data; no credentials were replaced.'); }
}

function key(create: boolean): Buffer {
  if (cachedKey) return cachedKey;
  if (suppliedKey !== undefined) {
    if (!/^[a-f0-9]{64}$/i.test(suppliedKey)) throw new CredentialStorageError();
    return cachedKey = Buffer.from(suppliedKey, 'hex');
  }
  const path = process.env['WARDEN_CREDENTIAL_KEY_PATH'] ?? join(homedir(), '.warden', 'keys', 'gateway.key');
  if (!existsSync(path) && create) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw new CredentialStorageError(); }
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new CredentialStorageError();
    const value = readFileSync(fd);
    if (value.length !== 32) throw new CredentialStorageError();
    return cachedKey = value;
  } catch { throw new CredentialStorageError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function transform(value: unknown, context: string, encrypt: boolean): unknown {
  if (Array.isArray(value)) return value.map((item, i) => transform(item, `${context}/${i}`, encrypt));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    const location = `${context}/${name}`;
    if (name !== 'apiKey' || typeof item !== 'string' || !item) return [name, transform(item, location, encrypt)];
    if (encrypt) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key(true), iv);
      cipher.setAAD(Buffer.from(location));
      const ciphertext = Buffer.concat([cipher.update(item, 'utf8'), cipher.final()]);
      return [name, PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')];
    }
    if (!item.startsWith(PREFIX)) return [name, item]; // legacy migration, after schema validation
    try {
      const packed = Buffer.from(item.slice(PREFIX.length), 'base64');
      if (packed.length < 29) throw new CredentialStorageError();
      const cipher = createDecipheriv('aes-256-gcm', key(false), packed.subarray(0, 12));
      cipher.setAAD(Buffer.from(location));
      cipher.setAuthTag(packed.subarray(12, 28));
      return [name, Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]).toString('utf8')];
    } catch { throw new CredentialStorageError(); }
  }));
}

export function readCredentialJSON(path: string, context: string): unknown {
  return transform(JSON.parse(readFileSync(path, 'utf8')), context, false);
}

export function hasPlaintextCredentials(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([name, item]) => name === 'apiKey' && typeof item === 'string' &&
    item.length > 0 && !item.startsWith(PREFIX) || hasPlaintextCredentials(item));
}

export function writeCredentialJSON(path: string, value: unknown, context: string): void {
  const sealed = transform(value, context, true);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(sealed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Call only after validating the legacy document. Never rewrite corrupt data. */
export function migrateCredentialJSON(path: string, value: unknown, context: string): void {
  if (hasPlaintextCredentials(JSON.parse(readFileSync(path, 'utf8')))) writeCredentialJSON(path, value, context);
}
