/**
 * The decisions the desktop updater makes, with nothing to decide them with
 * except their arguments.
 *
 * No Electron import, no filesystem, no network: `updater.ts` gathers the
 * facts (the system version, the managed preference, the manifest body) and
 * this file says what they mean. That split is what lets every rule below be
 * tested by `scripts/test-desktop-update.ts` in plain Node. It also lets CI
 * validate the release manifest with the same parser the app will use, so a
 * manifest the app would refuse cannot be published.
 *
 * See docs/specs/desktop-auto-update.md.
 */

/** One downloadable model file, as the release that ships it describes it. */
export type ReleaseModel = {
  role: string;
  filename: string;
  url: string;
  approxMB: number;
  required: boolean;
};

/** `warden-release.json`, published beside every release's installers. */
export type ReleaseManifest = {
  schema: 1;
  version: string;
  minimumSystemVersion: { darwin?: string };
  catalog: ReleaseModel[];
};

export const MANIFEST_MAX_BYTES = 64 * 1024;
const MAX_CATALOG = 32;

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const SYSTEM_VERSION = /^\d+(\.\d+){0,2}$/;
const FILENAME = /^[A-Za-z0-9._-]+\.gguf$/;

/*
 * Only revision-pinned Hugging Face URLs, because that pin is the whole trust
 * argument for prefetching. A `resolve/<40-hex>/` path names immutable bytes,
 * so when the next, signed release's own catalogue names the same URL, the
 * file downloaded ahead of it is the file that release was built against. A
 * branch name (`resolve/main/`) would make that sentence false, and any other
 * host would make it someone else's sentence.
 */
function isPinnedWeightsUrl(url: string, filename: string): boolean {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^https://huggingface\\.co/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/resolve/[0-9a-f]{40}/${escaped}$`).test(url);
}

function parseModel(value: unknown): ReleaseModel | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const { role, filename, url, approxMB, required } = entry;
  if (typeof role !== 'string' || !/^[a-z0-9-]{1,64}$/.test(role)) return null;
  if (typeof filename !== 'string' || !FILENAME.test(filename)) return null;
  if (typeof url !== 'string' || !isPinnedWeightsUrl(url, filename)) return null;
  if (typeof approxMB !== 'number' || !Number.isFinite(approxMB) || approxMB < 1 || approxMB > 20_000) return null;
  if (typeof required !== 'boolean') return null;
  return { role, filename, url, approxMB, required };
}

/**
 * The manifest, or null for anything short of exactly what schema 1 promises.
 *
 * All-or-nothing on purpose. A manifest with one bad model entry is not "the
 * manifest minus that entry": dropping it would make the prefetch plan
 * silently smaller, and the next boot would land on the download screen the
 * prefetch exists to prevent. A null means no update is offered this cycle,
 * which costs a few hours and never a surprise. Unknown keys are ignored, not
 * refused, so schema 1 can grow a field without stranding the installed base.
 */
export function parseManifest(raw: string): ReleaseManifest | null {
  if (Buffer.byteLength(raw, 'utf8') > MANIFEST_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body['schema'] !== 1) return null;
  const version = body['version'];
  if (typeof version !== 'string' || !VERSION.test(version)) return null;

  const minimum = body['minimumSystemVersion'];
  if (!minimum || typeof minimum !== 'object' || Array.isArray(minimum)) return null;
  const darwin = (minimum as Record<string, unknown>)['darwin'];
  if (darwin !== undefined && (typeof darwin !== 'string' || !SYSTEM_VERSION.test(darwin))) return null;

  const catalog = body['catalog'];
  if (!Array.isArray(catalog) || catalog.length > MAX_CATALOG) return null;
  const models: ReleaseModel[] = [];
  const seen = new Set<string>();
  for (const item of catalog) {
    const model = parseModel(item);
    // Two entries with one filename would let the second decide which bytes
    // a prefetched file is checked against.
    if (!model || seen.has(model.filename)) return null;
    seen.add(model.filename);
    models.push(model);
  }
  return { schema: 1, version, minimumSystemVersion: darwin === undefined ? {} : { darwin }, catalog: models };
}

function versionParts(version: string): [number, number, number] | null {
  const match = VERSION.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True only when `candidate` is a strictly later release than `current`. An
 * unreadable version on either side is never newer. */
export function isNewer(candidate: string, current: string): boolean {
  const a = versionParts(candidate);
  const b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

/**
 * Whether this machine can run a release that needs `minimum`.
 *
 * macOS reports `15.5` or `15.5.1`, and `Info.plist` says `12.0`. Missing parts
 * count as zero. An absent minimum means the release did not say, so the check
 * passes: every release has run on every macOS the packaging supports so far.
 * An unreadable running version does not pass, because installing an app that
 * may not launch is the worse way to be wrong.
 */
export function systemAtLeast(running: string, minimum: string | undefined): boolean {
  if (minimum === undefined) return true;
  if (!SYSTEM_VERSION.test(running) || !SYSTEM_VERSION.test(minimum)) return false;
  const have = running.split('.').map(Number);
  const need = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const h = have[i] ?? 0;
    const n = need[i] ?? 0;
    if (h !== n) return h > n;
  }
  return true;
}

export type AutoUpdateSource = 'managed' | 'environment' | 'settings';

/**
 * Who decided whether updates are checked on a schedule, and what they said.
 *
 * `managed` is `systemPreferences.getUserDefault('AutoUpdate', 'string')`.
 * Read as a string because, measured on Electron 43 (spec §10, S2), a boolean
 * read returns `false` both for "set to false" and for "not set", and the
 * second must fall through to the other sources. An empty string is absent.
 *
 * A managed value that is present but unreadable counts as off. Somebody
 * wrote a policy there on purpose, and "stop contacting the internet" is
 * the reading that honours an organisation's intent when the spelling is
 * wrong. The environment is optional and personal, so an unreadable value
 * there is ignored.
 */
export function resolveAutoUpdate(inputs: {
  managed: string;
  environment: string | undefined;
  saved: boolean;
}): { enabled: boolean; source: AutoUpdateSource } {
  const managed = inputs.managed.trim().toLowerCase();
  if (managed !== '') {
    return { enabled: ['1', 'true', 'yes'].includes(managed), source: 'managed' };
  }
  const environment = inputs.environment?.trim().toLowerCase();
  if (environment === '0' || environment === 'false') return { enabled: false, source: 'environment' };
  if (environment === '1' || environment === 'true') return { enabled: true, source: 'environment' };
  return { enabled: inputs.saved, source: 'settings' };
}

export type UpdateMode = 'squirrel-mac' | 'notice' | 'off';

/**
 * What the updater does on this build.
 *
 * Unpackaged and smoke runs never touch the network for updates: the first is
 * a developer's checkout, and the second is CI, where a feed request would make
 * a boot test depend on GitHub. Windows is off until its builds are signed
 * (PRD decision 6). Linux has no in-place installer, so it gets a notice
 * (decision 7).
 */
export function updateMode(inputs: { platform: NodeJS.Platform; packaged: boolean; smoke: boolean }): UpdateMode {
  if (!inputs.packaged || inputs.smoke) return 'off';
  if (inputs.platform === 'darwin') return 'squirrel-mac';
  if (inputs.platform === 'linux') return 'notice';
  return 'off';
}

const REPOSITORY = 'Wardenlabs/warden';

/**
 * The Squirrel.Mac feed for this build.
 *
 * The architecture is not optional. Measured 2026-09-25: a bare `darwin`
 * answered with the Intel zip, which an Apple Silicon Mac would install and
 * then run under Rosetta on CPU only, silently several times slower.
 */
export function feedUrl(version: string, arch: string): string | null {
  if (!VERSION.test(version) || (arch !== 'arm64' && arch !== 'x64')) return null;
  return `https://update.electronjs.org/${REPOSITORY}/darwin-${arch}/${version}`;
}

export const MANIFEST_URL = `https://github.com/${REPOSITORY}/releases/latest/download/warden-release.json`;

export function releasePageUrl(version: string): string {
  return `https://github.com/${REPOSITORY}/releases/tag/v${version}`;
}

/** The installer to go back to when an update would not boot (spec §6.6). */
export function previousInstallerUrl(version: string, arch: string): string | null {
  if (!VERSION.test(version) || (arch !== 'arm64' && arch !== 'x64')) return null;
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/Warden-${arch}.dmg`;
}

/**
 * Seconds from "Restart now" until `/health` answers again, as measured on a
 * packaged build with the real adapter.
 *
 * Null until that measurement exists (spec §9). The dialog then says "a short
 * time" instead of a number, because a number here is a promise made to
 * someone deciding whether their team can go unguarded, and a guess is not one.
 */
export const OFFLINE_ESTIMATE_S: number | null = null;

export function offlineSentence(tunnelOn: boolean): string {
  const how = OFFLINE_ESTIMATE_S === null ? 'for a short time' : `for about ${OFFLINE_ESTIMATE_S} seconds`;
  const lines = [`Warden will be offline ${how}. Prompts your team sends during that time are not checked.`];
  if (tunnelOn) {
    lines.push('The public address will change, and devices connected through it stop being checked until they are given the new one.');
  }
  return lines.join(' ');
}

/** A model file the updater downloaded ahead of a release. */
export type PrefetchRecord = { filename: string; url: string; forVersion: string };

/**
 * Which prefetched files the release now running may use.
 *
 * Decided by the new version's own catalogue, which is inside the signed
 * bundle: a file is kept when that catalogue names the same filename at the
 * same revision-pinned URL, and removed otherwise. The manifest that caused the
 * download is not consulted. It came from a release page, and the point is
 * that code Apple verified has the last word on which weights sit in
 * `models/`.
 */
export function adoptionPlan(
  ledger: readonly PrefetchRecord[],
  catalog: readonly { filename: string; url: string | null }[]
): { keep: string[]; remove: string[] } {
  const keep: string[] = [];
  const remove: string[] = [];
  for (const record of ledger) {
    if (!FILENAME.test(record.filename)) continue;
    const match = catalog.some((spec) => spec.filename === record.filename && spec.url === record.url);
    (match ? keep : remove).push(record.filename);
  }
  return { keep, remove };
}
