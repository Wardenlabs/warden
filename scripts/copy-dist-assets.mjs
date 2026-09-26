/**
 * The compiled red-team runner reads its corpus from a directory next to
 * itself (dist/redteam/corpus), mirroring where the source keeps it. tsc only
 * emits .ts files, so the JSON corpus is copied in as the last build step.
 */
import { cpSync, rmSync, writeFileSync } from 'node:fs';

cpSync('src/redteam/corpus', 'dist/redteam/corpus', { recursive: true });

/*
 * A test build of the desktop updater points at a local feed
 * (docs/specs/desktop-auto-update.md §10 S4). The address is baked into the
 * bundle here, at build time, and never read from a running app's
 * environment. A shipped app that could be pointed at another update server
 * by a variable would be one environment variable away from installing
 * someone else's code. The file is removed on every other build, so a test
 * build's leftovers cannot ride into a release, and the release job checks
 * the packaged app for it as well.
 */
const feed = process.env.WARDEN_UPDATE_FEED_BUILD;
if (feed) {
  writeFileSync('dist/update-feed.json', JSON.stringify({ base: feed }) + '\n');
  console.log(`[warden] TEST BUILD: desktop updates come from ${feed}`);
} else {
  rmSync('dist/update-feed.json', { force: true });
}
