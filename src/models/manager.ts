import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { activeLocalModel, forgetRole, modelFor } from '../qvac/client.js';
import { RoleCoordinator, withRoleChange } from '../qvac/coordination.js';
import { refreshCompiler, remoteCompiler } from '../qvac/index.js';
import { RealQvacAdapter } from '../qvac/real.js';
import { RemoteCompilerAdapter, validate } from '../qvac/remote.js';
import { loadAdjudicatorSettings, loadCompilerSettings, saveAdjudicatorSettings, saveCompilerSettings, type CompilerSettings } from '../settings.js';
import { isKevChoice } from '../qvac/kev.js';
import { builtinDownloads, type BuiltinDownloads } from './builtin-downloads.js';
import { findModel, fingerprint, formatSchema, managedRoleSchema, modelPath, publicModel, putModel, readCatalog, recordTest, removeModel, testedRoles, type ManagedRole, type ModelEntry } from './store.js';

const operations = new RoleCoordinator();
/** Persistence changes and tests serialize so a test cannot stamp approval on
 * a connection another browser just edited. Inference still runs concurrently. */
export function withModelManagement<T>(work: () => Promise<T>): Promise<T> { return operations.run(true, work); }

export function selections(): Record<ManagedRole, string | null> {
  const compiler = loadCompilerSettings();
  return { compiler: compiler.provider === 'catalog' ? compiler.modelId ?? null : null,
    adjudicator: loadAdjudicatorSettings().modelId ?? null };
}
export function selectedRoles(id: string): ManagedRole[] {
  const selected = selections();
  return (['compiler', 'adjudicator'] as const).filter((role) => selected[role] === id || activeLocalModel(role) === `${id}.gguf`);
}
export function modelOverride(role: ManagedRole): boolean {
  return Boolean(process.env[`WARDEN_MODEL_${role.toUpperCase()}`] || (role === 'compiler' &&
    (process.env['WARDEN_COMPILER_CLI'] || process.env['WARDEN_COMPILER_API'])));
}
/** Which jobs a built-in file is doing right now, from what is loaded rather
 * than what is saved: a compiler running through a CLI is not the Qwen file,
 * and a file that matches the configured default but never loaded is not active. */
function builtinRoles(filename: string, choice: string, roles: readonly ManagedRole[]) {
  const selected = selections();
  const compiler = loadCompilerSettings();
  const saved = { compiler: compiler.provider === 'local' && !selected.compiler,
    adjudicator: !selected.adjudicator && loadAdjudicatorSettings().model === choice };
  const running = (role: ManagedRole) => !modelOverride(role) && activeLocalModel(role) === filename && (role !== 'compiler' || !remoteCompiler());
  return { activeRoles: roles.filter(running), selectedRoles: roles.filter((role) => saved[role] && !modelOverride(role)) };
}
export function catalogResponse(downloads: BuiltinDownloads = builtinDownloads) {
  const judge = loadAdjudicatorSettings();
  const adjudicatorInForce = !process.env['WARDEN_MODEL_ADJUDICATOR'] && !judge.modelId && isKevChoice(judge.model)
    ? judge.model : activeLocalModel('adjudicator');
  return { builtins: downloads.builtins().map((builtin) => ({ ...builtin, ...builtinRoles(builtin.filename, builtin.adjudicatorChoice, builtin.roles) })),
    transfer: downloads.transfer(), models: readCatalog().map((entry) => publicModel(entry, selectedRoles(entry.id).filter((role) => !modelOverride(role)))), selections: selections(),
    overrides: { compiler: modelOverride('compiler'), adjudicator: modelOverride('adjudicator') },
    inForce: { compiler: remoteCompiler() ?? activeLocalModel('compiler'), adjudicator: adjudicatorInForce } };
}

const endpointInput = z.object({ kind: z.literal('endpoint'), name: z.string().trim().min(1).max(100),
  baseUrl: z.string().max(400), model: z.string().trim().min(1).max(120), apiKey: z.string().max(400).optional(), clearKey: z.boolean().optional() });

export function saveEndpoint(raw: unknown, id?: string): ModelEntry {
  const input = endpointInput.parse(raw);
  const previous = id ? findModel(id) : null;
  if (previous && previous.kind !== 'endpoint') throw new Error('A local model cannot become an endpoint');
  if (id && selectedRoles(id).length) throw new Error('Select a different model before editing this active connection');
  const sameEndpoint = previous?.kind === 'endpoint' && previous.baseUrl === input.baseUrl.replace(/\/+$/, '');
  const key = input.clearKey ? '' : input.apiKey || (sameEndpoint ? previous!.apiKey : '') || '';
  const checked = validate({ ...input, apiKey: key, timeoutMs: 60_000 });
  return putModel({ id: id ?? randomUUID(), name: input.name, kind: 'endpoint', roles: ['compiler'],
    baseUrl: checked.baseUrl, model: checked.model, apiKey: checked.apiKey, revision: (previous?.revision ?? 0) + 1, tests: {} });
}
export function editModel(id: string, raw: unknown): ModelEntry {
  const previous = findModel(id);
  if (previous.kind === 'endpoint') return saveEndpoint(raw, id);
  if (selectedRoles(id).length) throw new Error('Select a different model before editing this active model');
  const next = z.object({ name: z.string().trim().min(1).max(100), roles: z.array(managedRoleSchema).min(1).max(2), format: formatSchema }).parse(raw);
  return putModel({ ...previous, ...next, roles: [...new Set(next.roles)], revision: previous.revision + 1, tests: {} });
}
export function deleteModel(id: string): void {
  if (selectedRoles(id).length) throw new Error('Select a different model before deleting this active model');
  removeModel(id);
}

export async function testEndpoint(config: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number }): Promise<void> {
  const endpoint = validate({ ...config, timeoutMs: config.timeoutMs ?? 20_000 });
  const adapter = new RemoteCompilerAdapter(new RealQvacAdapter(), endpoint);
  try { await adapter.completeJSON({ role: 'compiler', system: 'Return JSON with exactly one field: status.',
    user: 'Return {"status":"ready"}.', maxTokens: 32, timeoutMs: endpoint.timeoutMs },
  z.object({ status: z.literal('ready') }), { type: 'object', properties: { status: { type: 'string', enum: ['ready'] } }, required: ['status'], additionalProperties: false }); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    // JSON parser errors can quote the provider's response. A connection test
    // must not echo a provider's diagnostic (or a credential it echoed) to UI.
    if (/schema-invalid|message content|JSON|Unexpected token/i.test(message)) throw new Error('The endpoint did not produce the required structured response');
    throw new Error(config.apiKey ? message.split(config.apiKey).join('[redacted]') : message || 'The endpoint test failed');
  }
}

export type ModelRuntime = {
  testLocal: (entry: Extract<ModelEntry, { kind: 'local' }>, role: ManagedRole) => Promise<void>;
  load: (role: ManagedRole) => Promise<unknown>;
  forget: (role: ManagedRole) => Promise<void>;
};
const defaultRuntime: ModelRuntime = {
  testLocal: (entry, role) => new RealQvacAdapter().testLocal(modelPath(entry), role, entry.format),
  load: modelFor, forget: forgetRole
};

export class ModelManager {
  constructor(private readonly runtime: ModelRuntime = defaultRuntime) {}

  async test(id: string, role: ManagedRole): Promise<void> {
    if (process.env['WARDEN_ADAPTER'] === 'llamacpp') throw new Error('Model management uses the QVAC runtime. Restart without the experimental llamacpp adapter to test models.');
    const entry = findModel(id);
    if (!(entry.roles as readonly ManagedRole[]).includes(role)) throw new Error('This model cannot fill that role');
    const before = fingerprint(entry);
    const tests = { ...entry.tests };
    delete tests[role];
    putModel({ ...entry, tests }, entry.revision);
    if (entry.kind === 'endpoint') await testEndpoint(entry);
    else await withRoleChange(role, async () => {
      // Free the old weights before loading a candidate: two 8B models can
      // exceed a laptop's memory. The current selection remains unchanged.
      await this.runtime.forget(role);
      await this.runtime.testLocal(entry, role);
    });
    recordTest(entry, role, before);
  }

  async activate(id: string, role: ManagedRole): Promise<void> {
    if (process.env['WARDEN_ADAPTER'] === 'llamacpp') throw new Error('Model management uses the QVAC runtime. Restart without the experimental llamacpp adapter to select models.');
    if (modelOverride(role)) throw new Error('The environment controls this role. Remove its override before selecting a saved model.');
    const entry = findModel(id);
    if (!(entry.roles as readonly ManagedRole[]).includes(role)) throw new Error('This model cannot fill that role');
    if (!testedRoles(entry).includes(role)) throw new Error('Test this model for this role before using it');
    // A saved endpoint can become unavailable independently of the catalogue.
    // Check it before replacing a working connection.
    if (entry.kind === 'endpoint') await testEndpoint(entry);
    await withRoleChange(role, async () => {
      const compiler = loadCompilerSettings();
      const adjudicator = loadAdjudicatorSettings();
      await this.runtime.forget(role);
      try {
        if (role === 'compiler') saveCompilerSettings({ ...compiler, provider: 'catalog', modelId: id });
        else saveAdjudicatorSettings({ ...adjudicator, modelId: id });
        refreshCompiler();
        // Selection is not success until local weights actually load. If the
        // file/runtime changed after the test, restore the previous selection.
        if (entry.kind === 'local') await this.runtime.load(role);
      } catch (error) {
        await this.runtime.forget(role);
        if (role === 'compiler') saveCompilerSettings(compiler); else saveAdjudicatorSettings(adjudicator);
        refreshCompiler();
        throw error;
      }
    });
  }
}

/** Legacy provider editing uses the same activation boundary as the catalogue.
 * Its saved values take effect on the next compiler call, without a restart. */
export async function applyCompilerSettings(next: CompilerSettings): Promise<CompilerSettings> {
  return withRoleChange('compiler', async () => {
    const saved = saveCompilerSettings(next);
    await forgetRole('compiler');
    refreshCompiler();
    return saved;
  });
}
