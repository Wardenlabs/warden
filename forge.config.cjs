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

module.exports = {
  packagerConfig: {
    name: 'Warden',
    executableName: 'warden',
    appBundleId: 'com.warden.gateway',
    icon: './desktop/icons/icon',
    prune: true,
    ignore: (path) => path !== '' && !KEEP.some((re) => re.test(path))
  },
  plugins: [new QvacForgePlugin({ logLevel: 'info' })],
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'win32', 'linux'] },
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'] },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      // `authors` is required by the NuGet package Squirrel builds; without
      // it the maker dies with "Authors is required."
      config: { name: 'Warden', authors: 'MartinPuli', setupExe: 'Warden-Setup.exe' }
    }
  ]
};
