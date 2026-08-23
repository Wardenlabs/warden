/**
 * Generate the QVAC integration permalinks for the submission.
 *
 * The track asks for "direct GitHub links to the files/lines where inference
 * happens" and says it is the first thing the judges look at. Two ways to get
 * that wrong, and both fail silently:
 *
 *   - Linking a branch (`blob/main/...`). The link keeps working and starts
 *     pointing at different code the moment anyone pushes. A permalink is a
 *     40-character commit SHA, and nothing else is.
 *   - Writing the line numbers by hand. `src/policy/index.ts` moved its embed
 *     call from line 72 to line 94 in a single afternoon; the README said 72
 *     and nobody noticed, because a wrong line number still renders a page.
 *
 * So anchors here are regexes, resolved against the file *as of the SHA being
 * linked*, and a pattern that no longer matches is a hard error rather than a
 * quietly stale number.
 *
 *   npm run permalinks              # markdown table for the current commit
 *   npm run permalinks -- --write   # rewrite README.md between the markers
 *   npm run permalinks -- --sha <sha>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/** Where a reader should land, and why that line is worth their attention. */
type Anchor = {
  file: string;
  /** First line of the excerpt. */
  from: RegExp;
  /** Last line, searched after `from`. Omit for a single line. */
  through?: RegExp;
  what: string;
};

/**
 * Ordered so a judge reading top to bottom sees the boundary, then the SDK
 * calls behind it, then the three passes that consume them — which is the same
 * order the README's architecture section makes the argument in.
 */
const ANCHORS: Anchor[] = [
  {
    file: 'src/qvac/types.ts',
    from: /^export interface QvacAdapter/,
    through: /^}/,
    what: 'The adapter interface. Every consumer takes this, which is what keeps inference to one directory.'
  },
  {
    file: 'src/qvac/real.ts',
    from: /^import .* from '@qvac\/sdk';/,
    what: 'The only import of `@qvac/sdk` in the guard path — `completion`, `embed`, `ocr`, `cancel`.'
  },
  {
    file: 'src/qvac/real.ts',
    from: /const run = completion\(\{/,
    through: /^\s*\}\);/,
    what: '`completion()` under a JSON-schema grammar, temp 0, fixed seed, `reasoning_budget: 0` to suppress Qwen3 thinking.'
  },
  {
    file: 'src/qvac/real.ts',
    from: /const res = await embed\(\{/,
    what: '`embed()` — the vectors behind rule retrieval.'
  },
  {
    file: 'src/qvac/real.ts',
    from: /const \{ blocks \} = ocr\(\{/,
    what: '`ocr()` — text out of an attachment, before it is treated as untrusted input.'
  },
  {
    file: 'src/qvac/client.ts',
    from: /const loading = loadModel\(\{/,
    through: /^\s*\}\);/,
    what: '`loadModel()` per role, one resident instance each, `parallel: 4` on the adjudicator.'
  },
  {
    file: 'src/qvac/models.ts',
    from: /^import \{$/,
    through: /^\} from '@qvac\/sdk';/,
    what: 'The SDK model constants, and how each resolves to an HTTPS download when the P2P registry is blocked.'
  },
  {
    file: 'src/guard/passes/adjudicate.ts',
    from: /const res = await qvac\.completeJSON\(/,
    through: /^\s*\);/,
    what: 'The per-rule judgement: one narrow question, one enum label. The measured core of the project.'
  },
  {
    file: 'src/policy/compile.ts',
    from: /const res = await qvac\.completeJSON<RuleDraft>\(/,
    through: /^\s*\);/,
    what: 'Plain language → structured rule. The model drafts; ratifying stays a human step.'
  },
  {
    file: 'src/policy/index.ts',
    from: /const \[promptVec\] = await adapter\(\)\.embed\(\[prompt\]\);/,
    what: 'Retrieval: cosine similarity against the rule embeddings, no LLM.'
  },
  {
    file: 'src/guard/pipeline.ts',
    from: /await qvac\.ocr\(path\)/,
    what: 'Where an attachment enters the pipeline, sanitised and then isolated like any other untrusted text.'
  },
  {
    file: 'src/guard/aggregate.ts',
    from: /^export function aggregate\(/,
    what: '**No inference here, deliberately.** Models observe; this function decides, and it can only tighten a verdict.'
  }
];

const MARKER_START = '<!-- permalinks:start -->';
const MARKER_END = '<!-- permalinks:end -->';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** `https://github.com/owner/repo`, however the remote happens to be spelled. */
function repoUrl(): string {
  const remote = git('remote', 'get-url', 'origin');
  const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error(`origin does not look like a GitHub remote: ${remote}`);
  return `https://github.com/${match[1]}`;
}

/**
 * Refuse to emit links to a commit that is not on the remote.
 *
 * This is the failure that would actually cost the submission: the links are
 * generated locally, they look right in the terminal, and every one of them
 * 404s for anybody who is not us.
 */
function assertPushed(sha: string): void {
  const remoteBranches = git('branch', '-r', '--contains', sha);
  if (!remoteBranches) {
    throw new Error(
      `commit ${sha.slice(0, 12)} is not on any remote branch — push it first, ` +
        `or these links will 404 for the judges`
    );
  }
}

/** Resolve one anchor against the file as it stands in `sha`. */
function locate(anchor: Anchor, sha: string): { start: number; end: number } {
  const lines = git('show', `${sha}:${anchor.file}`).split('\n');

  const start = lines.findIndex((line) => anchor.from.test(line));
  if (start === -1) {
    throw new Error(`${anchor.file}: no line matches ${anchor.from} at ${sha.slice(0, 12)}`);
  }
  if (!anchor.through) return { start: start + 1, end: start + 1 };

  const offset = lines.slice(start + 1).findIndex((line) => anchor.through!.test(line));
  if (offset === -1) {
    throw new Error(`${anchor.file}: found ${anchor.from} but never ${anchor.through}`);
  }
  return { start: start + 1, end: start + offset + 2 };
}

function render(sha: string): string {
  const base = repoUrl();
  const rows = ANCHORS.map((anchor) => {
    const { start, end } = locate(anchor, sha);
    const fragment = start === end ? `#L${start}` : `#L${start}-L${end}`;
    const label = `${anchor.file}${fragment.replace('#', ' ')}`;
    return `| [\`${label}\`](${base}/blob/${sha}/${anchor.file}${fragment}) | ${anchor.what} |`;
  });

  return [
    `Pinned to [\`${sha.slice(0, 12)}\`](${base}/tree/${sha}). Line numbers move; a commit does not.`,
    '',
    '| Where | What runs there |',
    '|---|---|',
    ...rows
  ].join('\n');
}

const args = process.argv.slice(2);
const shaArg = args.indexOf('--sha');
const sha = git('rev-parse', shaArg === -1 ? 'HEAD' : (args[shaArg + 1] ?? 'HEAD'));

if (git('status', '--porcelain')) {
  console.error(
    '! working tree is dirty — these links point at the committed code, not what you are reading locally\n'
  );
}
assertPushed(sha);

const table = render(sha);

if (args.includes('--write')) {
  const readme = readFileSync('README.md', 'utf8');
  if (!readme.includes(MARKER_START)) {
    throw new Error(`README.md has no ${MARKER_START} marker — add it around the table first`);
  }
  const pattern = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`);
  writeFileSync('README.md', readme.replace(pattern, `${MARKER_START}\n${table}\n${MARKER_END}`));
  console.log(`README.md updated — ${ANCHORS.length} permalinks at ${sha.slice(0, 12)}`);
} else {
  console.log(table);
}
