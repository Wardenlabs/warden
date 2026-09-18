/** Bounded disk streaming for weights. A partial file never becomes a catalogue
 * entry; import paths are server-owned UUIDs, independent of supplied names. */
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns';
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, closeSync, readSync, renameSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { get } from 'node:https';
import { isIP } from 'node:net';
import { basename, isAbsolute, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { formatSchema, managedModelsDir, managedRoleSchema, modelPath, putModel, type LocalModel } from './store.js';

export const MAX_MODEL_BYTES = 20 * 1024 ** 3;
export const importMetadata = z.object({ name: z.string().trim().min(1).max(100),
  roles: z.array(managedRoleSchema).min(1).max(2), format: formatSchema,
  filename: z.string().max(255).optional() }).refine(m => !['shieldstral', 'granite-guardian'].includes(m.format) || !m.roles.includes('compiler'), { message: 'Native guard models are analyzer-only' });
type Metadata = z.infer<typeof importMetadata>;
export type DownloadJob = { id: string; name: string; state: 'downloading' | 'complete' | 'failed' | 'cancelled'; received: number; total: number | null; modelId: string | null; error: string | null };
const jobs = new Map<string, { public: DownloadJob; controller: AbortController }>();
let busy = false;

function enter(): () => void {
  if (busy) throw new Error('Another model is being imported. Finish or cancel it first.');
  busy = true;
  return () => { busy = false; };
}
function remove(path: string): void { if (existsSync(path)) unlinkSync(path); }
function checkSpace(bytes: number): void {
  mkdirSync(managedModelsDir(), { recursive: true });
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_MODEL_BYTES) throw new Error('Model files must be at most 20 GB');
  const disk = statfsSync(managedModelsDir());
  if (disk.bavail * disk.bsize < bytes + 512 * 1024 ** 2) throw new Error('There is not enough free disk space for this model');
}
export function inspectGGUF(path: string): void {
  const header = Buffer.alloc(24);
  const file = openSync(path, 'r');
  try {
    if (readSync(file, header, 0, 24, 0) !== 24 || header.toString('ascii', 0, 4) !== 'GGUF') throw new Error('Choose a GGUF model file');
    if (![2, 3].includes(header.readUInt32LE(4)) || header.readBigUInt64LE(8) === 0n || header.readBigUInt64LE(16) === 0n) {
      throw new Error('This GGUF header is unsupported or incomplete');
    }
  } finally { closeSync(file); }
}

async function receive(source: Readable, metadata: Metadata, signal: AbortSignal, expected: number | null,
  progress?: (received: number) => void): Promise<LocalModel> {
  checkSpace(expected ?? 0);
  const id = randomUUID();
  const temporary = join(managedModelsDir(), `${id}.part`);
  const destination = modelPath({ id });
  const hash = createHash('sha256');
  let bytes = 0;
  let spaceAt = 0;
  const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > MAX_MODEL_BYTES || (expected !== null && bytes > expected)) return callback(new Error('The model exceeds its declared size or the 20 GB limit'));
    try {
      if (bytes - spaceAt > 64 * 1024 ** 2) { checkSpace(0); spaceAt = bytes; }
      hash.update(chunk); progress?.(bytes); callback(null, chunk);
    } catch (error) { callback(error as Error); }
  } });
  try {
    await pipeline(source, counter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    if (expected !== null && bytes !== expected) throw new Error('The model transfer ended before the file was complete');
    inspectGGUF(temporary);
    renameSync(temporary, destination);
    const model: LocalModel = { id, kind: 'local', name: metadata.name, roles: [...new Set(metadata.roles)],
      format: metadata.format, filename: basename(metadata.filename ?? `${metadata.name}.gguf`), bytes,
      sha256: hash.digest('hex'), mtimeMs: statSync(destination).mtimeMs, revision: 1, tests: {} };
    return putModel(model) as LocalModel;
  } catch (error) { remove(destination); throw error; }
  finally { remove(temporary); }
}

export async function importLocalFile(path: string, raw: unknown): Promise<LocalModel> {
  const metadata = importMetadata.parse(raw);
  if (!isAbsolute(path)) throw new Error('Use an absolute path to a GGUF file on the gateway machine');
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error('Choose a regular GGUF file');
  inspectGGUF(path);
  const leave = enter();
  try { return await receive(createReadStream(path), { ...metadata, filename: basename(path) }, AbortSignal.timeout(30 * 60_000), stat.size); }
  finally { leave(); }
}

export async function importUpload(source: Readable, raw: unknown, signal: AbortSignal, expected: number | null): Promise<LocalModel> {
  const metadata = importMetadata.parse(raw);
  const leave = enter();
  try { return await receive(source, metadata, AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]), expected); }
  finally { leave(); }
}

/** Resolve and pin a public address for every HTTPS hop. A remote admin may
 * download weights, but that is not a capability to read gateway-local URLs or
 * cloud metadata through a redirect or a DNS rebinding. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) !== 6) return false;
  const a = address.toLowerCase();
  // Global unicast only. IPv4-mapped and transition address spaces can hide
  // loopback/private addresses and have no place in a weight download.
  return /^[23]/.test(a) && !a.startsWith('2001:') && !a.startsWith('2002:');
}

function downloadResponse(raw: string, signal: AbortSignal, redirects = 0): Promise<import('node:http').IncomingMessage> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || redirects > 5) throw new Error('Use a public HTTPS download URL without credentials');
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !publicAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Model downloads require a public internet address');
  return new Promise((resolve, reject) => {
    const req = get(url, { signal, lookup(hostname, options, callback) {
      lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return callback(error, '', 4);
        if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) return callback(new Error('Model downloads require a public internet address'), '', 4);
        const first = addresses[0]!;
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      });
    } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume();
        try { resolve(downloadResponse(new URL(response.headers.location, url).href, signal, redirects + 1)); } catch (error) { reject(error); }
      } else if (response.statusCode !== 200) {
        response.resume(); reject(new Error(`Model download returned HTTP ${response.statusCode}`));
      } else resolve(response);
    });
    req.setTimeout(30_000, () => req.destroy(new Error('The model download stopped responding')));
    req.on('error', reject);
  });
}

export function downloadJobs(): DownloadJob[] { return [...jobs.values()].map((j) => ({ ...j.public })); }
export function cancelDownload(id: string): void {
  const job = jobs.get(id);
  if (!job) throw new Error('Download not found');
  if (job.public.state === 'downloading') job.controller.abort();
}
export function startDownload(raw: unknown): DownloadJob {
  const input = importMetadata.extend({ url: z.string().url().max(2000) }).parse(raw);
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a public HTTPS download URL without credentials');
  const leave = enter();
  // Keep progress bounded in memory even if this gateway runs for months.
  for (const [id, job] of jobs) { if (jobs.size < 20) break; if (job.public.state !== 'downloading') jobs.delete(id); }
  const controller = new AbortController();
  const job: DownloadJob = { id: randomUUID(), name: input.name, state: 'downloading', received: 0, total: null, modelId: null, error: null };
  jobs.set(job.id, { public: job, controller });
  void (async () => {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await downloadResponse(input.url, signal);
          const length = response.headers['content-length'];
          job.total = length === undefined ? null : Number(length);
          job.received = 0;
          const model = await receive(response, { ...input, filename: input.filename ?? basename(url.pathname) }, signal, job.total, (n) => { job.received = n; });
          job.modelId = model.id; job.state = 'complete'; break;
        } catch (error) {
          if (attempt >= 2 || signal.aborted || !/socket|reset|responding|premature|ECONN|ETIMEDOUT/i.test(String(error))) throw error;
        }
      }
    } catch (error) {
      job.state = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = controller.signal.aborted ? null : (error instanceof Error ? error.message : 'Download failed');
    } finally { leave(); }
  })();
  return { ...job };
}
