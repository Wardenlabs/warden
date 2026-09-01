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
 * it is the product asserting a fact about them that is false, on the first
 * screen they see.
 *
 * ## The mistake the first version of this made
 *
 * It required the directory *and* the policy to both be pristine before it
 * removed either. On the machine this was actually reported from, somebody had
 * written one rule of their own on top of the eight that had been seeded — so
 * the policy no longer matched, and the migration removed nothing at all. Eight
 * invented rules and seven invented people stayed, because of one rule that had
 * nothing to do with any of them. "I just downloaded the latest version and I
 * still see test data" is the correct report of that, and the coupling was the
 * bug.
 *
 * So the decisions are independent, and each is made at the smallest unit that
 * carries its own evidence:
 *
 *   - **Each person, one at a time.** Removed when their id, name and role all
 *     match somebody in the file we ship. A real teammate matches nothing and
 *     stays; the seven ghosts beside them still go. The first version of this
 *     compared the whole roster and so kept all seven whenever one real person
 *     had been added, which is the same coupling bug one level down.
 *   - **Each rule and each quota, one at a time.** Removed when that row is
 *     byte-identical to one we ship. A rule you wrote is not identical to any
 *     of ours; a seeded rule you edited by one word is no longer identical to
 *     ours either, and both stay.
 *
 * ## The one condition over all of it
 *
 * None of this runs if anybody ever pressed the button. `loadSampleCompany()`
 * stamps `sampleInstalledAt`, so a sample somebody asked for is theirs and is
 * never touched — not the people, not the rules. Absence of that stamp on a
 * directory marked `demo` is what says an old build put this here by itself.
 *
 * Which is to say: this removes data only where it can point at the file we
 * ship and say "this row is ours, and no one here asked for it". Everything
 * else stays, and the console's "Clear the sample team" button is still there
 * for anyone who wants the rest gone.
 *
 * It announces what it did on stdout. A migration that silently deletes files
 * is one nobody can debug, and this one runs on somebody else's machine.
 */
import { discardSeededPeople, sampleWasRequested } from './people.js';
import { discardSeededRules } from './store.js';

export function dropUnrequestedSample(policySeed: string, companySeed: string): boolean {
  // Somebody asked for it. It is theirs, all of it.
  if (sampleWasRequested()) return false;

  const said: string[] = [];

  const people = discardSeededPeople(companySeed);
  if (people > 0) said.push(`${people} invented ${people === 1 ? 'person' : 'people'}`);

  const { rules, quotas } = discardSeededRules(policySeed);
  if (rules > 0 || quotas > 0) {
    said.push(`${rules} seeded ${rules === 1 ? 'rule' : 'rules'} and ${quotas} seeded ${quotas === 1 ? 'quota' : 'quotas'}`);
  }

  if (said.length === 0) return false;
  console.log(
    `  migrated  removed ${said.join(', and ')} that an older build installed on its own\n` +
      '            (anything you wrote or edited was kept; load the sample again from Team if you want it)'
  );
  return true;
}
