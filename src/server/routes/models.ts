import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { builtinDownloads, type BuiltinDownloads } from '../../models/builtin-downloads.js';
import { catalogResponse, deleteModel, editModel, ModelManager, saveEndpoint, withModelManagement } from '../../models/manager.js';
import { managedRoleSchema, publicModel } from '../../models/store.js';
import { cancelDownload, downloadJobs, importLocalFile, importUpload, MAX_MODEL_BYTES, startDownload } from '../../models/transfers.js';
import { publicTransferError, TransferError } from '../../setup/model-files.js';
import { TransferBusyError } from '../../setup/transfer-lock.js';
import { isLoopback } from '../admin-auth.js';

/** Catalogue errors contain no endpoint response bodies or secrets. */
function route(work: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    void work(req, res).catch((error: unknown) => {
      if (res.headersSent || res.destroyed) return;
      const message = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join('.') || 'model'}: ${i.message}`).join('; ')
        : error instanceof Error ? error.message : 'Model operation failed';
      res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
    });
  };
}

/** Built-in transfers answer with a code the console can act on. The helper
 * above turns nearly everything into a 400, and "busy", "already there" and
 * "no such model" are three different rows in the Library. */
function transferFailure(res: Response, error: unknown): void {
  const failure = error instanceof TransferError ? error : publicTransferError(error);
  res.status(failure.code === 'model_directory_unwritable' ? 500 : failure.status)
    .json({ code: failure.code, error: failure.message, ...(failure instanceof TransferBusyError ? { active: failure.active } : {}) });
}

export function createModelRoutes(manager = new ModelManager(), downloads: BuiltinDownloads = builtinDownloads): Router {
  const routes = Router();
  routes.get('/api/settings/models', route(async (req, res) => res.json({ ...catalogResponse(downloads), importAvailable: isLoopback(req), maxUploadBytes: MAX_MODEL_BYTES })));
  routes.get('/api/settings/models/downloads', (_req, res) => res.json({ jobs: [...downloads.list(), ...downloadJobs()] }));
  routes.post('/api/settings/models/download', route(async (req, res) => res.status(202).json(startDownload(req.body))));
  // The id names a row in the shipped catalogue and the body names nothing: a
  // browser never supplies the address a gateway fetches or the path it writes.
  routes.post('/api/settings/models/builtins/:id/download', (req, res) => {
    try {
      if (!z.object({}).strict().safeParse(req.body ?? {}).success) throw new TransferError('invalid_download_request', 'A built-in download takes no fields. Choose the model by its Library row.');
      const started = downloads.start(String(req.params.id));
      res.status(started.status).json(started.body);
    } catch (error) { transferFailure(res, error); }
  });
  routes.delete('/api/settings/models/downloads/:id', (req, res, next) => {
    const id = String(req.params.id);
    if (!downloads.owns(id)) return next();
    try { res.status(202).json({ job: downloads.cancel(id) }); } catch (error) { transferFailure(res, error); }
  });
  routes.delete('/api/settings/models/downloads/:id', route(async (req, res) => { cancelDownload(String(req.params.id)); res.json({ ok: true }); }));

  routes.post('/api/settings/models/upload', route(async (req, res) => {
    if (!req.is('application/octet-stream')) return res.status(415).json({ error: 'Upload the GGUF as application/octet-stream' });
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const length = req.header('content-length');
      const entry = await importUpload(req, { name: req.query.name, filename: req.query.filename,
        roles: String(req.query.roles ?? '').split(','), format: req.query.format }, controller.signal, length === undefined ? null : Number(length));
      res.status(201).json(publicModel(entry));
    } finally { req.off('aborted', abort); }
  }));

  routes.post('/api/settings/models', route(async (req, res) => {
    if (req.body?.kind === 'local') {
      // Authentication alone does not grant filesystem access on a different
      // computer. Remote administrators use the streaming upload instead.
      if (!isLoopback(req)) return res.status(403).json({ error: 'Import a gateway path from that machine, or upload your GGUF file here' });
      const path = z.string().max(4096).parse(req.body.path);
      return res.status(201).json(publicModel(await importLocalFile(path, req.body)));
    }
    return withModelManagement(async () => res.status(201).json(publicModel(saveEndpoint(req.body))));
  }));
  routes.put('/api/settings/models/:id', route(async (req, res) => withModelManagement(async () => res.json(publicModel(editModel(String(req.params.id), req.body))))));
  routes.delete('/api/settings/models/:id', route(async (req, res) => withModelManagement(async () => { deleteModel(String(req.params.id)); res.json({ ok: true }); })));
  routes.post('/api/settings/models/:id/test', route(async (req, res) => withModelManagement(async () => {
    const started = Date.now();
    const role = managedRoleSchema.parse(req.body?.role);
    try { await manager.test(String(req.params.id), role); res.json({ ok: true, ms: Date.now() - started }); }
    catch (error) { res.status(400).json({ ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : 'Model test failed' }); }
  })));
  routes.post('/api/settings/models/:id/activate', route(async (req, res) => withModelManagement(async () => {
    await manager.activate(String(req.params.id), managedRoleSchema.parse(req.body?.role));
    res.json({ ok: true, ...catalogResponse(downloads) });
  })));
  return routes;
}

export const modelRoutes = createModelRoutes();
