/**
 * Built-in weights, fetched one file at a time by a running gateway.
 *
 * The console used to get these by stopping the gateway and sending the
 * administrator back through first-run setup, and only under Electron. This
 * owns the alternative: a job the gateway runs in the background, that a
 * browser starts, watches and cancels, and that outlives the browser.
 *
 * What it deliberately does not do is touch inference. Nothing here saves a
 * selection, forgets a role or loads a model — a finished download is a file on
 * disk and a receipt beside it, and Use remains a separate decision made under
 * the role lease. It imports no runtime for the same reason the setup helpers
 * do not: a transfer must not be able to change which model is judging.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { libraryBuiltin, LIBRARY_BUILTINS, type LibraryBuiltin } from '../setup/catalog.js';
import { downloadModel, reconcileModel, type DownloadSpec } from '../setup/download.js';
import { artifactPaths, installedModel, privateDirectory, publicTransferError, publishedCandidate, readTransferJSON, regularFile, removeTransferFile, TransferError, writeTransferJSON } from '../setup/model-files.js';
import { acquireTransfer, currentTransfer, TransferBusyError, type TransferLease, type TransferOwner } from '../setup/transfer-lock.js';
import { modelsRoot } from './store.js';

const ACTIVE = ['connecting', 'downloading', 'retrying', 'verifying', 'cancelling'] as const;
const jobSchema = z.object({
  id: z.string().uuid(), source: z.literal('builtin'), builtinId: z.string(), name: z.string(),
  state: z.enum([...ACTIVE, 'complete', 'failed', 'cancelled', 'interrupted']),
  received: z.number().int().nonnegative(), total: z.number().int().positive().nullable(),
  attempt: z.number().int().positive(), maxAttempts: z.literal(4), modelId: z.null(),
  error: z.string().nullable(), errorCode: z.string().nullable(),
  canCancel: z.boolean(), canRetry: z.boolean(), startedAt: z.string(), updatedAt: z.string()
});
const journalSchema = z.object({ version: z.literal(1), jobs: z.array(jobSchema).max(LIBRARY_BUILTINS.length) });
export type BuiltinDownloadJob = z.infer<typeof jobSchema>;
type Running = { controller: AbortController; why: 'cancel' | 'shutdown' | null; done: Promise<void> };
export type BuiltinStatus = ReturnType<typeof installedModel> & LibraryBuiltin & { filename: string; approxBytes: number; latestJobId: string | null };
export type StartResult = { status: 200; body: { alreadyInstalled: true; builtin: BuiltinStatus } } | { status: 202; body: { job: BuiltinDownloadJob; reused: boolean } };

const active = (job: BuiltinDownloadJob): boolean => (ACTIVE as readonly string[]).includes(job.state);
const UNSUPPORTED = 'Model management uses the QVAC runtime. Restart without the experimental llamacpp adapter to download models.';

export class BuiltinDownloads {
  /** Latest attempt per artifact: a retry replaces its row instead of stacking one. */
  private readonly jobs = new Map<string, BuiltinDownloadJob>();
  private readonly running = new Map<string, Running>();
  private loaded = false;
  private closed = false;
  private unreadable: string | null = null;

  constructor(private readonly dir: () => string = modelsRoot, private readonly run: typeof downloadModel = downloadModel) {}

  private journal(create = false): string { return join(privateDirectory(this.dir(), create), 'jobs.json'); }

  /** Read once. A job this process did not start cannot still be running in it,
   * whatever the journal says — the gateway that wrote it is gone. */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const saved = readTransferJSON(this.journal());
      if (saved === null) return;
      for (const job of journalSchema.parse(saved).jobs) {
        const known = libraryBuiltin(job.builtinId);
        if (!known) continue;
        this.jobs.set(job.builtinId, active(job) ? this.interrupted(job, known.spec) : job);
      }
    } catch {
      // Neither discarded nor trusted. Starting over an unreadable journal
      // could write beside a partial nobody is tracking any more.
      this.unreadable = 'The saved download state is unreadable. Restore or remove the .downloads/jobs.json file in the models directory, then restart the gateway.';
    }
  }

  private interrupted(job: BuiltinDownloadJob, spec: DownloadSpec): BuiltinDownloadJob {
    // Publication may have finished in the moment before the process died. The
    // installed file is the fact; a stale "verifying" is only what was last written.
    const installed = installedModel(spec, this.dir());
    if (installed.verifiedDownload) return { ...job, state: 'complete', received: installed.bytes!, total: installed.bytes, canCancel: false, canRetry: false, error: null, errorCode: null };
    const partial = regularFile(artifactPaths(spec, this.dir()).partial);
    return { ...job, state: 'interrupted', received: partial?.size ?? 0, canCancel: false, canRetry: true,
      error: 'The gateway stopped during this download.', errorCode: 'interrupted', updatedAt: new Date().toISOString() };
  }

  /** State transitions only. Bytes are recovered from the partial file, so a
   * 5 GB transfer is a handful of writes rather than one per chunk. */
  private persist(): void {
    try { writeTransferJSON(this.journal(true), { version: 1, jobs: [...this.jobs.values()] }); }
    catch { /* the transfer matters more than its journal; the next transition retries */ }
  }

  private update(job: BuiltinDownloadJob, next: Partial<BuiltinDownloadJob>, save = true): void {
    Object.assign(job, next, { updatedAt: new Date().toISOString() });
    if (save) this.persist();
  }

  /** At boot, before anybody reads a status: finish recording any file that was
   * published just before a crash, and write down what the journal now means. */
  async reconcile(): Promise<void> {
    this.load();
    if (this.unreadable) return;
    for (const { id } of LIBRARY_BUILTINS) {
      const { spec } = libraryBuiltin(id)!;
      if (!publishedCandidate(spec, this.dir())) continue;
      let lease: TransferLease;
      try { lease = acquireTransfer(this.dir(), { name: spec.filename, source: 'reconcile', jobId: null }); } catch { continue; }
      try { await reconcileModel(spec, this.dir()); } finally { lease.release(); }
      const job = this.jobs.get(id);
      if (job) this.jobs.set(id, this.interrupted({ ...job, state: 'verifying' }, spec));
    }
    if (this.jobs.size) this.persist();
  }

  transfer(): { available: boolean; reason: string | null; maxConcurrent: 1; active: TransferOwner | null } {
    this.load();
    const reason = process.env['WARDEN_ADAPTER'] === 'llamacpp' ? UNSUPPORTED : this.unreadable;
    let owner: TransferOwner | null;
    try { owner = currentTransfer(this.dir()); }
    catch (error) { owner = error instanceof TransferBusyError ? error.active : { name: 'Another model', source: 'external', jobId: null }; }
    return { available: reason === null, reason, maxConcurrent: 1, active: owner };
  }

  builtins(): BuiltinStatus[] {
    this.load();
    return LIBRARY_BUILTINS.map((builtin) => this.status(builtin.id)!);
  }

  private status(id: string): BuiltinStatus | null {
    const known = libraryBuiltin(id);
    if (!known) return null;
    return { ...known.builtin, filename: known.spec.filename, approxBytes: known.spec.approxMB * 1_000_000,
      ...installedModel(known.spec, this.dir()), latestJobId: this.jobs.get(id)?.id ?? null };
  }

  list(): BuiltinDownloadJob[] { this.load(); return [...this.jobs.values()].map((job) => ({ ...job })); }
  owns(jobId: string): boolean { this.load(); return [...this.jobs.values()].some((job) => job.id === jobId); }

  start(id: string): StartResult {
    this.load();
    const known = libraryBuiltin(id);
    if (!known) throw new TransferError('unknown_builtin', 'Choose a model from the Library.', 404);
    if (process.env['WARDEN_ADAPTER'] === 'llamacpp') throw new TransferError('model_management_unavailable', UNSUPPORTED, 409);
    if (this.unreadable) throw new TransferError('model_management_unavailable', this.unreadable, 409);
    if (this.closed) throw new TransferError('model_management_unavailable', 'The gateway is shutting down.', 409);

    const previous = this.jobs.get(id);
    if (previous && active(previous)) return { status: 202, body: { job: { ...previous }, reused: true } };
    const dir = this.dir();
    const installed = installedModel(known.spec, dir);
    if (installed.onDisk) return { status: 200, body: { alreadyInstalled: true, builtin: this.status(id)! } };
    // A published file waiting for its receipt reads as blocked. The job below
    // finishes that record instead of refusing the file it just installed.
    if (installed.downloadBlockedReason && !publishedCandidate(known.spec, dir)) throw new TransferError('existing_file_invalid', installed.downloadBlockedReason, 409);

    const jobId = randomUUID();
    let lease: TransferLease;
    // Reserved before the 202, so two administrators cannot both be told yes.
    try { lease = acquireTransfer(dir, { name: known.builtin.name, source: 'builtin', jobId }); }
    catch (error) { throw publicTransferError(error); }

    const now = new Date().toISOString();
    const partial = regularFile(artifactPaths(known.spec, dir).partial);
    const job: BuiltinDownloadJob = { id: jobId, source: 'builtin', builtinId: id, name: known.builtin.name, state: 'connecting',
      received: partial?.size ?? 0, total: null, attempt: 1, maxAttempts: 4, modelId: null, error: null, errorCode: null,
      canCancel: true, canRetry: false, startedAt: now, updatedAt: now };
    this.jobs.set(id, job);
    this.persist();
    const entry: Running = { controller: new AbortController(), why: null, done: Promise.resolve() };
    this.running.set(jobId, entry);
    entry.done = this.work(job, known.spec, dir, lease, entry);
    return { status: 202, body: { job: { ...job }, reused: false } };
  }

  private async work(job: BuiltinDownloadJob, spec: DownloadSpec, dir: string, lease: TransferLease, entry: Running): Promise<void> {
    try {
      const outcome = await this.run(spec, dir, (p) => this.update(job, { received: p.received, total: p.total }, false), 4, {
        lease, signal: entry.controller.signal, timeoutMs: 30 * 60_000,
        // A cancel already shown to the administrator is not overwritten by the
        // phase the downloader was entering when the abort reached it.
        onPhase: (state, attempt) => { if (job.state !== 'cancelling') this.update(job, { state, attempt }); },
        onPublish: () => this.update(job, { canCancel: false })
      });
      if (outcome.ok) {
        const bytes = installedModel(spec, dir).bytes ?? job.total ?? job.received;
        this.update(job, { state: 'complete', received: bytes, total: bytes, canCancel: false, canRetry: false, error: null, errorCode: null });
      } else if (entry.why === 'cancel') {
        // Only an explicit cancel gives the bytes up. Still under the lease, so
        // this cannot remove a partial that a newer job has started to extend.
        const paths = artifactPaths(spec, dir);
        try { removeTransferFile(paths.partial); removeTransferFile(paths.resume); } catch { /* left for the next start to replace */ }
        this.update(job, { state: 'cancelled', received: 0, canCancel: false, canRetry: false, error: null, errorCode: null });
      } else if (entry.why === 'shutdown') {
        this.jobs.set(job.builtinId, Object.assign(job, this.interrupted(job, spec)));
        this.persist();
      } else {
        this.update(job, { state: 'failed', canCancel: false, canRetry: outcome.code !== 'existing_file_invalid',
          error: outcome.note ?? 'The model download failed.', errorCode: outcome.code ?? 'download_failed' });
      }
    } catch (error) {
      const failure = publicTransferError(error);
      this.update(job, { state: 'failed', canCancel: false, canRetry: true, error: failure.message, errorCode: failure.code });
    } finally {
      lease.release();
      this.running.delete(job.id);
    }
  }

  /** 202 while it stops; the terminal state is published after the streams
   * close and the partial is gone, not when the request was received. */
  cancel(jobId: string): BuiltinDownloadJob {
    this.load();
    const job = [...this.jobs.values()].find((candidate) => candidate.id === jobId);
    if (!job) throw new TransferError('unknown_download', 'Download not found', 404);
    if (job.state === 'cancelling' || job.state === 'cancelled') return { ...job };
    const entry = this.running.get(jobId);
    if (!entry || !active(job) || !job.canCancel) throw new TransferError('transfer_finished', job.state === 'complete' ? 'This model is already installed. Cancelling does not remove it.' : 'This download can no longer be cancelled.', 409);
    entry.why = 'cancel';
    this.update(job, { state: 'cancelling', canCancel: false });
    entry.controller.abort();
    return { ...job };
  }

  /** No new jobs, and the running one stops as Interrupted with its bytes kept.
   * A forced exit can skip this, which is why `load` never relies on it. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const pending = [...this.running.values()];
    for (const entry of pending) { entry.why ??= 'shutdown'; entry.controller.abort(); }
    await Promise.all(pending.map((entry) => entry.done));
  }
}

export const builtinDownloads = new BuiltinDownloads();
