/**
 * Model fetching, as a library.
 *
 * `pnpm run setup` and the desktop app's first-run screen download the same
 * files the same way — plain HTTPS with a Range header so an interrupted
 * 1.1 GB download resumes instead of restarting. The logic lives here once,
 * free of console output; callers render progress their own way through
 * `onProgress`.
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
};

export type ByteProgress = { role: string; file: string; received: number; total: number };

/** Fetch one model into `dir`, resuming a partial file rather than restarting. */
export async function downloadModel(
  spec: DownloadSpec,
  dir: string,
  onProgress?: (p: ByteProgress) => void
): Promise<DownloadOutcome> {
  if (!spec.url) {
    return {
      role: spec.role,
      file: spec.filename,
      sizeMB: 0,
      ok: false,
      note: 'no HTTPS URL — this model can only come from the QVAC registry'
    };
  }

  mkdirSync(dir, { recursive: true });
  const dest = join(dir, spec.filename);
  let existing = existsSync(dest) ? statSync(dest).size : 0;

  try {
    const head = await fetch(spec.url, { method: 'HEAD', redirect: 'follow' });
    if (!head.ok) throw new Error(`metadata HTTP ${head.status}`);
    const expected = Number(head.headers.get('content-length'));
    if (!Number.isFinite(expected) || expected <= 0) {
      throw new Error('model server did not provide a valid content-length');
    }

    if (existing === expected) {
      return { role: spec.role, file: spec.filename, sizeMB: Math.round(existing / 1e6), ok: true, note: 'cached' };
    }

    // A larger file cannot be resumed safely. A smaller one is a genuine
    // partial download even when it happens to exceed the approximate size.
    if (existing > expected) existing = 0;

    const headers: Record<string, string> = {};
    if (existing > 0) headers['Range'] = `bytes=${existing}-`;

    const res = await fetch(spec.url, { headers, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('empty response body');

    const resuming = existing > 0 && res.status === 206;
    let received = resuming ? existing : 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        onProgress?.({ role: spec.role, file: spec.filename, received, total: expected });
        callback(null, chunk);
      }
    });

    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      counted,
      createWriteStream(dest, resuming ? { flags: 'a' } : {})
    );

    const size = statSync(dest).size;
    const ok = size === expected;
    return {
      role: spec.role,
      file: spec.filename,
      sizeMB: Math.round(size / 1e6),
      ok,
      ...(ok ? {} : { note: `expected ${expected} bytes, received ${size}` })
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { role: spec.role, file: spec.filename, sizeMB: 0, ok: false, note: msg };
  }
}

/**
 * Which of the given specs are not on disk yet.
 *
 * Offline-friendly on purpose: a file at least ~90% of its approximate size is
 * treated as complete without a network round-trip, so the desktop app can
 * boot with no connectivity. `downloadModel` still verifies against the
 * server's exact content-length (and resumes) whenever it actually runs, and a
 * truncated file that slips through simply fails to load — surfaced by
 * /health as `models: "failed"` rather than hidden.
 */
export function missingModels(dir: string, specs: DownloadSpec[]): DownloadSpec[] {
  return specs.filter((spec) => {
    const dest = join(dir, spec.filename);
    if (!existsSync(dest)) return true;
    return statSync(dest).size < spec.approxMB * 1e6 * 0.9;
  });
}
