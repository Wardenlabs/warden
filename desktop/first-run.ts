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
type CatalogLib = {
  MODEL_CATALOG: DownloadSpec[];
  setupModelDownloads: (settingsPath?: string, includeExtras?: boolean, env?: NodeJS.ProcessEnv, catalog?: readonly DownloadSpec[]) => DownloadSpec[];
};

/**
 * The two compiled setup modules, loaded the way every caller here loads them.
 * Exported for the updater, which asks what the next release will need and
 * prefetches it through the same downloader first run uses, so the contract
 * `scripts/test-desktop-lib.ts` checks is the one it relies on too.
 */
export async function loadSetupLibs(appRoot: string): Promise<{ lib: DownloadLib; catalog: CatalogLib }> {
  const lib = (await import(pathToFileURL(join(appRoot, 'dist', 'setup', 'download.js')).href)) as DownloadLib;
  const catalog = (await import(pathToFileURL(join(appRoot, 'dist', 'setup', 'catalog.js')).href)) as CatalogLib;
  return { lib, catalog };
}
export type { DownloadSpec };

export type ModelProgress = { role: string; totalMB: number; receivedMB: number; done: boolean; failed?: string };

export type SetupState =
  | { phase: 'mode' }
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

/** One user gesture from the splash's very first screen: solo or team. */
function nextMode(): Promise<'solo' | 'team'> {
  return new Promise((resolveMode) => {
    ipcMain.once('setup:mode', (_event, choice: unknown) => {
      resolveMode(choice === 'solo' ? 'solo' : 'team');
    });
  });
}

/**
 * Ask, once, before the model-download screen: is this installation being
 * set up for one person, or for an administrator who will invite a team?
 *
 * Shown ahead of `welcome` rather than folded into it or asked afterward —
 * see docs/specs/solo-mode.md §8 — so the choice is available for the rest
 * of first-run to react to from the start, not bolted on once models are
 * already down. The caller (`main.ts`) is what makes this ask only once per
 * installation: it skips calling this entirely once the company directory
 * already has someone in it, the same directory `resolveSoloIdentity` on the
 * gateway adds a person to, on either path, the first time either is taken.
 */
export async function askMode(splash: BrowserWindow): Promise<'solo' | 'team'> {
  sendState(splash, { phase: 'mode' });
  return nextMode();
}

/**
 * Are the required models already on disk?
 *
 * Asked on every boot, including the boots that start in demo mode. Choosing
 * demo used to be permanent and silent: the choice was written to settings,
 * and `ensureModels` only runs when settings say `real`, so an installation
 * that later acquired the models — a retried download, a `pnpm run setup`, a
 * copy from a colleague's machine — kept booting into mock forever with no
 * indication that it no longer had to. The way out existed and was a tray menu
 * item, which is not where somebody looks when the product appears not to work.
 *
 * Separate from `ensureModels` because this one asks and never prompts: it
 * touches the splash, the network and the user's attention not at all.
 */
export async function modelsPresent(appRoot: string, modelsDir: string, gatewaySettingsPath?: string): Promise<boolean> {
  try {
    const lib = (await import(
      pathToFileURL(join(appRoot, 'dist', 'setup', 'download.js')).href
    )) as DownloadLib;
    const { setupModelDownloads } = (await import(
      pathToFileURL(join(appRoot, 'dist', 'setup', 'catalog.js')).href
    )) as CatalogLib;
    const required = setupModelDownloads(gatewaySettingsPath);
    return lib.missingModels(modelsDir, required).length === 0;
  } catch {
    // A build without the setup modules, or an unreadable models directory.
    // Answering "no" leaves the installation exactly where it was, which is
    // the safe direction for a check nobody asked for.
    return false;
  }
}

/**
 * Everything this file will ask of the compiled server, checked in one place.
 *
 * The two `Lib` types above are a promise the server makes to this process
 * and nothing enforces: v0.1.37 shipped with `missingModels` deleted from
 * `src/setup/download.ts`, every typecheck green, and opened with
 * "lib.missingModels is not a function". The smoke run boots in mock mode
 * and never reaches `ensureModels`, so it never saw it either. This is the
 * call the smoke makes instead, and it runs the real lookup once over an
 * empty directory so a member that exists but throws is caught too.
 */
export async function setupLibReady(appRoot: string): Promise<void> {
  const lib = (await import(
    pathToFileURL(join(appRoot, 'dist', 'setup', 'download.js')).href
  )) as Partial<DownloadLib>;
  const { MODEL_CATALOG, setupModelDownloads } = (await import(
    pathToFileURL(join(appRoot, 'dist', 'setup', 'catalog.js')).href
  )) as Partial<CatalogLib>;
  for (const name of ['missingModels', 'downloadModel'] as const) {
    if (typeof lib[name] !== 'function') throw new Error(`dist/setup/download.js does not export ${name}`);
  }
  if (!Array.isArray(MODEL_CATALOG) || MODEL_CATALOG.length === 0) {
    throw new Error('dist/setup/catalog.js does not export MODEL_CATALOG');
  }
  if (typeof setupModelDownloads !== 'function') {
    throw new Error('dist/setup/catalog.js does not export setupModelDownloads');
  }
  const required = setupModelDownloads(join(appRoot, 'no-such-settings.json'));
  const missing = lib.missingModels!(join(appRoot, 'no-such-models-dir'), required);
  if (missing.length !== required.length) throw new Error('missingModels did not report an empty directory as missing everything');
}

export async function ensureModels(opts: {
  splash: BrowserWindow;
  appRoot: string;
  modelsDir: string;
  /** The gateway's settings file, for optional weights an administrator picked. */
  gatewaySettingsPath?: string;
}): Promise<'real' | 'mock'> {
  const lib = (await import(
    pathToFileURL(join(opts.appRoot, 'dist', 'setup', 'download.js')).href
  )) as DownloadLib;
  const { setupModelDownloads } = (await import(
    pathToFileURL(join(opts.appRoot, 'dist', 'setup', 'catalog.js')).href
  )) as CatalogLib;

  mkdirSync(opts.modelsDir, { recursive: true });
  // The same selector powers setup and model inventory. It adds a compiler
  // only for a saved local choice, and includes requested analyzer extras.
  const required = setupModelDownloads(opts.gatewaySettingsPath, true);

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
