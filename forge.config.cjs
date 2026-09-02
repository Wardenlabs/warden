/**
 * Electron Forge configuration for the Warden desktop app.
 *
 * CommonJS on purpose: the repo is "type": "module" but the QVAC Forge plugin
 * is CJS, so this file carries the .cjs extension.
 *
 * The QVAC plugin does the heavy lifting for the native inference stack: it
 * bundles the SDK worker (per qvac.config.json), verifies the native addons
 * for the target platform/arch, prunes every other platform's prebuilds, and
 * forces `asar: false` — the Bare worker cannot load from an asar archive.
 * macOS universal builds are rejected by it; darwin-arm64 and darwin-x64 are
 * built separately.
 */
'use strict';

const QvacForgePlugin = require('@qvac/sdk/electron-forge');

/**
 * Packager walks the project and asks about each path ('/src', '/web/app.js',
 * …). Keep-list rather than a blocklist: a new top-level file lands outside
 * the app until someone decides it belongs inside. The QVAC plugin composes
 * its own addon/prebuild exclusions on top of this.
 */
const KEEP = [
  /^\/package\.json$/,
  /^\/qvac\.config\.json$/,
  /^\/LICENSE$/,
  /^\/dist(\/|$)/,
  /^\/desktop(\/|$)/,
  /^\/web(\/|$)/,
  /^\/integrations(\/|$)/,
  /^\/bin(\/|$)/,
  /^\/data$/,
  /^\/data\/seed(\/|$)/,
  /^\/node_modules(\/|$)/,
  // Written by the QVAC plugin's bundle step at package time.
  /^\/qvac(\/|$)/
];

const DROP = [
  // Dangling .bin symlinks: their devDependency targets are pruned, and the
  // leftovers surface as xattr/codesign noise inside the bundle.
  /^\/node_modules\/\.bin(\/|$)/
];

/**
 * macOS signing/notarization switch on only when CI provides credentials,
 * so local builds and forks keep producing unsigned artifacts.
 */
const macSigning =
  process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID
    ? {
        osxSign: {
          optionsForFile: () => ({ entitlements: './desktop/entitlements.plist' })
        },
        osxNotarize: {
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_ID_PASSWORD,
          teamId: process.env.APPLE_TEAM_ID
        }
      }
    : {};

module.exports = {
  packagerConfig: {
    // No executableName override: the binary inherits "Warden" everywhere —
    // a lowercase executable was what Gatekeeper's dialog showed to users.
    name: 'Warden',
    appBundleId: 'com.warden.gateway',
    icon: './desktop/icons/icon',
    prune: true,
    ignore: (path) => path !== '' && (DROP.some((re) => re.test(path)) || !KEEP.some((re) => re.test(path))),
    ...macSigning
  },
  plugins: [new QvacForgePlugin({ logLevel: 'info' })],

  hooks: {
    /**
     * Put the execute bit back on the runtime the SDK spawns.
     *
     * `@qvac/sdk` runs inference in a separate process and spawns it through
     * `bare-runtime/spawn`, which execs `node_modules/bare-runtime/bin/bare`.
     * That file is 0755 in a checkout and arrives 0644 inside the packaged app,
     * so the spawn fails with EACCES — silently, because a process that never
     * starts writes nothing to stderr, and all the SDK can say afterwards is
     * "RPC initialization timed out after 30000ms, the worker process may have
     * failed to start". Which is what a machine with every model downloaded
     * reported, and what cost two releases of guessing at Electron env vars
     * before a probe that runs `bare --version` answered EACCES in one line.
     *
     * Here rather than at runtime, and this is the part that matters: on macOS
     * the bundle is signed and notarized after this hook, so a chmod any later
     * invalidates the signature. Packaging is the last moment the mode can be
     * fixed for free.
     *
     * Best effort by design. A platform where this is meaningless (Windows) or
     * a layout where the file is elsewhere must not fail somebody's build; a
     * runtime that will not start is loud on its own now.
     */
    packageAfterCopy: async (_config, buildPath) => {
      const { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const modules = join(buildPath, 'node_modules');
      if (!existsSync(modules)) {
        console.warn('[warden] no node_modules in the packaged app — skipping runtime fixups');
        return;
      }

      // Every `bare-runtime-<platform>-<arch>` package, plus the launcher in
      // `bare-runtime` itself. The platform packages are the ones that matter:
      // `lib/spawn.js` runs in-process and execs the ~95 MB binary in there
      // directly, so `bin/bare` in `bare-runtime` is a 130-byte shim the SDK
      // never touches. Doing both costs nothing and stops the next person
      // fixing only the one they happened to look at, which is what I did.
      const dirs = readdirSync(modules).filter(
        (name) => name === 'bare-runtime' || name.startsWith('bare-runtime-')
      );
      for (const dir of dirs) {
        const bin = join(modules, dir, 'bin');
        if (!existsSync(bin)) continue;
        for (const name of readdirSync(bin)) {
          try {
            chmodSync(join(bin, name), 0o755);
            console.log(`[warden] made executable: node_modules/${dir}/bin/${name}`);
          } catch (err) {
            console.warn(`[warden] could not chmod ${dir}/bin/${name}: ${err.message}`);
          }
        }
      }

      /**
       * Make the worker entry point at this bundle instead of at the machine
       * that built it.
       *
       * `npx qvac bundle sdk` writes `qvac/worker.entry.mjs`, and it writes the
       * SDK imports as absolute `file://` URLs under the SDK's realpath —
       * deliberately, so that bare-pack resolves the `bare-*` modules next to
       * the SDK rather than against the consumer project. That is correct in a
       * checkout and wrong in anything shipped, because the realpath it bakes
       * in is the build machine's. On the release runner that is
       * `/Users/runner/work/warden/warden/node_modules/@qvac/sdk/...`, a path
       * which exists nowhere else, so on every user's machine `bare` starts,
       * fails the first import, and dies:
       *
       *   Uncaught ModuleError: MODULE_NOT_FOUND: Cannot find module
       *   'file:///Users/runner/work/warden/warden/node_modules/@qvac/sdk/dist/server/worker-core.js'
       *
       * Which the SDK reports, again, as "RPC initialization timed out after
       * 30000ms — the worker process may have failed to start". That sentence
       * has now stood for a missing binary, a permission bit, and this; the
       * probe added in 0.1.16 is what separates them, and on the report that
       * found this one it said the runtime was fine and the worker was dying
       * after it started. It was right.
       *
       * The rewrite is `<anything>/node_modules/` to `../node_modules/`, which
       * is the same file inside the packaged app: the entry lives at
       * `app/qvac/worker.entry.mjs` and the SDK at `app/node_modules/@qvac/sdk`.
       * Relative resolution then anchors on the bundle's own tree, which keeps
       * the property the absolute URL was there to buy — the `bare-*` modules
       * resolve as siblings of the SDK — without pinning it to a disk.
       *
       * Here for the same reason as the chmod above: macOS signs and notarizes
       * after this hook, so this is the last moment the file can change without
       * invalidating the signature, and a runtime rewrite would be writing into
       * a signed bundle owned by root.
       *
       * A specifier that does not pass through a `node_modules` — a custom
       * plugin living in the project — is left alone and stays absolute. CI
       * fails the build on any `file://` import that survives this, because
       * that is the shape of the bug and it should not ship a second time.
       */
      const entry = join(buildPath, 'qvac', 'worker.entry.mjs');
      if (!existsSync(entry)) {
        console.warn('[warden] no qvac/worker.entry.mjs in the packaged app — inference will not start');
        return;
      }
      const before = readFileSync(entry, 'utf8');
      const after = before.replace(/"file:\/\/[^"]*\/node_modules\//g, '"../node_modules/');
      if (after === before) {
        console.log('[warden] qvac/worker.entry.mjs imports no absolute paths, left as is');
        return;
      }
      writeFileSync(entry, after);
      for (const line of after.split('\n').filter((l) => l.startsWith('import '))) {
        console.log(`[warden] worker entry: ${line}`);
      }
    }
  },

  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'win32', 'linux'] },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      // The mounted volume carries the brand badge, not the generic disk icon.
      //
      // The filename drops the version on purpose. The default is
      // `Warden-${version}-${arch}.dmg`, which means every release publishes an
      // asset under a name nothing can predict, and the only way to link to the
      // installer is to hardcode a tag and remember to bump it. Nobody
      // remembers: the landing page sat on v0.1.4 while v0.1.6 was out. With
      // the arch still in the name and the version gone, GitHub's
      // `releases/latest/download/Warden-arm64.dmg` resolves forever. The
      // config is a function because the two darwin builds share this maker and
      // would otherwise collide under one name.
      config: (arch) => ({ name: `Warden-${arch}`, icon: './desktop/icons/icon.icns' })
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      // `authors` is required by the NuGet package Squirrel builds; without
      // it the maker dies with "Authors is required."
      config: {
        name: 'Warden',
        authors: 'MartinPuli',
        setupExe: 'Warden-Setup.exe',
        setupIcon: './desktop/icons/icon.ico'
      }
    }
  ]
};
