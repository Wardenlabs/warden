/**
 * First-run flow: make sure the required models exist under the user's data
 * folder before the gateway starts in real mode, with a visible download and
 * an escape hatch into mock ("demo") mode.
 *
 * Runs in the Electron main process, which deliberately never imports
 * @qvac/sdk. The download library and the model catalog are plain data/IO
 * modules compiled into the server tree (dist/setup/*), loaded here by
 * absolute path — desktop/ and src/ are separate TypeScript projects, so the
 * handful of shared shapes is restated below instead of imported.
 */
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type DownloadSpec = { role: string; filename: string; url: string | null; approxMB: number; required: boolean };
type DownloadOutcome = { role: string; file: string; sizeMB: number; ok: boolean; note?: string };
type ByteProgress = { role: string; file: string; received: number; total: number };
type DownloadLib = {
  downloadModel: (spec: DownloadSpec, dir: string, onProgress?: (p: ByteProgress) => void) => Promise<DownloadOutcome>;
  missingModels: (dir: string, specs: DownloadSpec[]) => DownloadSpec[];
};
type CatalogLib = { MODEL_CATALOG: DownloadSpec[] };

export type ModelProgress = { role: string; totalMB: number; receivedMB: number; done: boolean; failed?: string };

export type SetupState =
  | { phase: 'welcome'; totalMB: number; freeGB: number | null }
  | { phase: 'downloading'; models: ModelProgress[] }
  | { phase: 'starting'; detail: 'boot' | 'warming' }
  | { phase: 'error'; message: string };

export function sendState(splash: BrowserWindow, state: SetupState): void {
  if (!splash.isDestroyed()) splash.webContents.send('setup:state', state);
}

/** One user gesture from the splash: Download, Demo mode, or Retry. */
function nextChoice(): Promise<'download' | 'mock' | 'retry'> {
  return new Promise((resolveChoice) => {
    ipcMain.once('setup:choice', (_event, choice: unknown) => {
      resolveChoice(choice === 'mock' ? 'mock' : choice === 'retry' ? 'retry' : 'download');
    });
  });
}

export async function ensureModels(opts: {
  splash: BrowserWindow;
  appRoot: string;
  modelsDir: string;
}): Promise<'real' | 'mock'> {
  const lib = (await import(
    pathToFileURL(join(opts.appRoot, 'dist', 'setup', 'download.js')).href
  )) as DownloadLib;
  const { MODEL_CATALOG } = (await import(
    pathToFileURL(join(opts.appRoot, 'dist', 'setup', 'catalog.js')).href
  )) as CatalogLib;

  mkdirSync(opts.modelsDir, { recursive: true });
  const required = MODEL_CATALOG.filter((spec) => spec.required && spec.url);

  for (;;) {
    const missing = lib.missingModels(opts.modelsDir, required);
    if (missing.length === 0) return 'real';

    const totalMB = missing.reduce((sum, spec) => sum + spec.approxMB, 0);
    sendState(opts.splash, { phase: 'welcome', totalMB, freeGB: await freeDiskGB(opts.modelsDir) });
    const choice = await nextChoice();
    if (choice === 'mock') return 'mock';

    const progress: ModelProgress[] = missing.map((spec) => ({
      role: spec.role,
      totalMB: spec.approxMB,
      receivedMB: 0,
      done: false
    }));
    sendState(opts.splash, { phase: 'downloading', models: progress });

    let failure: string | null = null;
    for (const [index, spec] of missing.entries()) {
      const row = progress[index];
      if (!row) continue;
      let lastPush = 0;
      const outcome = await lib.downloadModel(spec, opts.modelsDir, (p) => {
        row.receivedMB = Math.round(p.received / 1e6);
        row.totalMB = Math.round(p.total / 1e6);
        const now = Date.now();
        if (now - lastPush > 250) {
          lastPush = now;
          sendState(opts.splash, { phase: 'downloading', models: progress });
        }
      });
      if (!outcome.ok) {
        row.failed = outcome.note ?? 'download failed';
        failure = `${spec.role}: ${row.failed}`;
        sendState(opts.splash, { phase: 'downloading', models: progress });
        break;
      }
      row.done = true;
      row.receivedMB = outcome.sizeMB;
      sendState(opts.splash, { phase: 'downloading', models: progress });
    }

    if (!failure) return 'real';
    sendState(opts.splash, { phase: 'error', message: failure });
    const after = await nextChoice();
    if (after === 'mock') return 'mock';
    // Retry loops back around; a partial file resumes where it stopped.
  }
}

async function freeDiskGB(dir: string): Promise<number | null> {
  try {
    const stats = await statfs(dir);
    return Math.round((stats.bavail * stats.bsize) / 1e9);
  } catch {
    return null;
  }
}
