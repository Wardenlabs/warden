import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { privateDirectory, regularFile, TransferError } from './model-files.js';

export type TransferOwner = { name: string; source: string; jobId: string | null };
const ownerSchema = z.object({ name: z.string(), source: z.string(), jobId: z.string().nullable(), pid: z.number().int().positive(), token: z.string().uuid() });
type Owner = z.infer<typeof ownerSchema>;
const leases = new Map<string, TransferLease>();
export type TransferLease = { path: string; token: string; release: () => void };
export class TransferBusyError extends TransferError {
  constructor(public readonly active: TransferOwner) { super('transfer_busy', `${active.name} is being transferred. Finish or cancel it first.`, 409); }
}
function ownerAt(path: string): Owner | null {
  if (!regularFile(path)) return null;
  try { return ownerSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw new TransferBusyError({ name: 'An interrupted setup with unreadable ownership', source: 'external', jobId: null }); }
}
/** Our own PID with no lease in this process is a previous gateway's lock: a
 * container restarts as PID 1 every time, and treating that as a live owner
 * would leave transfers busy until somebody deleted the file by hand. */
function dead(pid: number, token?: string): boolean {
  if (pid === process.pid) return ![...leases.values()].some((lease) => lease.token === token);
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** The ownership token stays on disk; a busy response names the transfer only. */
function named(owner: Owner | null): TransferOwner { return owner ? { name: owner.name, source: owner.source, jobId: owner.jobId } : { name: 'Another model', source: 'external', jobId: null }; }
function lockPath(dir: string, create = false): string { return join(privateDirectory(dir, create), 'transfer.lock'); }
export function currentTransfer(dir: string): TransferOwner | null {
  const owner = ownerAt(lockPath(dir));
  if (!owner || dead(owner.pid, owner.token)) return null;
  return named(owner);
}
export function acquireTransfer(dir: string, input: TransferOwner): TransferLease {
  const path = lockPath(dir, true);
  const prior = ownerAt(path);
  if (prior) {
    if (!dead(prior.pid, prior.token)) throw new TransferBusyError(named(prior));
    const reclaim = `${path}.reclaim`;
    try { mkdirSync(reclaim, { mode: 0o700 }); }
    catch { throw new TransferBusyError({ name: 'Model transfer recovery', source: 'external', jobId: null }); }
    try {
      const current = ownerAt(path);
      if (current && current.token === prior.token && dead(current.pid, current.token)) unlinkSync(path);
    } finally { rmdirSync(reclaim); }
  }
  const owner: Owner = { ...input, pid: process.pid, token: randomUUID() };
  try { writeFileSync(path, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TransferBusyError(named(ownerAt(path)));
    throw error;
  }
  const lease: TransferLease = { path, token: owner.token, release() {
    if (leases.get(path) !== lease) return;
    if (ownerAt(path)?.token === lease.token) unlinkSync(path);
    leases.delete(path);
  } };
  leases.set(path, lease);
  return lease;
}
export function validateTransferLease(dir: string, lease: TransferLease): void {
  const path = lockPath(dir, true);
  if (lease.path !== path || leases.get(path) !== lease || ownerAt(path)?.token !== lease.token) throw new TransferError('invalid_transfer_lease', 'The model transfer no longer owns its destination.', 409);
}
