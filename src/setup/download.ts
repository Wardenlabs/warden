/**
 * Model fetching, as a library.
 *
 * `pnpm run setup` and the desktop app's first-run screen download the same
 * files the same way — plain HTTPS with a Range header so an interrupted
 * 1.1 GB download resumes instead of restarting. The logic lives here once,
 * free of console output; callers render progress their own way through
 * `onProgress`.
 */
import { createWriteStream, linkSync, renameSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { artifactPaths, checkModelSpace, hashModelFile, inspectModelGGUF, installedModel, MAX_MODEL_BYTES, publicTransferError, readTransferJSON, regularFile, removeTransferFile, resumeSchema, sourceFingerprint, TransferError, writeTransferJSON } from './model-files.js';
import { requestModel, requireModelResponse, type ModelRequest } from './model-http.js';
import { acquireTransfer, validateTransferLease, type TransferLease } from './transfer-lock.js';

export type DownloadSpec = {
  role: string;
  /** Filename on disk once downloaded. */
  filename: string;
  /** Plain HTTPS source; null when the model only exists on the P2P registry. */
  url: string | null;
  /** Approximate size, for progress displays and the presence heuristic. */
  approxMB: number;
  /** Whether a gateway needs this model to judge prompts at all. */
  required: boolean;
};

export type DownloadOutcome = {
  role: string;
  file: string;
  sizeMB: number;
  ok: boolean;
  note?: string;
  code?: string;
  retryable?: boolean;
};

export type ByteProgress = { role: string; file: string; received: number; total: number };
export type DownloadPhase = 'connecting' | 'downloading' | 'retrying' | 'verifying';
export type DownloadOptions = {
  signal?: AbortSignal;
  lease?: TransferLease;
  request?: ModelRequest;
  onPhase?: (phase: DownloadPhase, attempt: number) => void;
  onPublish?: () => void;
  retryDelayMs?: number;
  timeoutMs?: number;
};

/**
 * Fetch one model into `dir`, resuming a partial file rather than restarting,
 * and retrying a dropped connection rather than giving up on the model.
 *
 * The retry is not defensive programming for its own sake. These files are
 * 0.3–1.1 GB over plain HTTPS, and a single dropped socket used to end that
 * model's download for the whole run: a real setup on a laptop came back with
 * `adjudicator terminated` and `embedder fetch failed` — the judge and the
 * retriever, the two models the guard cannot run without — while the 382 MB
 * detector beside them succeeded. Nothing was wrong with the machine or the
 * URLs; the transfers were interrupted.
 *
 * Because the resume above is real, a retry costs only the bytes that had not
 * arrived yet, which makes it the cheapest possible fix and the reason the
 * attempts are worth spending. Errors that will not improve on a second
 * attempt — a 404, a server with no content-length, a file that is not a
 * model — are not retried.
 *
 * Until 2026-09-20 this wrote straight to the final filename, which was safe
 * while only setup ran it against a stopped gateway. The console now starts it
 * inside a live one, where the resolver treats any file at the conventional
 * path as loadable weights. So bytes arrive in a private `.part`, and the
 * final name appears once, complete and checked, without replacing anything.
 */
export async function downloadModel(
  spec: DownloadSpec,
  dir: string,
  onProgress?: (p: ByteProgress) => void,
  attempts = 4,
  options: DownloadOptions = {}
): Promise<DownloadOutcome> {
  const failed = (error: TransferError): DownloadOutcome =>
    ({ role: spec.role, file: spec.filename, sizeMB: 0, ok: false, note: error.message, code: error.code, retryable: error.retryable });
  if (!spec.url) return failed(new TransferError('no_source', 'no HTTPS URL — this model can only come from the QVAC registry'));

  // One budget for the whole job: metadata, streaming, backoff and hashing.
  // Only a caller that asks gets one. Terminal and first-run setup never had a
  // ceiling, and 5 GB on a 20 Mbit line is a legitimate 35 minutes there.
  const budget = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : null;
  const signal = AbortSignal.any([options.signal, budget].filter((s): s is AbortSignal => Boolean(s)));
  let lease = options.lease;
  let last = new TransferError('download_failed', 'The model download failed. Check the connection and retry.', 400, true);
  try {
    if (lease) validateTransferLease(dir, lease);
    else lease = acquireTransfer(dir, { name: spec.filename, source: 'setup', jobId: null });
    await reconcilePublished(spec, dir, signal);
    const installed = installedModel(spec, dir);
    if (installed.onDisk) return { role: spec.role, file: spec.filename, sizeMB: Math.round((installed.bytes ?? 0) / 1e6), ok: true, note: 'cached' };
    if (installed.downloadBlockedReason) throw new TransferError('existing_file_invalid', `${installed.downloadBlockedReason} Move ${spec.filename} out of the models directory to download it again.`, 409);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await attemptDownload(spec, dir, lease, signal, attempt, onProgress, options);
      } catch (error) {
        if (signal.aborted) throw error;
        last = publicTransferError(error);
        if (!last.retryable || attempt === attempts) break;
        options.onPhase?.('retrying', attempt + 1);
        // 2s, 4s, 8s. Long enough for a flapping connection to come back,
        // short enough that a person watching a progress bar stays put.
        await sleep((options.retryDelayMs ?? 2000) * 2 ** (attempt - 1), undefined, { signal });
      }
    }
    return failed(last);
  } catch (error) {
    if (options.signal?.aborted) return failed(new TransferError('cancelled', 'The download was stopped.'));
    if (budget?.aborted) return failed(new TransferError('transfer_timeout', 'The model download exceeded its 30-minute limit. Retry to continue it.', 400, true));
    return failed(publicTransferError(error));
  } finally {
    if (lease && lease !== options.lease) lease.release();
  }
}

type Metadata = { total: number; etag: string | null };

/** A weak validator says two bodies are equivalent, not identical, and bytes
 * appended across "equivalent" files make a model that fails to load. */
function strongValidator(value: string | string[] | undefined): string | null {
  const etag = Array.isArray(value) ? value[0] : value;
  return etag && !etag.startsWith('W/') ? etag : null;
}

async function metadata(spec: DownloadSpec, request: ModelRequest, signal: AbortSignal): Promise<Metadata> {
  const head = await request(spec.url!, 'HEAD', {}, signal);
  requireModelResponse(head, [200]);
  head.destroy();
  const total = Number(head.headers['content-length']);
  if (!Number.isSafeInteger(total) || total <= 0) throw new TransferError('missing_length', 'model server did not provide a valid content-length');
  if (total > MAX_MODEL_BYTES) throw new TransferError('model_too_large', 'Model files must be at most 20 GiB.');
  return { total, etag: strongValidator(head.headers.etag) };
}

/** How many private bytes the next request may build on. Anything that cannot
 * be shown to belong to the same object is discarded, not appended to. */
function reusablePrefix(spec: DownloadSpec, dir: string, meta: Metadata): number {
  const paths = artifactPaths(spec, dir, true);
  const partial = regularFile(paths.partial);
  const saved = resumeSchema.safeParse(readTransferJSON(paths.resume));
  const same = saved.success && saved.data.fingerprint === sourceFingerprint(spec) && saved.data.total === meta.total &&
    meta.etag !== null && saved.data.etag === meta.etag;
  if (partial && same && partial.size <= meta.total) return partial.size;
  removeTransferFile(paths.partial);
  removeTransferFile(paths.resume);
  return 0;
}

async function attemptDownload(
  spec: DownloadSpec,
  dir: string,
  lease: TransferLease,
  signal: AbortSignal,
  attempt: number,
  onProgress: ((p: ByteProgress) => void) | undefined,
  options: DownloadOptions
): Promise<DownloadOutcome> {
  signal.throwIfAborted();
  const request = options.request ?? requestModel;
  const paths = artifactPaths(spec, dir, true);
  options.onPhase?.('connecting', attempt);
  const meta = await metadata(spec, request, signal);
  let offset = reusablePrefix(spec, dir, meta);
  checkModelSpace(dir, meta.total - offset);
  writeTransferJSON(paths.resume, { version: 1, fingerprint: sourceFingerprint(spec), total: meta.total, etag: meta.etag });

  if (offset < meta.total) {
    const response = await request(spec.url!, 'GET', offset > 0 ? { Range: `bytes=${offset}-`, 'If-Range': meta.etag! } : {}, signal);
    try {
      if (response.statusCode === 416) throw new TransferError('range_rejected', 'The model server refused to continue this download. Retry to start it again.');
      requireModelResponse(response, offset > 0 ? [200, 206] : [200]);
      if (response.statusCode === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range'] ?? ''));
        const length = response.headers['content-length'];
        if (!range || Number(range[1]) !== offset || Number(range[2]) !== meta.total - 1 || Number(range[3]) !== meta.total ||
          (length !== undefined && Number(length) !== meta.total - offset)) {
          throw new TransferError('range_rejected', 'The model server returned a different part of the file than was requested. Retry to start it again.');
        }
      } else {
        // The server ignored Range, or the object changed and If-Range said so.
        // Its body is the whole file: appending it to a prefix would publish
        // nothing, because the length check below would catch it, but only
        // after 5 GB of wasted transfer.
        const length = response.headers['content-length'];
        if (length !== undefined && Number(length) !== meta.total) throw new TransferError('size_changed', 'The model server reported two different sizes for this file.', 400, true);
        offset = 0;
      }
    } catch (error) {
      response.destroy();
      if (error instanceof TransferError && error.code === 'range_rejected') { removeTransferFile(paths.partial); removeTransferFile(paths.resume); }
      throw error;
    }

    let received = offset;
    let spaceAt = offset;
    options.onPhase?.('downloading', attempt);
    onProgress?.({ role: spec.role, file: spec.filename, received, total: meta.total });
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > meta.total) return callback(new TransferError('size_exceeded', 'The model server sent more data than it declared.'));
        try {
          if (received - spaceAt > 64 * 1024 ** 2) { checkModelSpace(dir, 0); spaceAt = received; }
          onProgress?.({ role: spec.role, file: spec.filename, received, total: meta.total });
          callback(null, chunk);
        } catch (error) { callback(error as Error); }
      }
    });
    regularFile(paths.partial);
    await pipeline(response, counted, createWriteStream(paths.partial, { flags: offset > 0 ? 'a' : 'w', mode: 0o600 }), { signal });
    const size = regularFile(paths.partial)?.size ?? 0;
    // A short body keeps its bytes: the next attempt resumes from them.
    if (size !== meta.total) throw new TransferError('short_response', `expected ${meta.total} bytes, received ${size}`, 400, size < meta.total);
  }

  options.onPhase?.('verifying', attempt);
  try {
    inspectModelGGUF(paths.partial);
  } catch (error) {
    removeTransferFile(paths.partial);
    removeTransferFile(paths.resume);
    throw error;
  }
  const stat = regularFile(paths.partial)!;
  // What Warden installed, not who published it: no upstream digest is pinned,
  // so this cannot be called a verified checksum and the console does not.
  const receipt = { version: 1 as const, fingerprint: sourceFingerprint(spec), bytes: stat.size,
    sha256: await hashModelFile(paths.partial, signal), mtimeMs: stat.mtimeMs, completedAt: new Date().toISOString() };
  // Recorded before the final name exists. A crash after the link and before
  // the receipt leaves a complete file with no proof beside it; this candidate
  // is what lets the next start finish the record instead of refusing the file.
  writeTransferJSON(paths.resume, { version: 1, fingerprint: receipt.fingerprint, total: meta.total, etag: meta.etag, verified: receipt });

  signal.throwIfAborted();
  options.onPublish?.();
  validateTransferLease(dir, lease);
  publish(paths.partial, paths.destination);
  writeTransferJSON(paths.receipt, receipt);
  removeTransferFile(paths.resume);
  removeTransferFile(paths.partial);
  return { role: spec.role, file: spec.filename, sizeMB: Math.round(stat.size / 1e6), ok: true };
}

/** A hard link either creates the final name or fails because one exists; it
 * cannot replace weights a gateway may have loaded. The link shares the
 * partial's inode, so the modification time the receipt recorded still holds. */
function publish(partial: string, destination: string): void {
  try {
    linkSync(partial, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // exFAT and some network mounts have no hard links. Rename replaces, so
    // look first; the transfer lease is what keeps that check honest.
    if (code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'ENOSYS') throw error;
    if (regularFile(destination)) throw new TransferError('existing_file_invalid', 'A model file already exists. It will not be overwritten.', 409);
    renameSync(partial, destination);
  }
}

/** Finish recording a file that was published just before the process died. */
async function reconcilePublished(spec: DownloadSpec, dir: string, signal: AbortSignal): Promise<void> {
  const paths = artifactPaths(spec, dir);
  if (regularFile(paths.receipt)) return;
  const candidate = resumeSchema.safeParse(readTransferJSON(paths.resume));
  const verified = candidate.success ? candidate.data.verified : undefined;
  const stat = regularFile(paths.destination);
  if (!verified || !stat || verified.fingerprint !== sourceFingerprint(spec) || stat.size !== verified.bytes) return;
  if (await hashModelFile(paths.destination, signal) !== verified.sha256) return;
  writeTransferJSON(paths.receipt, { ...verified, mtimeMs: stat.mtimeMs });
  removeTransferFile(paths.resume);
  removeTransferFile(paths.partial);
}

/** The same repair, for a caller that holds the lease and is not downloading. */
export async function reconcileModel(spec: DownloadSpec, dir: string, signal: AbortSignal = AbortSignal.timeout(5 * 60_000)): Promise<void> {
  try { await reconcilePublished(spec, dir, signal); } catch { /* the file stays blocked and says so */ }
}

/**
 * Which of the given specs are not on disk yet.
 *
 * Offline-friendly on purpose: a file with a receipt, or an older one at least
 * ~90% of its approximate size with a GGUF header, is treated as complete
 * without a network round-trip, so the desktop app can
 * boot with no connectivity. `downloadModel` still verifies against the
 * server's exact content-length (and resumes) whenever it actually runs, and a
 * truncated file that slips through simply fails to load — surfaced by
 * /health as `models: "failed"` rather than hidden.
 *
 * Nothing under `src/` calls this. The desktop shell does, by name, through a
 * dynamic import of the compiled server (`desktop/first-run.ts`, `DownloadLib`),
 * which is why a scan for unused exports removed it on 2026-09-06 and v0.1.37
 * opened with "lib.missingModels is not a function". `pnpm run test:desktop`
 * now checks that contract, and this note is here so the next scan reads it.
 */
export function missingModels(dir: string, specs: DownloadSpec[]): DownloadSpec[] {
  // A private partial is never at the final name, and a file Warden installed
  // has a receipt; the 90% estimate only vouches for files older than both.
  return specs.filter((spec) => !installedModel(spec, dir).onDisk);
}
