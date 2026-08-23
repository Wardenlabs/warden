/**
 * Which commit produced a generated artifact.
 *
 * `REPORT.md` and `BENCHMARKS.md` are measurements, and a measurement whose
 * apparatus has since changed is not a measurement any more — it is a number
 * with no experiment behind it. That is not hypothetical here: the harness's
 * attack/control tally moved from per-file to per-prompt in `9a0fd67`, and the
 * committed `REPORT.md` still carried the old counter's arithmetic, reporting
 * `document-borne` at 2/6 where the fixed counter gives 0/4. Nothing in the
 * file said which code had produced it, so nothing could have caught that
 * except somebody thinking to check.
 *
 * Stamping the commit makes the check a command instead of a suspicion:
 *
 *     git log <stamped-sha>..HEAD -- src/redteam
 *
 * Empty means the harness has not moved and the numbers still describe it.
 * Anything listed means they do not.
 *
 * Nothing here throws. A tarball with no `.git`, or a machine without git on
 * its PATH, still has to be able to run the suite — losing provenance is worth
 * a missing line in a header and is never worth a failed run.
 */
import { execFileSync } from 'node:child_process';

export type Provenance = {
  /** Short SHA of HEAD, or null outside a usable git checkout. */
  commit: string | null;
  /**
   * Whether tracked files differed from that commit when this ran.
   *
   * A dirty tree is the other way a stamp lies: the SHA says one thing and the
   * code that ran said another. Saying so costs a word and is the difference
   * between a reproducible number and one nobody can get back to.
   */
  dirty: boolean;
};

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The files this stamp appears in, excluded from the dirty check.
 *
 * Writing the artifact is what makes the tree dirty, so counting it would make
 * every generated file say "uncommitted changes" forever — including the ones
 * produced from a pristine checkout. A warning that is always on is one readers
 * learn to skip, which costs more than not having it.
 *
 * What the stamp is about is the apparatus: whether the code that took the
 * measurement matches the commit named beside it. That question is unaffected by
 * the measurement's own output.
 */
const GENERATED = ['REPORT.md', 'BENCHMARKS.md'];

export function provenance(): Provenance {
  const commit = git('rev-parse', '--short', 'HEAD');
  if (!commit) return { commit: null, dirty: false };
  // `--quiet` exits non-zero when there is a difference, which `git()` turns
  // into null. No output and no error means the tree matches the commit.
  const clean =
    git('diff', '--quiet', 'HEAD', '--', '.', ...GENERATED.map((f) => `:(exclude)${f}`)) !== null;
  return { commit, dirty: !clean };
}

/** The fragment a generated header carries, or null when there is nothing to say. */
export function provenanceLabel(p: Provenance = provenance()): string | null {
  if (!p.commit) return null;
  return p.dirty ? `${p.commit} (uncommitted changes)` : p.commit;
}
