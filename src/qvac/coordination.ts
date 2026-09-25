import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelRole } from './types.js';

/** A queued writer stops new readers, while an existing decision may finish its
 * nested calls. A swap must not unload weights under a generation, or change
 * the prompt dialect between the rules of the same decision. */
export class RoleCoordinator {
  #readers = 0;
  #writer = false;
  #queue: { write: boolean; enter: () => void }[] = [];

  #drain(): void {
    if (this.#writer) return;
    while (this.#queue.length) {
      const next = this.#queue[0]!;
      if (next.write && this.#readers) return;
      this.#queue.shift();
      if (next.write) this.#writer = true;
      else this.#readers++;
      next.enter();
      if (next.write) return;
    }
  }

  /** A writer holds the role or is waiting for it. Read-only, for the desktop
   * updater, which must not restart the gateway under a model swap. */
  changing(): boolean {
    return this.#writer || this.#queue.some((entry) => entry.write);
  }
  async run<T>(write: boolean, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const entry = { write, enter: () => { signal?.removeEventListener('abort', abort); resolve(); } };
      const abort = () => {
        const index = this.#queue.indexOf(entry);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        reject(signal?.reason);
        this.#drain();
      };
      if (signal?.aborted) { reject(signal.reason); return; }
      this.#queue.push(entry);
      signal?.addEventListener('abort', abort, { once: true });
      this.#drain();
    });
    // Cancellation only removes queued admission. Once entered, native work
    // owns the lease until it settles; abort must never unload weights under it.
    try { signal?.throwIfAborted(); return await work(); }
    finally {
      if (write) this.#writer = false;
      else this.#readers--;
      this.#drain();
    }
  }
}

const roles = new Map<ModelRole, RoleCoordinator>();
const context = new AsyncLocalStorage<ReadonlySet<ModelRole>>();
function coordinator(role: ModelRole): RoleCoordinator {
  if (!roles.has(role)) roles.set(role, new RoleCoordinator());
  return roles.get(role)!;
}

export function withModelRole<T>(role: ModelRole, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const held = context.getStore();
  if (held?.has(role)) return work();
  return coordinator(role).run(false, () => context.run(new Set([...(held ?? []), role]), work), signal);
}

/** Whether any role is being swapped or has a swap queued. */
export function roleChangePending(): boolean {
  return [...roles.values()].some((role) => role.changing());
}
export function withRoleChange<T>(role: ModelRole, work: () => Promise<T>): Promise<T> {
  if (context.getStore()?.has(role)) throw new Error('cannot change a model from inside its active request');
  return coordinator(role).run(true, work);
}
