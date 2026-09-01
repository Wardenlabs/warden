/**
 * What an upgrade has to undo, because a previous version of Warden did it
 * without being asked.
 *
 * "A fresh install starts empty" was fixed in the code that seeds, and that is
 * only half of it. The desktop app keeps its data in the user's own folder and
 * an update does not touch that folder — which is right, nobody wants an
 * upgrade eating their policy — so a person who installed a build up to v0.1.5,
 * updated, and opened the app still saw Northwind Logistics SA in the header,
 * seven people who do not exist in Team, and eight rules and seven quotas
 * nobody in their company wrote. From where they sit that is not a stale file,
 * it is the product asserting a fact about them that is false. It was reported
 * exactly that way.
 *
 * So the boot has to remove it, and the whole difficulty is removing only that.
 * Two conditions, both required, and each one alone is not enough:
 *
 *   1. The directory is marked `demo` and carries no `sampleInstalledAt`.
 *      The stamp is written only by `loadSampleCompany()`, so its absence
 *      means no human ever pressed the button — an old build put this here.
 *      A directory somebody named is not `demo` at all and never reaches this.
 *
 *   2. The policy hashes identically to the file we ship. Not "has the same
 *      rule ids" — the same hash, which no policy containing a single edited
 *      word can have. If an administrator wrote or changed one rule, this is
 *      false and nothing is removed, sample directory or not.
 *
 * Which is to say: this deletes data only when it can prove the data is ours
 * and not theirs. When it cannot prove that, it leaves everything alone and the
 * console's "Clear the sample team" button is still there to be pressed.
 *
 * It announces what it did on stdout. A migration that silently deletes files
 * is one nobody can debug, and this one runs on somebody else's machine.
 */
import { discardDirectory, isUnrequestedSample } from './people.js';
import { discardPolicy, isShippedSeed } from './store.js';

export function dropUnrequestedSample(seedPath: string): boolean {
  if (!isUnrequestedSample()) return false;
  if (!isShippedSeed(seedPath)) return false;

  discardDirectory();
  discardPolicy();
  console.log(
    '  migrated  removed the sample company and policy an older build installed on its own\n' +
      '            (nothing here had been edited — load it again from Team if you want it)'
  );
  return true;
}
