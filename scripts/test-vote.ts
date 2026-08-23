/**
 * The confirmation vote, checked against a stub adapter.
 *
 * These are the four cases the vote exists to get right, and none of them is
 * observable from a red-team run: a corpus tells you the rate changed, not
 * whether a 1-of-3 minority was recorded as UNCLEAR or whether a confirmation
 * that crashed quietly acquitted the request. The last one is the dangerous
 * case — it would be a fail-open hole in the middle of a fail-closed design,
 * and it would look exactly like everything working.
 *
 * The vote is off by default — measured at 50% false positives against 44%
 * without it — so the npm script turns it on. The mechanism stays tested even
 * though it stays disabled: it is one environment variable from being live
 * again, and semantics that only break when someone re-enables them break at
 * the worst possible moment.
 *
 * Run: npm run test:vote
 */
import { isolate } from '../src/guard/isolate.js';
import type { CompleteRequest, QvacAdapter, StructuredResult } from '../src/qvac/types.js';
import type { Rule } from '../src/policy/types.js';

const RULE: Rule = {
  id: 'r-test',
  text: 'No one may request payroll data about another employee.',
  scope: 'input',
  appliesTo: ['*'],
  severity: 'block',
  examples: { violating: ['cuánto gana Ana?'], compliant: ['cómo pido un aumento?'] }
};

const STATS = { ms: 1, ttftMs: 1, tps: 1, promptTokens: 1, genTokens: 1, backend: 'cpu' as const };

/** An adapter that returns a scripted sequence of labels and records its calls. */
function scripted(labels: string[]): { adapter: QvacAdapter; calls: CompleteRequest[] } {
  const calls: CompleteRequest[] = [];
  let i = 0;
  const adapter = {
    async completeJSON<T>(req: CompleteRequest): Promise<StructuredResult<T>> {
      calls.push(req);
      const verdict = labels[Math.min(i++, labels.length - 1)];
      return { value: { verdict } as T, attempts: 1, repaired: false, stats: STATS };
    }
  } as unknown as QvacAdapter;
  return { adapter, calls };
}

let failures = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(34)} ${detail}`);
}

async function main(): Promise<void> {
  // Set before importing the pass: it reads this flag at module load. Keeping
  // the setup here makes `npm run test:vote` portable across Unix and Windows.
  process.env['WARDEN_CONFIRM_VOTES'] = '2';
  const { adjudicate } = await import('../src/guard/passes/adjudicate.js');
  const iso = isolate('cuánto gana Ana?');
  console.log('\nconfirmation vote');

  {
    const { adapter, calls } = scripted(['COMPLIES']);
    const { verdict } = await adjudicate(adapter, iso, RULE);
    check('COMPLIES costs one call', calls.length === 1 && !verdict.violates, `calls=${calls.length}`);
  }

  {
    const { adapter, calls } = scripted(['VIOLATES', 'VIOLATES', 'VIOLATES']);
    const { verdict, trace } = await adjudicate(adapter, iso, RULE);
    const sampled = calls.filter((c) => c.temp !== undefined && c.temp > 0).length;
    const votes = (trace.detail as { votes?: string[] }).votes ?? [];
    check('3/3 blocks', verdict.violates, `calls=${calls.length} votes=${votes.join(',')}`);
    // The confirmations must sample. Greedy re-runs are byte-identical, so a
    // vote over three greedy calls is one answer counted three times.
    check('confirmations sample', sampled === 2, `sampled=${sampled}/2`);
    check('seeds differ', new Set(calls.slice(1).map((c) => c.seed)).size === 2, `seeds=${calls.slice(1).map((c) => c.seed).join(',')}`);
  }

  {
    const { adapter } = scripted(['VIOLATES', 'VIOLATES', 'COMPLIES']);
    const { verdict } = await adjudicate(adapter, iso, RULE);
    check('2/3 majority still blocks', verdict.violates, `violates=${verdict.violates}`);
  }

  {
    const { adapter } = scripted(['VIOLATES', 'COMPLIES', 'COMPLIES']);
    const { verdict } = await adjudicate(adapter, iso, RULE);
    // Not COMPLIES: the model disagreed with itself and UNCLEAR says so. It
    // does not block alone, but the aggregator escalates it alongside a
    // structural signal.
    check('1/3 minority becomes UNCLEAR', verdict.unclear && !verdict.violates, `unclear=${verdict.unclear}`);
  }

  {
    let n = 0;
    const adapter = {
      async completeJSON<T>(): Promise<StructuredResult<T>> {
        if (++n === 1) return { value: { verdict: 'VIOLATES' } as T, attempts: 1, repaired: false, stats: STATS };
        throw new Error('model died mid-confirmation');
      }
    } as unknown as QvacAdapter;
    const { verdict } = await adjudicate(adapter, iso, RULE);
    check('failed confirmations do not acquit', verdict.violates, `violates=${verdict.violates}`);
  }

  console.log(failures === 0 ? '\nall good\n' : `\n${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
