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
