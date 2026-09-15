import { copyFile, mkdir } from 'node:fs/promises';

// Copy only the official, credential-free browser entrypoint. The server SDK
// and its private environment are never part of the static website output.
const destination = new URL('../landing/vendor/kool/', import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  new URL('../integrations/kool/node_modules/@joinkool/sdk/src/browser.mjs', import.meta.url),
  new URL('browser.mjs', destination),
);
