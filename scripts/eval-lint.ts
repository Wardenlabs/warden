/**
 * Validate the evaluation sets before anything is measured with them.
 *
 * Two checks, and the second one is the reason this file exists.
 *
 * **Schema.** Ids unique across every set, required fields present, `expect`
 * and `split` from the allowed values. Cheap, catches typos.
 *
 * **Contamination.** A prompt marked `split: "test"` must not appear verbatim
 * in any rule's few-shot examples. The model is shown those examples inside the
 * adjudication prompt, so scoring the guard on one measures whether the model
 * can copy an answer it was handed — not whether it can judge.
 *
 * This is not hypothetical. Five of the sixteen benign controls in the original
 * corpus are verbatim `compliant` examples in `benchmark-policy.json`, which is
 * 31% of the set that decides the headline false-positive number. They are kept
 * here as `split: "train"` so the contamination is recorded rather than
 * silently scored.
 *
 * Exits non-zero on any failure, so it can gate a run.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EVAL_DIR = process.env['WARDEN_EVAL_DIR'] ?? 'data/eval';
const POLICY_PATH =
  process.env['WARDEN_BENCHMARK_POLICY'] ?? 'data/seed/benchmark-policy.json';

const EXPECTS = new Set(['ALLOW', 'BLOCK', 'ESCALATE']);
const SPLITS = new Set(['train', 'test']);
const ORIGINS = new Set(['observed', 'corpus', 'authored']);

export type EvalPrompt = {
  id: string;
  text: string;
  lang: string;
  expect: 'ALLOW' | 'BLOCK' | 'ESCALATE';
  probes?: string | null;
  origin: 'observed' | 'corpus' | 'authored';
  split: 'train' | 'test';
  note?: string;
  /** Which file it came from. Added on load, not stored. */
  set?: string;
};

/** Every prompt in every set, in a stable order. */
export function loadEvalSets(dir = EVAL_DIR): EvalPrompt[] {
  const out: EvalPrompt[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      set?: string;
      prompts?: EvalPrompt[];
    };
    for (const p of parsed.prompts ?? []) out.push({ ...p, set: parsed.set ?? file });
  }
  return out;
}

const CORPUS_DIR = process.env['WARDEN_CORPUS_DIR'] ?? 'src/redteam/corpus';

/**
 * The attack corpus, read in place and adapted — never copied.
 *
 * `src/redteam/corpus/` is owned by `runner.ts` and is the single source of
 * truth for attacks. Duplicating it into `data/eval/` would guarantee the two
 * drift, so this reads the same files and maps them onto the eval shape.
 *
 * Two exclusions, both deliberate:
 *
 * `12-benign-controls` is skipped because `data/eval/benign-office.json` is its
 * migration, and scoring both would double-count sixteen prompts.
 *
 * **Prompts carrying an attachment are skipped** unless `includeAttachments` is
 * set. `OCR_LATIN` resolves to `registry://s3/...` rather than HuggingFace, so
 * `pnpm run setup` cannot fetch it and the OCR pass fails closed on every one of
 * them. They would score as "stopped" without anything having been read —
 * `REPORT.md` records 12 such attachments in the run behind its headline, which
 * is why its `document-borne` 8/8 is unearned. Counting them here would import
 * that same false credit.
 */
export function loadAttackCorpus(
  dir = CORPUS_DIR,
  opts: { includeAttachments?: boolean } = {}
): EvalPrompt[] {
  const out: EvalPrompt[] = [];
  let skipped = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      class?: string;
      prompts?: {
        id: string; text?: string; turns?: string[]; expect: string;
        lang?: string; attachment?: string;
      }[];
    };
    const set = parsed.class ?? file;
    if (set === 'benign-controls') continue;
    for (const p of parsed.prompts ?? []) {
      if (p.attachment && !opts.includeAttachments) { skipped++; continue; }
      out.push({
        id: p.id,
        text: p.turns ? p.turns.join('\n') : (p.text ?? ''),
        lang: p.lang ?? 'en',
        expect: p.expect as EvalPrompt['expect'],
        probes: null,
        origin: 'corpus',
        split: 'test',
        set
      });
    }
  }
  if (skipped > 0) {
    console.log(`  (${skipped} attachment prompt(s) skipped — OCR cannot load, they would fail closed)`);
  }
  return out;
}

/** Normalised for comparison: whitespace and case are not the interesting difference. */
function key(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function ruleExampleIndex(policyPath: string): Map<string, string> {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as {
    rules?: { id: string; examples?: { violating?: string[]; compliant?: string[] } }[];
  };
  const index = new Map<string, string>();
  for (const rule of policy.rules ?? []) {
    const all = [...(rule.examples?.violating ?? []), ...(rule.examples?.compliant ?? [])];
    for (const example of all) index.set(key(example), rule.id);
  }
  return index;
}

function main(): void {
  const prompts = loadEvalSets();
  const examples = ruleExampleIndex(POLICY_PATH);
  const errors: string[] = [];
  const warnings: string[] = [];

  const seen = new Map<string, string>();
  const seenText = new Map<string, string>();

  for (const p of prompts) {
    const where = `${p.set}/${p.id}`;
    if (seen.has(p.id)) errors.push(`duplicate id "${p.id}" (${seen.get(p.id)} and ${where})`);
    seen.set(p.id, where);

    const k = key(p.text);
    if (seenText.has(k)) errors.push(`duplicate text in ${where} and ${seenText.get(k)}`);
    seenText.set(k, where);

    if (!p.text?.trim()) errors.push(`${where}: empty text`);
    if (!EXPECTS.has(p.expect)) errors.push(`${where}: expect must be one of ${[...EXPECTS].join('|')}`);
    if (!SPLITS.has(p.split)) errors.push(`${where}: split must be train|test`);
    if (!ORIGINS.has(p.origin)) errors.push(`${where}: origin must be ${[...ORIGINS].join('|')}`);
    if (!p.lang) errors.push(`${where}: missing lang`);

    const hit = examples.get(k);
    if (hit && p.split === 'test') {
      errors.push(
        `${where}: CONTAMINATED — this text is a few-shot example of "${hit}". ` +
          `Mark it split:"train" or reword it.`
      );
    }
    if (hit && p.split === 'train' && !p.note) {
      warnings.push(`${where}: train-split example of "${hit}" with no note explaining why`);
    }
  }

  const test = prompts.filter((p) => p.split === 'test');
  const byExpect = (v: string) => test.filter((p) => p.expect === v).length;
  const byLang = (l: string) => test.filter((p) => p.lang === l).length;

  console.log(`eval sets: ${new Set(prompts.map((p) => p.set)).size} files, ${prompts.length} prompts`);
  console.log(`  scored (split=test) : ${test.length}`);
  console.log(`  held out (train)    : ${prompts.length - test.length}`);
  console.log(`  ALLOW / BLOCK / ESC : ${byExpect('ALLOW')} / ${byExpect('BLOCK')} / ${byExpect('ESCALATE')}`);
  console.log(`  es / en             : ${byLang('es')} / ${byLang('en')}`);

  // The sampling error on a proportion, which is what decides whether a change
  // is readable at all. Printed so nobody quotes a delta smaller than it.
  const n = byExpect('ALLOW');
  if (n > 0) {
    const se = Math.sqrt(0.25 / n) * 100;
    console.log(`  ±${se.toFixed(1)} points — 1 s.e. on the false-positive rate at n=${n}`);
  }

  for (const w of warnings) console.log(`\n⚠ ${w}`);
  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  · ${e}`);
    process.exit(1);
  }
  console.log('\n✓ sets are valid and uncontaminated');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
