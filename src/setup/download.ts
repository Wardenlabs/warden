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
 * attempt — a 404, a server with no content-length — are not retried.
 */
export async function downloadModel(
  spec: DownloadSpec,
  dir: string,
  onProgress?: (p: ByteProgress) => void,
  attempts = 4
): Promise<DownloadOutcome> {
  let last: DownloadOutcome | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await runDownload(spec, dir, onProgress);
    if (last.ok || !worthRetrying(last.note)) return last;
    if (attempt < attempts) {
      // 2s, 4s, 8s. Long enough for a flapping connection to come back,
      // short enough that a person watching a progress bar stays put.
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  }
  return last!;
}

/**
 * Is this failure the kind another attempt could fix?
 *
 * Allowlist rather than blocklist: an unrecognised failure is retried, because
 * the cost of a wasted attempt is a few seconds and the cost of not retrying is
 * a setup that hands someone a gateway with no judge. The exclusions are the
 * cases where the answer will be identical next time.
 */
function worthRetrying(note: string | undefined): boolean {
  if (!note) return true;
  return !/HTTP (4\d\d)|no HTTPS URL|content-length/.test(note);
}

async function runDownload(
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
