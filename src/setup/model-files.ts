import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import type { DownloadSpec } from './download.js';

export const MAX_MODEL_BYTES = 20 * 1024 ** 3;
export class TransferError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly retryable = false) { super(message); }
}
export function regularFile(path: string) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TransferError('unsafe_file', 'The model path must be a regular file, not a symbolic link.');
    return stat;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function privateDirectory(dir: string, create = false): string {
  if (create) mkdirSync(dir, { recursive: true });
  const root = create ? realpathSync(dir) : resolve(dir);
  const path = join(root, '.downloads');
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TransferError('unsafe_directory', 'The model transfer directory is unsafe.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return path;
}
export function artifactPaths(spec: Pick<DownloadSpec, 'filename'>, dir: string, create = false) {
  if (basename(spec.filename) !== spec.filename || !/^[\w.-]+\.gguf$/.test(spec.filename)) throw new TransferError('invalid_filename', 'Invalid catalogue model filename.');
  const folder = privateDirectory(dir, create);
  return { destination: join(resolve(dir), spec.filename), partial: join(folder, `${spec.filename}.part`), resume: join(folder, `${spec.filename}.resume.json`), receipt: join(folder, `${spec.filename}.receipt.json`) };
}
export function readTransferJSON(path: string): unknown | null {
  if (!regularFile(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new TransferError('transfer_state_unreadable', 'The saved model transfer state is unreadable. Restore it before downloading.', 409); }
}
export function writeTransferJSON(path: string, data: unknown): void {
  regularFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (regularFile(temporary)) unlinkSync(temporary); }
}
export function removeTransferFile(path: string): void { if (regularFile(path)) unlinkSync(path); }
export function checkModelSpace(dir: string, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_MODEL_BYTES) throw new TransferError('model_too_large', 'Model files must be at most 20 GiB.');
  mkdirSync(dir, { recursive: true });
  const disk = statfsSync(dir);
  if (disk.bavail * disk.bsize < bytes + 512 * 1024 ** 2) throw new TransferError('insufficient_space', 'There is not enough free disk space for this model.');
}
export function inspectModelGGUF(path: string): void {
  regularFile(path);
  const header = Buffer.alloc(24);
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (readSync(file, header, 0, 24, 0) !== 24 || header.toString('ascii', 0, 4) !== 'GGUF') throw new TransferError('invalid_gguf', 'Choose a GGUF model file');
    if (![2, 3].includes(header.readUInt32LE(4)) || header.readBigUInt64LE(8) === 0n || header.readBigUInt64LE(16) === 0n) throw new TransferError('invalid_gguf', 'This GGUF header is unsupported or incomplete');
  } finally { closeSync(file); }
}
export const receiptSchema = z.object({ version: z.literal(1), fingerprint: z.string(), bytes: z.number().int().positive().max(MAX_MODEL_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), mtimeMs: z.number(), completedAt: z.string() });
export const resumeSchema = z.object({ version: z.literal(1), fingerprint: z.string(), total: z.number().int().positive().max(MAX_MODEL_BYTES), etag: z.string().nullable(), verified: receiptSchema.optional() });
export type ModelReceipt = z.infer<typeof receiptSchema>;
export function sourceFingerprint(spec: DownloadSpec): string { return createHash('sha256').update(JSON.stringify([spec.role, spec.filename, spec.url])).digest('hex'); }
export async function hashModelFile(path: string, signal: AbortSignal): Promise<string> {
  regularFile(path);
  const hash = createHash('sha256');
  // Opened by descriptor so a link swapped in after the check above is refused
  // rather than followed; streamed so a 5 GB file never blocks the event loop.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    for await (const chunk of file.createReadStream({ signal, autoClose: false })) { signal.throwIfAborted(); hash.update(chunk as Buffer); }
  } finally { await file.close(); }
  return hash.digest('hex');
}
export function installedModel(spec: DownloadSpec, dir: string) {
  const absent = { onDisk: false, verifiedDownload: false, bytes: null as number | null, downloadBlockedReason: null as string | null };
  try {
    const paths = artifactPaths(spec, dir);
    const stat = regularFile(paths.destination);
    if (!stat) return absent;
    const receipt = readTransferJSON(paths.receipt);
    if (receipt !== null) {
      const parsed = receiptSchema.safeParse(receipt);
      if (!parsed.success || parsed.data.fingerprint !== sourceFingerprint(spec) || parsed.data.bytes !== stat.size || parsed.data.mtimeMs !== stat.mtimeMs) throw new Error('Invalid installed receipt');
      inspectModelGGUF(paths.destination);
      return { ...absent, onDisk: true, verifiedDownload: true, bytes: stat.size };
    }
    if (readTransferJSON(paths.resume) !== null || stat.size < spec.approxMB * 1e6 * 0.9) throw new Error('Incomplete model');
    inspectModelGGUF(paths.destination);
    return { ...absent, onDisk: true, bytes: stat.size };
  } catch {
    return { ...absent, downloadBlockedReason: 'An existing model file requires repair. It will not be overwritten.' };
  }
}
/** A final file whose receipt was never written: the process died between the
 * two. `installedModel` reports it blocked, correctly, until it is reconciled. */
export function publishedCandidate(spec: DownloadSpec, dir: string): boolean {
  try {
    const paths = artifactPaths(spec, dir);
    if (!regularFile(paths.destination) || regularFile(paths.receipt)) return false;
    return resumeSchema.safeParse(readTransferJSON(paths.resume)).data?.verified !== undefined;
  } catch { return false; }
}
export function publicTransferError(error: unknown): TransferError {
  if (error instanceof TransferError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC') return new TransferError('insufficient_space', 'There is not enough free disk space for this model.');
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new TransferError('model_directory_unwritable', 'The gateway cannot write to its model directory. Check its permissions.');
  if (code === 'EEXIST') return new TransferError('existing_file_invalid', 'A model file already exists. It will not be overwritten.', 409);
  return new TransferError('download_failed', 'The model download failed. Check the connection and retry.', 400, true);
}
