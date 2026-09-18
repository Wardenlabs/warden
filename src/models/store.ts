/** Models belong to this gateway installation. Secrets stay in a 0600 file;
 * catalogue responses are assembled field by field, never by spreading it. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export const managedRoleSchema = z.enum(['compiler', 'adjudicator']);
export type ManagedRole = z.infer<typeof managedRoleSchema>;
export const formatSchema = z.enum(['compliance', 'dynaguard', 'shieldstral', 'granite-guardian']);
const common = {
  id: z.string().uuid(), name: z.string().trim().min(1).max(100), revision: z.number().int().positive(),
  tests: z.record(z.string(), z.object({ fingerprint: z.string(), at: z.string() })).default({})
};
const endpointSchema = z.object({ ...common, kind: z.literal('endpoint'), roles: z.tuple([z.literal('compiler')]),
  baseUrl: z.string().max(400), model: z.string().trim().min(1).max(120), apiKey: z.string().max(400) });
const localSchema = z.object({ ...common, kind: z.literal('local'),
  roles: z.array(managedRoleSchema).min(1).max(2), format: formatSchema,
  filename: z.string().max(255), bytes: z.number().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mtimeMs: z.number() });
export const modelEntrySchema = z.discriminatedUnion('kind', [endpointSchema, localSchema]);
export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type LocalModel = Extract<ModelEntry, { kind: 'local' }>;
const catalogSchema = z.object({ version: z.literal(1), models: z.array(modelEntrySchema).max(100) });

export function catalogPath(): string {
  return process.env['WARDEN_MODEL_CATALOG_PATH'] ?? join(dirname(process.env['WARDEN_SETTINGS_PATH'] ?? 'data/settings.json'), 'models.json');
}
export function managedModelsDir(): string {
  return resolve(process.env['WARDEN_MODELS_DIR'] ?? 'models', 'custom');
}
export function modelPath(entry: Pick<LocalModel, 'id'>): string { return join(managedModelsDir(), `${entry.id}.gguf`); }

export function atomicJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function readCatalog(): ModelEntry[] {
  if (!existsSync(catalogPath())) return [];
  // Losing a corrupt catalogue must not look like permission to overwrite all
  // saved connections. Keep the original file and make the failure explicit.
  try { return catalogSchema.parse(JSON.parse(readFileSync(catalogPath(), 'utf8'))).models; }
  catch { throw new Error('The saved model catalogue is unreadable. Restore its file before changing models.'); }
}
export function findModel(id: string): ModelEntry {
  const entry = readCatalog().find((m) => m.id === id);
  if (!entry) throw new Error('Saved model not found');
  return entry;
}
export function putModel(entry: ModelEntry, expectedRevision?: number): ModelEntry {
  const next = modelEntrySchema.parse(entry);
  const models = readCatalog();
  const index = models.findIndex((m) => m.id === entry.id);
  if (expectedRevision !== undefined && (index < 0 || models[index]!.revision !== expectedRevision)) {
    throw new Error('This model changed while the operation was running. Try again.');
  }
  if (index < 0) models.push(next); else models[index] = next;
  atomicJSON(catalogPath(), catalogSchema.parse({ version: 1, models }));
  return next;
}
export function removeModel(id: string): void {
  const entry = findModel(id);
  atomicJSON(catalogPath(), { version: 1, models: readCatalog().filter((m) => m.id !== id) });
  if (entry.kind === 'local' && existsSync(modelPath(entry))) unlinkSync(modelPath(entry));
}
export function fingerprint(entry: ModelEntry): string {
  if (entry.kind === 'local') {
    const stat = statSync(modelPath(entry));
    if (!stat.isFile() || stat.size !== entry.bytes || stat.mtimeMs !== entry.mtimeMs) {
      throw new Error('The imported model file changed. Import and test it again.');
    }
    return `${entry.sha256}:${entry.format}:${entry.roles.join(',')}`;
  }
  return createHash('sha256').update(JSON.stringify([entry.baseUrl, entry.model, entry.apiKey])).digest('hex');
}
export function testedRoles(entry: ModelEntry): ManagedRole[] {
  let current: string;
  try { current = fingerprint(entry); } catch { return []; }
  return entry.roles.filter((role) => entry.tests[role]?.fingerprint === current);
}
export function recordTest(entry: ModelEntry, role: ManagedRole, before: string): void {
  if (fingerprint(findModel(entry.id)) !== before) throw new Error('The model changed during its test. Test it again.');
  putModel({ ...entry, tests: { ...entry.tests, [role]: { fingerprint: before, at: new Date().toISOString() } } }, entry.revision);
}
export function publicModel(entry: ModelEntry, activeRoles: ManagedRole[] = []) {
  return {
    id: entry.id, name: entry.name, kind: entry.kind, roles: entry.roles, revision: entry.revision,
    testedRoles: testedRoles(entry), activeRoles,
    ...(entry.kind === 'endpoint'
      ? { baseUrl: entry.baseUrl, model: entry.model, hasKey: Boolean(entry.apiKey), keyHint: entry.apiKey.length > 4 ? `…${entry.apiKey.slice(-4)}` : '' }
      : { filename: entry.filename, bytes: entry.bytes, format: entry.format })
  };
}
