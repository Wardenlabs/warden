/** Bounded disk streaming for weights. A partial file never becomes a catalogue
 * entry; import paths are server-owned UUIDs, independent of supplied names. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { checkModelSpace, inspectModelGGUF, MAX_MODEL_BYTES } from '../setup/model-files.js';
import { requestModel, requireModelResponse } from '../setup/model-http.js';
import { acquireTransfer } from '../setup/transfer-lock.js';
import { formatSchema, managedModelsDir, managedRoleSchema, modelPath, modelsRoot, putModel, type LocalModel } from './store.js';

// The limits, the GGUF check and the pinned-address transport moved to
// `src/setup/` on 2026-09-20 so built-in downloads run under the same ones.
// Re-exported because the routes and the regression suite name them from here.
export { MAX_MODEL_BYTES };
export { publicAddress } from '../setup/model-http.js';
export const inspectGGUF = inspectModelGGUF;
export const importMetadata = z.object({ name: z.string().trim().min(1).max(100),
  roles: z.array(managedRoleSchema).min(1).max(2), format: formatSchema,
  filename: z.string().max(255).optional() }).refine(m => !['shieldstral', 'granite-guardian'].includes(m.format) || !m.roles.includes('compiler'), { message: 'Native guard models are analyzer-only' });
type Metadata = z.infer<typeof importMetadata>;
export type DownloadJob = { id: string; name: string; state: 'downloading' | 'complete' | 'failed' | 'cancelled'; received: number; total: number | null; modelId: string | null; error: string | null };
const jobs = new Map<string, { public: DownloadJob; controller: AbortController }>();

/** One writer per models directory, whoever it is. This used to be a private
 * flag, which could not see a built-in download, terminal setup or the desktop
 * first run filling the same disk against the same free-space check. */
function enter(name: string, jobId: string | null = null): () => void {
  const lease = acquireTransfer(modelsRoot(), { name, source: 'custom', jobId });
  return () => lease.release();
}
function remove(path: string): void { if (existsSync(path)) unlinkSync(path); }
function checkSpace(bytes: number): void { checkModelSpace(managedModelsDir(), bytes); }

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
  const leave = enter(metadata.name);
  try { return await receive(createReadStream(path), { ...metadata, filename: basename(path) }, AbortSignal.timeout(30 * 60_000), stat.size); }
  finally { leave(); }
}

export async function importUpload(source: Readable, raw: unknown, signal: AbortSignal, expected: number | null): Promise<LocalModel> {
  const metadata = importMetadata.parse(raw);
  const leave = enter(metadata.name);
  try { return await receive(source, metadata, AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]), expected); }
  finally { leave(); }
}

/** Resolve and pin a public address for every HTTPS hop. A remote admin may
 * download weights, but that is not a capability to read gateway-local URLs or
 * cloud metadata through a redirect or a DNS rebinding. The transport itself is
 * `requestModel`; a custom URL gets no Range, so anything but 200 is a failure. */
async function downloadResponse(raw: string, signal: AbortSignal): Promise<Readable & { headers: import('node:http').IncomingHttpHeaders }> {
  const response = await requestModel(raw, 'GET', {}, signal);
  requireModelResponse(response, [200]);
  return response;
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
  const id = randomUUID();
  const leave = enter(input.name, id);
  // Keep progress bounded in memory even if this gateway runs for months.
  for (const [id, job] of jobs) { if (jobs.size < 20) break; if (job.public.state !== 'downloading') jobs.delete(id); }
  const controller = new AbortController();
  const job: DownloadJob = { id, name: input.name, state: 'downloading', received: 0, total: null, modelId: null, error: null };
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
