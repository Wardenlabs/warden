import { safeStorage } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Called after app.whenReady(). Never accept Electron's plaintext Linux
 * backend as an OS vault. Headless Linux can use an operator-managed key file. */
export function credentialEnvironment(userData: string): Record<string, string> {
  if (process.env['WARDEN_CREDENTIAL_KEY']) return { WARDEN_CREDENTIAL_KEY: process.env['WARDEN_CREDENTIAL_KEY'] };
  if (process.env['WARDEN_CREDENTIAL_KEY_PATH']) return { WARDEN_CREDENTIAL_KEY_PATH: process.env['WARDEN_CREDENTIAL_KEY_PATH'] };
  const wrappedPath = join(userData, 'credential-key.encrypted');
  const available = safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  const identity = createHash('sha256').update(resolve(userData)).digest('hex').slice(0, 20);
  const keyPath = join(homedir(), '.warden', 'keys', `desktop-${identity}.key`);
  if (!available) {
    if (existsSync(wrappedPath)) throw new Error('Unlock the operating system credential store before starting Warden.');
    console.warn('[warden] OS credential storage is unavailable; using a private key file outside the data directory. Protect this file and its backups.');
    return { WARDEN_CREDENTIAL_KEY_PATH: keyPath };
  }
  // Preserve a file-backed installation when a keyring becomes available.
  // Switching to an unrelated key would make its existing data unreadable.
  if (existsSync(keyPath) && !existsSync(wrappedPath)) return { WARDEN_CREDENTIAL_KEY_PATH: keyPath };
  let key: string;
  if (existsSync(wrappedPath)) {
    key = safeStorage.decryptString(readFileSync(wrappedPath));
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('The saved credential key is invalid. Restore the original key file.');
  } else {
    key = randomBytes(32).toString('hex');
    mkdirSync(userData, { recursive: true, mode: 0o700 });
    writeFileSync(wrappedPath, safeStorage.encryptString(key), { flag: 'wx', mode: 0o600 });
  }
  return { WARDEN_CREDENTIAL_KEY: key };
}
