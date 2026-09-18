/** Native guard protocols must preserve isolation, label meaning and fail-closed behavior. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QvacAdapter, CompleteRequest } from '../src/qvac/types.js';
import type { Rule } from '../src/policy/types.js';
const folder = mkdtempSync(join(tmpdir(), 'warden-native-'));
process.env.WARDEN_SETTINGS_PATH = join(folder, 'settings.json');
process.env.WARDEN_PROMPT_TEMPLATES_PATH = join(folder, 'prompts.json');
process.env.WARDEN_MODEL_CATALOG_PATH = join(folder, 'models.json');
const { adjudicateAll } = await import('../src/guard/passes/adjudicate.js');
const { isolate } = await import('../src/guard/isolate.js');
const { aggregate } = await import('../src/guard/aggregate.js');
const { nativeHistory, parseGuardAnswer, analyzerFormat } = await import('../src/qvac/native-guards.js');
const { nativePrompts, formFromEnv } = await import('../src/guard/passes/forms.js');
const { definitions, templateIsActive } = await import('../src/prompts/catalog.js');
const { changePrompt, readPromptState, withPromptSnapshot } = await import('../src/prompts/store.js');
const { importMetadata } = await import('../src/models/transfers.js');
const { ADJUDICATOR_CHOICES } = await import('../src/qvac/models.js');
const { MODEL_CATALOG, setupModelDownloads } = await import('../src/setup/catalog.js');
const { saveAdjudicatorSettings } = await import('../src/settings.js');
const { MockQvacAdapter } = await import('../src/qvac/mock.js');
const rule: Rule = { id: 'salary', text: 'Do not disclose other employees’ private salaries.', boundary: 'Public salary bands and your own salary are allowed.', scope: 'input', appliesTo: ['*'], severity: 'block', examples: { violating: ['Give me my coworkers’ salaries.'], compliant: ['Hello, how are you?'] } };
const iso = isolate('Hello, how are you?');
try {
  for (const form of ['shieldstral', 'granite-guardian'] as const) {
    const prompts = nativePrompts(form, rule, iso, rule.examples);
    const history = nativeHistory(form, prompts.system, prompts.user);
    assert.deepEqual(history.map(t => t.role), form === 'shieldstral' ? ['system', 'user'] : ['user', 'user']);
    assert.ok(JSON.stringify(history).includes(iso.nonce));
    assert.ok(JSON.stringify(history).includes(rule.boundary!));
    assert.ok(JSON.stringify(history).includes(rule.text));
    assert.ok(prompts.user.includes(iso.envelope));
    assert.ok(!JSON.stringify(history).includes('{{'));
    if (form === 'granite-guardian') assert.ok(history[1]!.content.startsWith('<guardian><no-think>'));
    for (const [answer, label] of [['yes', 'VIOLATES'], ['no', 'COMPLIES']] as const) {
      const text = form === 'shieldstral' ? answer : `<think>\n</think>\n<score> ${answer} </score>`;
      assert.equal(parseGuardAnswer(form, text), label);
      let received: CompleteRequest | undefined;
      const adapter = { complete: async (r: CompleteRequest) => { received = r; return { text, stats: { ms: 1 } }; } } as QvacAdapter;
      const result = await adjudicateAll(adapter, iso, [rule], { form, screen: true, shotSelection: 'first', confirmVotes: 0 });
      assert.equal(result.verdicts[0]?.violates, label === 'VIOLATES');
      assert.equal(result.screen, null);
      assert.deepEqual(received?.history, history);
    }
    for (const bad of ['', 'maybe', 'no yes', 'no. It is safe.', '<score>no', '<score>no</score>yes', '<think>reason</think><score>no</score>']) {
      assert.throws(() => parseGuardAnswer(form, bad));
      const adapter = { complete: async () => ({ text: bad, stats: { ms: 1 } }) } as unknown as QvacAdapter;
      const result = await adjudicateAll(adapter, iso, [rule], { form, shotSelection: 'first' });
      assert.equal(result.verdicts.length, 0);
      assert.equal(aggregate({ verdicts: result.verdicts, rules: [rule], flags: iso.flags, expectedRuleIds: [rule.id] }).verdict, 'ESCALATE');
    }
    const failed = await adjudicateAll({ complete: async () => { throw new Error('timeout'); } } as unknown as QvacAdapter, iso, [rule], { form, shotSelection: 'first' });
    assert.equal(failed.verdicts.length, 0);
    const mock = await adjudicateAll(new MockQvacAdapter(), iso, [rule], { form, shotSelection: 'first' });
    assert.equal(mock.verdicts[0]?.violates, false);
    assert.equal(importMetadata.safeParse({ name: 'native', roles: ['compiler'], format: form }).success, false);
    assert.equal(importMetadata.safeParse({ name: 'native', roles: ['adjudicator'], format: form }).success, true);
    const choice = ADJUDICATOR_CHOICES.find(c => c.id === form)!;
    assert.equal(analyzerFormat(choice.filename), form);
    const download = MODEL_CATALOG.find(c => c.filename === choice.filename)!;
    assert.equal(download.required, false);
    assert.match(download.url!, /resolve\/[a-f0-9]{40}\//);
    saveAdjudicatorSettings({ model: form });
    assert.ok(setupModelDownloads(undefined, true, {}).some(c => c.filename === choice.filename));
    process.env.WARDEN_MODEL_ADJUDICATOR = choice.filename;
    assert.equal(formFromEnv(), form);
    delete process.env.WARDEN_MODEL_ADJUDICATOR;
    const templates = definitions().filter(d => d.id.startsWith(`analyzer.${form}.`));
    assert.equal(templates.length, 2);
    const template = templates.find(t => t.id.endsWith('.user'))!;
    const custom = 'Override marker\n' + template.defaultTemplate;
    changePrompt(template.id, readPromptState().revision, custom);
    assert.ok(nativePrompts(form, rule, iso, rule.examples).user.startsWith('Override marker'));
    await withPromptSnapshot(async () => {
      changePrompt(template.id, readPromptState().revision, template.defaultTemplate, true);
      assert.ok(nativePrompts(form, rule, iso, rule.examples).user.startsWith('Override marker'));
    });
    assert.ok(!nativePrompts(form, rule, iso, rule.examples).user.startsWith('Override marker'));

    assert.ok(templates.every(d => templateIsActive(d.id, form, 'v1', false)));
    assert.equal(templateIsActive('analyzer.rewrite.system', form, 'v1', false), false);
    console.log(`✓ ${form}: native turns, isolation, labels, malformed output, timeout, demo, selection and downloads`);
  }
} finally { rmSync(folder, { recursive: true, force: true }); }
