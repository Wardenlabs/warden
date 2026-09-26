/**
 * The desktop updater: finds a newer Warden, gets it ready, and installs it
 * only when the administrator restarts or quits.
 *
 * Every rule it follows is in `update-policy.ts` and every file it leaves is
 * in `update-marker.ts`. This file does the Electron calls and keeps the
 * state. The design is docs/specs/desktop-auto-update.md; the section numbers
 * below refer to it.
 *
 * One fact about Squirrel.Mac shapes all of it: once `update-downloaded` has
 * fired, the update is installed when this process exits, *however* it exits.
 * A quit, `app.exit()`, a relaunch and a crash all count. So nothing reaches
 * Squirrel until every gate has passed (the manifest, the macOS minimum, the
 * install location, the models the next version needs), and the marker and
 * backup are written the moment a download finishes, not at restart time.
 */
import { app, autoUpdater, dialog, net, Notification, shell, systemPreferences } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadSetupLibs, type DownloadSpec } from './first-run.js';
import type { RunningServer } from './server-manager.js';
import type { DesktopSettings } from './settings.js';
import { appendLedger, backupData, readMarker, writeMarker, type PendingUpdate } from './update-marker.js';
import {
  feedUrl,
  isNewer,
  MANIFEST_MAX_BYTES,
  MANIFEST_URL,
  offlineSentence,
  parseManifest,
  releasePageUrl,
  resolveAutoUpdate,
  systemAtLeast,
  updateMode,
  type AutoUpdateSource,
  type ReleaseManifest
} from './update-policy.js';

/** What the updater needs from the shell, and nothing more. */
export type UpdaterHost = {
  userData: string;
  modelsDir: string;
  appRoot: string;
  gatewaySettingsPath: string;
  smoke: boolean;
  log: (line: string) => void;
  settings: () => DesktopSettings;
  saveSettings: (patch: Partial<DesktopSettings>) => void;
  gateway: () => RunningServer | null;
  port: () => number;
  tunnelOn: () => boolean;
  window: () => BrowserWindow | null;
  /** Something the menu shows changed. */
  changed: () => void;
  /** Stop gateway and tunnel, and forget the gateway. */
  stopEverything: () => Promise<void>;
  /** Bring the gateway back after an install that did not go ahead. */
  relaunchGateway: () => Promise<void>;
  /** Tell the shell's own before-quit handler that this quit is handled, or
   * take that back when the quit did not happen. */
  markQuitting: (value: boolean) => void;
};

export type UpdateState =
  | { kind: 'off' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'available-linux'; version: string }
  | { kind: 'blocked-os'; version: string; minimum: string }
  | { kind: 'blocked-location'; version: string }
  | { kind: 'needs-models'; version: string; needed: DownloadSpec[]; totalMB: number; progress: number | null; failure: string | null }
  | { kind: 'downloading'; version: string }
  | { kind: 'ready'; version: string }
  | { kind: 'installing'; version: string }
  | { kind: 'error'; message: string };

const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 6 * 60 * 60_000;
const MANIFEST_TIMEOUT_MS = 20_000;
const READINESS_TIMEOUT_MS = 2_000;
const RESTART_DRAIN_MS = 30_000;
const QUIT_DRAIN_MS = 10_000;

let host: UpdaterHost | null = null;
let state: UpdateState = { kind: 'off' };
let started = false;
let cycling = false;
let timer: NodeJS.Timeout | null = null;
let feedOverride: string | null = null;

const mode = () => updateMode({ platform: process.platform, packaged: app.isPackaged, smoke: host?.smoke ?? true });

function log(line: string): void {
  host?.log(`[updater] ${line}`);
}

function setState(next: UpdateState): void {
  state = next;
  host?.changed();
}

export function updateState(): UpdateState {
  return state;
}

/** §4. Read on every use, so a profile pushed while the app runs takes effect. */
export function autoUpdateSetting(): { enabled: boolean; source: AutoUpdateSource } {
  let managed = '';
  try {
    managed = process.platform === 'darwin' ? systemPreferences.getUserDefault('AutoUpdate', 'string') : '';
  } catch {
    managed = '';
  }
  return resolveAutoUpdate({ managed, environment: process.env['WARDEN_AUTO_UPDATE'], saved: host?.settings().autoUpdate ?? true });
}

/*
 * §10 S4. A test build can point at a local feed, but only one built that way:
 * the address is read from a file the build step writes into the signed bundle,
 * never from the environment of a running app. The release job refuses to ship
 * a bundle that contains it.
 */
function readFeedOverride(appRoot: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(appRoot, 'dist', 'update-feed.json'), 'utf8')) as { base?: unknown };
    if (typeof raw.base !== 'string') return null;
    const url = new URL(raw.base);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return raw.base.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function manifestUrl(): string {
  return feedOverride ? `${feedOverride}/warden-release.json` : MANIFEST_URL;
}

function squirrelFeed(): string | null {
  if (feedOverride) return `${feedOverride}/darwin-${process.arch}/${app.getVersion()}`;
  return feedUrl(app.getVersion(), process.arch);
}

export function start(h: UpdaterHost): void {
  if (started) return;
  started = true;
  host = h;
  if (mode() === 'off') {
    setState({ kind: 'off' });
    return;
  }
  feedOverride = readFeedOverride(h.appRoot);
  if (feedOverride) log(`test build: feed ${feedOverride}`);
  if (mode() === 'squirrel-mac') {
    const url = squirrelFeed();
    if (!url) {
      log(`no feed for version ${app.getVersion()} on ${process.arch}`);
      setState({ kind: 'off' });
      return;
    }
    autoUpdater.setFeedURL({ url });
    autoUpdater.on('error', (err) => {
      log(`squirrel: ${err.message}`);
      if (state.kind === 'downloading') setState({ kind: 'error', message: 'The update could not be downloaded.' });
    });
    autoUpdater.on('update-not-available', () => {
      // The manifest said there was one and the feed disagrees: a release
      // being published this minute. The next cycle settles it.
      if (state.kind === 'downloading') setState({ kind: 'up-to-date', checkedAt: Date.now() });
    });
    autoUpdater.on('update-downloaded', (_event, _notes, releaseName) => onDownloaded(releaseName));
  }
  setState({ kind: 'idle' });
  schedule(FIRST_CHECK_MS);
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!autoUpdateSetting().enabled) return;
  timer = setTimeout(() => void cycle(), delay);
  timer.unref();
}

/** "Check for Updates…". Runs even with automatic checks off (§4). */
export function checkNow(): void {
  void cycle();
}

export function setAutomatic(enabled: boolean): void {
  host?.saveSettings({ autoUpdate: enabled });
  schedule(FIRST_CHECK_MS);
  host?.changed();
}

async function fetchManifest(): Promise<ReleaseManifest | null> {
  try {
    const response = await net.fetch(manifestUrl(), { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS), cache: 'no-store' });
    if (!response.ok) {
      log(`manifest: HTTP ${response.status}`);
      return null;
    }
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MANIFEST_MAX_BYTES) return null;
    const manifest = parseManifest(await response.text());
    if (!manifest) log('manifest: refused by the parser');
    return manifest;
  } catch (err) {
    log(`manifest: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** §6.9. */
function canSelfUpdate(): boolean {
  if (!app.isInApplicationsFolder()) return false;
  try {
    accessSync(dirname(resolve(process.execPath, '..', '..', '..')), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** §6.3. What the next version will want on disk that is not there yet. */
async function requiredMissing(manifest: ReleaseManifest): Promise<DownloadSpec[]> {
  if (!host || host.settings().adapter === 'mock') return [];
  const { lib, catalog } = await loadSetupLibs(host.appRoot);
  const plan = catalog.setupModelDownloads(host.gatewaySettingsPath, true, process.env, manifest.catalog);
  return lib.missingModels(host.modelsDir, plan);
}

async function cycle(): Promise<void> {
  if (!host || cycling || state.kind === 'installing' || state.kind === 'downloading') return;
  if (state.kind === 'needs-models' && state.progress !== null) return;
  cycling = true;
  const holding = state.kind === 'ready' ? state : null;
  try {
    if (!holding) setState({ kind: 'checking' });
    const manifest = await fetchManifest();
    if (!manifest) {
      if (!holding) setState({ kind: 'error', message: 'Could not read the latest release.' });
      return;
    }
    const current = app.getVersion();
    if (!isNewer(manifest.version, current)) {
      setState({ kind: 'up-to-date', checkedAt: Date.now() });
      return;
    }
    // A staged update is kept unless a strictly newer one can replace it now.
    if (holding && !isNewer(manifest.version, holding.version)) return;

    if (mode() === 'notice') {
      setState({ kind: 'available-linux', version: manifest.version });
      notifyOnce('available', manifest.version, `Warden ${manifest.version} is available`, 'Open the release page to download it.');
      return;
    }
    const minimum = manifest.minimumSystemVersion.darwin;
    if (!systemAtLeast(process.getSystemVersion(), minimum)) {
      if (!holding) setState({ kind: 'blocked-os', version: manifest.version, minimum: minimum ?? '' });
      return;
    }
    if (!canSelfUpdate()) {
      if (!holding) setState({ kind: 'blocked-location', version: manifest.version });
      if (!host.settings().blockedLocationNotified) {
        host.saveSettings({ blockedLocationNotified: true });
        notify('Warden cannot update itself here', 'Move Warden to Applications to receive updates.');
      }
      return;
    }
    const needed = await requiredMissing(manifest);
    if (needed.length > 0) {
      if (holding) return;
      const totalMB = needed.reduce((sum, spec) => sum + spec.approxMB, 0);
      setState({ kind: 'needs-models', version: manifest.version, needed, totalMB, progress: null, failure: null });
      notifyOnce('needs-models', manifest.version, `Warden ${manifest.version} needs new models`, `Download ${formatGB(totalMB)} before updating.`);
      return;
    }
    setState({ kind: 'downloading', version: manifest.version });
    autoUpdater.checkForUpdates();
  } catch (err) {
    log(`cycle: ${err instanceof Error ? err.message : String(err)}`);
    if (!holding) setState({ kind: 'error', message: 'The update check failed.' });
  } finally {
    cycling = false;
    schedule(EVERY_MS);
  }
}

/*
 * The download is staged, and from here any exit installs it. So the backup
 * and the marker are written now, while nothing is being stopped, and a
 * graceful restart or quit later refreshes them with the drain's result.
 */
function onDownloaded(releaseName: string): void {
  if (!host) return;
  const version = releaseName.replace(/^v/, '');
  const current = app.getVersion();
  try {
    const backup = backupData(host.userData, current);
    const marker: PendingUpdate = {
      schema: 1,
      from: current,
      to: version,
      requestedAt: new Date().toISOString(),
      stoppedAt: null,
      port: host.port(),
      tunnelWasOn: host.tunnelOn(),
      cutOff: null,
      backup,
      bootAttempts: 0
    };
    writeMarker(host.userData, marker);
  } catch (err) {
    log(`marker at download: ${err instanceof Error ? err.message : String(err)}`);
  }
  setState({ kind: 'ready', version });
  notifyOnce('ready', version, `Warden ${version} is ready`, 'Restart when your team can spare a minute.');
}

/** §6.3. Download what the next version needs while this one keeps guarding. */
export async function prefetch(): Promise<void> {
  if (!host || state.kind !== 'needs-models' || state.progress !== null) return;
  const target = state;
  const busy = await gatewayBusy();
  if (busy.includes('model-download')) {
    setState({ ...target, failure: 'Another model download is running. Try again when it finishes.' });
    return;
  }
  const { lib } = await loadSetupLibs(host.appRoot);
  let received = 0;
  let lastPaint = 0;
  setState({ ...target, progress: 0, failure: null });
  for (const spec of target.needed) {
    // Never over a file that is already there, whatever state it is in: the
    // next boot's own check owns that file, and the ledger must only ever
    // name files this prefetch created (update-marker.ts adoptPrefetched).
    if (existsSync(join(host.modelsDir, spec.filename))) continue;
    const base = received;
    const outcome = await lib.downloadModel(spec, host.modelsDir, (p) => {
      const now = Date.now();
      if (now - lastPaint < 1000) return;
      lastPaint = now;
      setState({ ...target, progress: Math.min(1, (base + p.received / 1e6) / target.totalMB), failure: null });
    });
    if (!outcome.ok) {
      log(`prefetch ${spec.filename}: ${outcome.note ?? 'failed'}`);
      setState({ ...target, progress: null, failure: `${spec.filename}: ${outcome.note ?? 'download failed'}` });
      return;
    }
    appendLedger(host.userData, { filename: spec.filename, url: spec.url ?? '', forVersion: target.version });
    received += spec.approxMB;
  }
  setState({ kind: 'idle' });
  await cycle();
}

async function gatewayBusy(): Promise<string[]> {
  const gateway = host?.gateway();
  if (!gateway) return [];
  try {
    const reply = await gateway.request({ type: 'readiness?', id: randomUUID() }, READINESS_TIMEOUT_MS);
    return Array.isArray(reply['busy']) ? reply['busy'].filter((r): r is string => typeof r === 'string') : ['no-answer'];
  } catch {
    // Silence withholds the restart. A gateway that cannot say whether it is
    // mid-swap is not one to stop on a guess.
    return ['no-answer'];
  }
}

const BUSY_TEXT: Record<string, string> = {
  'model-download': 'a model is downloading',
  'model-change': 'a model is being changed or tested',
  'no-answer': 'the gateway did not answer'
};

/*
 * §6.4 steps 3–5: fresh backup, drain, marker with the drain's result, stop.
 * Shared by the restart button and by an ordinary quit, which differ only in
 * how long they wait for work in flight.
 */
async function prepareInstall(boundMs: number): Promise<void> {
  if (!host) return;
  const current = app.getVersion();
  const staged = state.kind === 'ready' || state.kind === 'installing' ? state.version : null;
  const existing = readMarker(host.userData);
  const backup = backupData(host.userData, current);
  let cutOff: number | null = null;
  const gateway = host.gateway();
  if (gateway) {
    try {
      const reply = await gateway.request({ type: 'drain', id: randomUUID(), boundMs }, boundMs + 5_000);
      cutOff = typeof reply['cutOff'] === 'number' ? reply['cutOff'] : null;
      if (cutOff) log(`drain cut off ${cutOff} request(s)`);
    } catch (err) {
      log(`drain: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const marker: PendingUpdate = {
    schema: 1,
    from: current,
    to: staged ?? existing?.to ?? current,
    requestedAt: existing?.requestedAt ?? new Date().toISOString(),
    stoppedAt: null,
    port: host.port(),
    tunnelWasOn: host.tunnelOn(),
    cutOff,
    backup,
    bootAttempts: 0
  };
  writeMarker(host.userData, marker);
  await host.stopEverything();
  writeMarker(host.userData, { ...marker, stoppedAt: new Date().toISOString() });
}

/** §6.4. The one path that installs on the administrator's say-so. */
export async function restartToUpdate(): Promise<void> {
  if (!host || state.kind !== 'ready') return;
  const target = state;
  const busy = await gatewayBusy();
  if (busy.length > 0) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Warden cannot restart yet.',
      detail: `Right now ${busy.map((r) => BUSY_TEXT[r] ?? r).join(' and ')}. Try again when that has finished.`,
      buttons: ['OK']
    });
    return;
  }
  const options = {
    type: 'question' as const,
    message: `Restart to update Warden to v${target.version}?`,
    detail: offlineSentence(host.tunnelOn()),
    buttons: ['Restart now', 'Later'],
    defaultId: 1,
    cancelId: 1
  };
  const parent = host.window();
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (response !== 0 || state.kind !== 'ready') return;

  setState({ kind: 'installing', version: target.version });
  try {
    await prepareInstall(RESTART_DRAIN_MS);
  } catch (err) {
    log(`restart to update: ${err instanceof Error ? err.message : String(err)}`);
    setState(target);
    await host.relaunchGateway();
    void dialog.showMessageBox({ type: 'error', message: 'Warden could not restart to update.', detail: 'It is running the current version. The details are in the gateway log.', buttons: ['OK'] });
    return;
  }
  host.markQuitting(true);
  autoUpdater.quitAndInstall();
}

/** An update is staged, so this quit will install it. */
export function hasStagedUpdate(): boolean {
  return state.kind === 'ready';
}

/** Install on quit (PRD decision 2): the same preparation, a shorter drain.
 * Whatever fails in it, the quit still stops the gateway and the tunnel. A
 * `cloudflared` left behind would keep a public address pointed at nothing. */
export async function prepareForQuit(): Promise<void> {
  try {
    await prepareInstall(QUIT_DRAIN_MS);
  } catch (err) {
    log(`install on quit: ${err instanceof Error ? err.message : String(err)}`);
    await host?.stopEverything().catch(() => undefined);
  }
}

function formatGB(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on('click', () => {
    const win = host?.window();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  notification.show();
}

/* Keyed by what was said as well as the version: "v0.2.24 needs models" and
 * "v0.2.24 is ready" are two different things to be told once each. */
function notifyOnce(kind: 'available' | 'needs-models' | 'ready', version: string, title: string, body: string): void {
  const key = `${kind}:${version}`;
  if (!host || host.settings().lastNotified === key) return;
  host.saveSettings({ lastNotified: key });
  notify(title, body);
}

function statusLine(): string | null {
  switch (state.kind) {
    case 'off':
    case 'idle':
      return null;
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return 'Warden is up to date';
    case 'available-linux':
      return `Warden ${state.version} is available`;
    case 'blocked-os':
      return `Warden ${state.version} needs macOS ${state.minimum} or later`;
    case 'blocked-location':
      return `Warden ${state.version} is available, but Warden cannot update itself here`;
    case 'needs-models':
      if (state.progress !== null) return `Downloading models for ${state.version}… ${Math.round(state.progress * 100)}%`;
      if (state.failure) return `Model download for ${state.version} failed — see log`;
      return `Warden ${state.version} needs ${formatGB(state.totalMB)} of new models`;
    case 'downloading':
      return `Downloading Warden ${state.version}…`;
    case 'ready':
      return `Warden ${state.version} is ready to install`;
    case 'installing':
      return `Installing Warden ${state.version}…`;
    case 'error':
      return `${state.message} See the gateway log.`;
  }
}

/** §7.1. The update items, for the app menu on macOS and the Gateway menu on Linux. */
export function menuItems(): MenuItemConstructorOptions[] {
  if (mode() === 'off') return [];
  const automatic = autoUpdateSetting();
  const items: MenuItemConstructorOptions[] = [
    { label: 'Check for Updates…', enabled: !['checking', 'downloading', 'installing'].includes(state.kind), click: () => checkNow() }
  ];
  const line = statusLine();
  if (line) items.push({ label: line, enabled: false });
  if (state.kind === 'ready') {
    items.push({ label: `Restart to Update to ${state.version}…`, click: () => void restartToUpdate() });
  }
  if (state.kind === 'needs-models' && state.progress === null) {
    items.push({ label: `Download Models for ${state.version} (${formatGB(state.totalMB)})…`, click: () => void prefetch() });
  }
  if (state.kind === 'available-linux') {
    const version = state.version;
    items.push({ label: 'Open Release Page…', click: () => void shell.openExternal(releasePageUrl(version)) });
  }
  if (state.kind === 'blocked-location' && process.platform === 'darwin' && !app.isInApplicationsFolder()) {
    items.push({ label: 'Move Warden to Applications to Receive Updates…', click: () => void moveToApplications() });
  }
  items.push({
    label: automatic.source === 'settings'
      ? 'Check for Updates Automatically'
      : `Check for Updates Automatically (${automatic.source === 'managed' ? 'set by your organisation' : 'set by WARDEN_AUTO_UPDATE'})`,
    type: 'checkbox',
    checked: automatic.enabled,
    enabled: automatic.source === 'settings',
    click: (item) => setAutomatic(item.checked)
  });
  return items;
}

async function moveToApplications(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Move Warden to Applications?',
    detail: 'Warden will close and reopen from the Applications folder. Prompts your team sends while it restarts are not checked.',
    buttons: ['Move and Reopen', 'Cancel'],
    defaultId: 0,
    cancelId: 1
  });
  if (response !== 0 || !host) return;
  // `moveToApplicationsFolder` quits and relaunches by itself; the gateway
  // and the tunnel have to be down before it does.
  host.markQuitting(true);
  await host.stopEverything();
  try {
    if (!app.moveToApplicationsFolder()) throw new Error('declined or not possible');
  } catch (err) {
    log(`move to Applications: ${err instanceof Error ? err.message : String(err)}`);
    host.markQuitting(false);
    await host.relaunchGateway();
  }
}

/** For the shell's log: every updater line goes where the gateway's do. */
export function logTo(path: string): (line: string) => void {
  return (line) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* the log is best effort */
    }
  };
}
