/**
 * Warden Desktop: the Electron shell around the gateway.
 *
 * The main process never runs inference and never imports @qvac/sdk. It owns
 * exactly three things: the first-run model download, the lifecycle of the
 * gateway child process (the same dist/server/index.js that `pnpm start`
 * runs), and a BrowserWindow pointed at the gateway's own console over
 * 127.0.0.1 — same origin as the API, so the server's no-CORS stance stays
 * untouched.
 *
 * Defaults are deliberately private: the gateway binds 127.0.0.1 until the
 * admin flips "Allow LAN access" in the menu, which is the moment the OS
 * firewall prompt belongs to.
 */
import { app, BrowserWindow, clipboard, dialog, Menu, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureModels, modelsPresent, sendState } from './first-run.js';
import {
  fetchHealth,
  pickPort,
  sleep,
  startServer,
  waitHealthy,
  type RunningServer
} from './server-manager.js';
import { readSettings, writeSettings, type DesktopSettings } from './settings.js';
import * as tunnel from './tunnel.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP_ROOT = app.getAppPath();
const SERVER_ENTRY = join(APP_ROOT, 'dist', 'server', 'index.js');
const SPLASH_HTML = join(APP_ROOT, 'desktop', 'splash.html');
const PRELOAD = join(HERE, 'preload.cjs');
const ICON_PNG = join(APP_ROOT, 'desktop', 'icons', 'icon.png');
/** CI boot proof: forces mock, quits 0 once the console actually loads. */
const SMOKE = process.env['WARDEN_SMOKE'] === '1';

let userData = '';
let settings: DesktopSettings = { lanEnabled: false, exposeEnabled: false, adapter: 'real' };
let splash: BrowserWindow | null = null;
let consoleWindow: BrowserWindow | null = null;
let gateway: RunningServer | null = null;
let activePort = 8080;
let quitting = false;
let portRetried = false;

const modelsDir = (): string => join(userData, 'models');
const logPath = (): string => join(userData, 'logs', 'warden-gateway.log');
const consoleUrl = (): string => `http://127.0.0.1:${activePort}/`;

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    const win = consoleWindow ?? splash;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    // The tunnel holds a public address open and is a separate process, so a
    // quit that only stopped the gateway would leave the internet pointed at a
    // port with nothing behind it — and leave `cloudflared` running until
    // somebody noticed it in Activity Monitor.
    if (!gateway && !tunnel.isRunning()) return;
    event.preventDefault();
    void Promise.all([gateway?.stop() ?? Promise.resolve(), tunnel.stop()]).then(() => {
      gateway = null;
      app.quit();
    });
  });

  // A gateway with no window is invisible; quitting is the predictable shape
  // on every platform. macOS dock-only residence can come later if wanted.
  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (!consoleWindow && gateway) openConsole(gateway.port);
  });

  void main().catch((err: unknown) => {
    dialog.showErrorBox('Warden', err instanceof Error ? (err.stack ?? err.message) : String(err));
    app.exit(1);
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  // Packaged builds get the icon from the bundle; this covers `pnpm run
  // app:dev`, where the dock would otherwise show Electron's own.
  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(ICON_PNG);
  }
  userData = app.getPath('userData');
  settings = readSettings(userData);
  if (SMOKE) {
    settings = { ...settings, adapter: 'mock', lanEnabled: false, exposeEnabled: false };
    setTimeout(() => {
      console.error('WARDEN_SMOKE_TIMEOUT');
      app.exit(1);
    }, 120_000).unref();
  }

  splash = new BrowserWindow({
    width: 560,
    height: 520,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    title: 'Warden',
    backgroundColor: '#ffffff',
    icon: ICON_PNG,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await splash.loadFile(SPLASH_HTML);
  splash.show();

  if (settings.adapter === 'real') {
    const adapter = await ensureModels({
      splash,
      appRoot: APP_ROOT,
      modelsDir: modelsDir(),
      // The gateway runs with cwd set to userData, so its `data/settings.json`
      // is this path. That is where the console records a larger adjudicator.
      gatewaySettingsPath: join(userData, 'data', 'settings.json')
    });
    if (adapter === 'mock') {
      settings = { ...settings, adapter: 'mock' };
      writeSettings(userData, settings);
    }
  } else if (await modelsPresent(APP_ROOT, modelsDir())) {
    // Demo mode was a decision about a machine with no models on it. This
    // machine has them now, so the decision has expired — and leaving it in
    // place would mean an installation that is fully able to run the guard
    // quietly answering with a keyword-matching test double instead. Silent
    // in the other direction too: nothing to click, it just works next time.
    settings = { ...settings, adapter: 'real' };
    writeSettings(userData, settings);
  }

  await launchGateway();
}

async function launchGateway(forceEphemeral = false): Promise<void> {
  if (splash && !splash.isDestroyed()) sendState(splash, { phase: 'starting', detail: 'boot' });

  const port = await pickPort(settings.port ?? 8080, forceEphemeral);
  gateway = startServer(
    {
      entry: SERVER_ENTRY,
      cwd: userData,
      port,
      host: settings.lanEnabled ? '0.0.0.0' : '127.0.0.1',
      publicUrl,
      assetsDir: APP_ROOT,
      modelsDir: modelsDir(),
      adapter: settings.adapter,
      logPath: logPath()
    },
    onGatewayExit,
    // The console's "Download models" button, arriving the long way round: the
    // console has no preload, so it POSTs to the gateway and the gateway relays
    // it here. Same action as the menu item, from where people look for it.
    (msg) => {
      // No `adapter === 'mock'` check. That guard made the button dead in the
      // exact case it exists for: an install already in real mode whose weights
      // never landed, where the console correctly says "not downloaded" and the
      // one control offered to fix it did nothing at all. `fetchModels` sets
      // real and relaunches either way, and `ensureModels` on the next boot
      // downloads only what is missing, so pressing it with everything already
      // on disk costs a restart and no bytes.
      if (msg === 'leave-demo') fetchModels();
    }
  );

  const health = await waitHealthy(port, 30_000);
  if (!health) {
    await gatewayFailed('The gateway did not answer its health check in time.');
    return;
  }

  // Never persist from a smoke run: it forces mock in memory, and writing
  // that out would silently flip a real installation into demo mode.
  if (!SMOKE && settings.port !== port) {
    settings = { ...settings, port };
    writeSettings(userData, settings);
  }

  // First boot with real models: wait (bounded) while they warm, so the first
  // decision in the console is not a thirty-second surprise. Mock and
  // warmup-off report anything but 'loading' and skip this entirely.
  let current = health;
  const warmDeadline = Date.now() + 120_000;
  while (splash && !splash.isDestroyed() && current.models === 'loading' && Date.now() < warmDeadline) {
    sendState(splash, { phase: 'starting', detail: 'warming' });
    await sleep(1500);
    current = (await fetchHealth(port)) ?? current;
  }

  openConsole(port);
  Menu.setApplicationMenu(buildMenu());

  /*
   * Restore the tunnel the administrator left on.
   *
   * Only from a cold start — `launchGateway` also runs on every restart, and
   * `setExposeEnabled` restarts the gateway itself after bringing the tunnel
   * up. Without this guard that path would tear down the tunnel it had just
   * created and build another, changing the public URL immediately after
   * telling somebody what it was.
   *
   * The gateway is already listening at this point but does not yet know its
   * public URL, so the restart at the end is what hands it over. It is one
   * extra restart on a boot that was exposed, and it is the difference between
   * an onboarding pack that works and one that quietly hands out a LAN address.
   */
  if (settings.exposeEnabled && !tunnel.isRunning() && publicUrl === null) {
    void setExposeEnabled(true);
  }
}

function openConsole(port: number): void {
  activePort = port;
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    void consoleWindow.loadURL(consoleUrl());
    return;
  }
  consoleWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Warden',
    backgroundColor: '#ffffff',
    icon: ICON_PNG,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  consoleWindow.once('ready-to-show', () => {
    consoleWindow?.show();
    if (splash && !splash.isDestroyed()) splash.close();
    splash = null;
  });
  consoleWindow.on('closed', () => {
    consoleWindow = null;
  });
  // The console has no outbound links today; if one ever appears it belongs
  // in the system browser, not inside the shell.
  consoleWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (SMOKE) {
    consoleWindow.webContents.once('did-finish-load', () => {
      void smokeVerify();
    });
  }
  void consoleWindow.loadURL(consoleUrl());
}

async function smokeVerify(): Promise<void> {
  const health = await fetchHealth(activePort);
  if (health?.ok) {
    console.log('WARDEN_SMOKE_OK');
    await shutdownAndExit(0);
  } else {
    console.error('WARDEN_SMOKE_FAIL: /health did not answer');
    await shutdownAndExit(1);
  }
}

async function shutdownAndExit(code: number): Promise<void> {
  quitting = true;
  if (gateway) {
    await gateway.stop();
    gateway = null;
  }
  app.exit(code);
}

function onGatewayExit(code: number): void {
  if (quitting) return;
  gateway = null;
  const tail = logTail();
  // The listen call has no EADDRINUSE handler by design (the CLI just
  // crashes); the shell reads the log and retries once on an ephemeral port.
  if (!portRetried && /EADDRINUSE/i.test(tail)) {
    portRetried = true;
    void launchGateway(true);
    return;
  }
  void dialog
    .showMessageBox({
      type: 'error',
      title: 'Warden',
      message: `The Warden gateway stopped unexpectedly (code ${code}).`,
      detail: tail.slice(-1400) || 'The gateway log is empty.',
      buttons: ['Relaunch gateway', 'Quit'],
      defaultId: 0,
      cancelId: 1
    })
    .then(({ response }) => {
      if (response === 0) void restartGateway();
      else app.quit();
    });
}

async function gatewayFailed(reason: string): Promise<void> {
  if (SMOKE) {
    console.error(`WARDEN_SMOKE_FAIL: ${reason}`);
    await shutdownAndExit(1);
    return;
  }
  const tail = logTail();
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Warden',
    message: reason,
    detail: tail.slice(-1400) || 'The gateway log is empty.',
    buttons: ['Retry', 'Quit'],
    defaultId: 0,
    cancelId: 1
  });
  if (response === 0) await restartGateway();
  else app.quit();
}

async function restartGateway(): Promise<void> {
  if (gateway) {
    await gateway.stop();
    gateway = null;
  }
  portRetried = false;
  await launchGateway();
}

/**
 * The address the world reaches this gateway at, or null when nothing does.
 *
 * Read by `launchGateway`, so a restart for any other reason — changing the LAN
 * setting, recovering from a crash — comes back up still knowing it is exposed.
 */
let publicUrl: string | null = null;

/**
 * Put the gateway on the internet, or take it off.
 *
 * The tunnel comes up first and the gateway restarts second, because the
 * gateway's environment has to carry the public URL: the onboarding pack builds
 * the link employees are given from it, and a pack copied while the URL was
 * still unknown would send everybody a LAN address they cannot reach. That
 * ordering is the whole reason this is not two independent switches.
 *
 * A failure leaves the setting off and says why. Half-exposed — a tunnel with
 * no gateway behind it, or a gateway that believes it is public and is not —
 * is the state worth refusing.
 */
async function setExposeEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    await tunnel.stop();
    publicUrl = null;
    settings = { ...settings, exposeEnabled: false };
    writeSettings(userData, settings);
    await restartGateway();
    Menu.setApplicationMenu(buildMenu());
    return;
  }

  try {
    publicUrl = await tunnel.start(activePort);
  } catch (err) {
    publicUrl = null;
    settings = { ...settings, exposeEnabled: false };
    writeSettings(userData, settings);
    void dialog.showMessageBox({
      type: 'warning',
      message: 'Warden is not on the internet.',
      detail: err instanceof Error ? err.message : String(err),
      buttons: ['OK']
    });
    return;
  }

  settings = { ...settings, exposeEnabled: true };
  writeSettings(userData, settings);
  await restartGateway();
  Menu.setApplicationMenu(buildMenu());

  // Said once, on the way in, because both of these are properties of a quick
  // tunnel that an administrator will otherwise discover the hard way: the
  // first by handing the link to somebody who should not have had it, the
  // second when every employee's configuration stops working overnight.
  void dialog.showMessageBox({
    type: 'info',
    message: 'Warden is on the internet.',
    detail:
      `${publicUrl}\n\n` +
      'Anyone with this address can reach the gateway; employees still need their own ' +
      'key, and administration is refused through it. The address changes every time ' +
      'the tunnel restarts, and everyone has to be given the new one.',
    buttons: ['OK']
  });
}

async function setLanEnabled(enabled: boolean): Promise<void> {
  settings = { ...settings, lanEnabled: enabled };
  writeSettings(userData, settings);
  await restartGateway();
}

/** Leave demo mode: relaunch so the first-run screen can download models. */
/**
 * Fetch whatever is missing and come back up on it.
 *
 * Named for what it does rather than for the state it used to leave, because it
 * is now reached from two places that are not the same situation: the demo
 * banner, where nothing has ever been downloaded, and the model list, where
 * some of it has and some has not.
 */
function fetchModels(): void {
  settings = { ...settings, adapter: 'real' };
  writeSettings(userData, settings);
  quitting = true;
  const done = (): void => {
    app.relaunch();
    app.exit(0);
  };
  if (gateway) void gateway.stop().then(done);
  else done();
}

function buildMenu(): Menu {
  const lanIp = firstLanIp();
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Gateway',
      submenu: [
        { label: `Console: http://127.0.0.1:${activePort}`, enabled: false },
        {
          label: settings.adapter === 'mock' ? 'Mode: demo (mock inference)' : 'Mode: on-device inference',
          enabled: false
        },
        { type: 'separator' },
        { label: 'Copy local URL', click: () => clipboard.writeText(`http://127.0.0.1:${activePort}`) },
        {
          label: lanIp ? `Copy network URL (${lanIp})` : 'Copy network URL',
          enabled: settings.lanEnabled && lanIp !== null,
          click: () => clipboard.writeText(`http://${lanIp}:${activePort}`)
        },
        { label: 'Open console in browser', click: () => void shell.openExternal(consoleUrl()) },
        { type: 'separator' },
        {
          label: 'Allow LAN access (teammates connect here)',
          type: 'checkbox',
          checked: settings.lanEnabled,
          click: (item) => void setLanEnabled(item.checked)
        },
        {
          label: 'Put Warden on the internet…',
          type: 'checkbox',
          checked: settings.exposeEnabled,
          enabled: settings.adapter !== 'mock',
          click: (item) => void setExposeEnabled(item.checked)
        },
        {
          label: publicUrl ? `Copy public URL (${publicUrl.replace('https://', '')})` : 'Copy public URL',
          enabled: publicUrl !== null,
          click: () => publicUrl && clipboard.writeText(publicUrl)
        },
        // Offered in both modes now. An install in real mode with weights that
        // never arrived needs this exactly as much as one in demo mode does,
        // and hiding it there was half of why the button appeared to do nothing.
        {
          label: settings.adapter === 'mock'
            ? 'Download models & leave demo mode…'
            : 'Download any missing models…',
          click: () => fetchModels()
        },
        { type: 'separator' },
        { label: 'Restart gateway', click: () => void restartGateway() },
        { label: 'Open data folder', click: () => void shell.openPath(userData) },
        { label: 'View gateway log', click: () => void shell.openPath(logPath()) }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

function firstLanIp(): string | null {
  return (
    Object.values(networkInterfaces())
      .flatMap((ifaces) => ifaces ?? [])
      .filter((iface) => iface.family === 'IPv4' && !iface.internal)
      .map((iface) => iface.address)[0] ?? null
  );
}

function logTail(): string {
  try {
    return readFileSync(logPath(), 'utf8').slice(-4000);
  } catch {
    return '';
  }
}
