/**
 * Which machines each person actually has Warden on, remembered across restarts.
 *
 * `activity.ts` already answers "is this person's Claude Code sending anything
 * *right now*", from traffic, in memory, resetting with the process. That is
 * honest for a liveness view and useless for the two questions an administrator
 * asks when somebody is not being judged: **did that machine ever connect at
 * all**, and **how long has it been quiet**. Neither survives a restart of the
 * gateway, so neither could be answered. This file is the long memory; the map
 * in `activity.ts` stays exactly what it is.
 *
 * ## Two facts, two sources, never merged
 *
 * **Traffic** the gateway knows by itself: a check that arrived is the proof,
 * and nothing can fake its absence. **Wiring** only the machine knows — the
 * gateway cannot read an employee's home directory — so it is *reported*, by
 * `POST /api/devices/report`, and a machine that has not reported leaves wiring
 * `undefined` rather than `false`. Those are different sentences on screen and
 * the difference matters: "not wired" is somebody's afternoon spent fixing
 * something that was never broken.
 *
 * ## The machine name is personal data
 *
 * `os.hostname()` usually has a person's name inside it. It is kept here, where
 * it is inventory an administrator reads on the screen next to that person, and
 * it must never reach `data/audit.jsonl` — the audit log stores prompt hashes
 * and not prompts precisely so that the governance record is not the largest
 * exposure in the system, and a hostname column would walk that back. If a
 * decision ever needs the machine attached, it gets `machineId`, which is a
 * salted hash the gateway cannot reverse.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { atomicJSON } from '../models/store.js';

const DEVICES_PATH = process.env['WARDEN_DEVICES_PATH'] ?? 'data/devices.json';

/**
 * What one tool on one machine reported about itself.
 *
 * `wired` is what the hook found when it looked; `how` is the tool's own
 * sentence about what wiring it would take, carried through so the console does
 * not have to keep a second copy of it.
 */
export const toolReportSchema = z.object({
  id: z.string().min(1).max(64),
  wired: z.boolean(),
  how: z.string().max(400).optional()
});
export type ToolReport = z.infer<typeof toolReportSchema>;

export const deviceSchema = z.object({
  /** `os.hostname()`. Personal data — see the header. Never in the audit log. */
  name: z.string().max(200).default(''),
  firstSeen: z.string(),
  lastSeen: z.string(),
  /**
   * What this machine last said about its own wiring, and when it said it.
   *
   * Absent means it has never reported, which is a first-class state and not a
   * synonym for "nothing is wired".
   */
  tools: z.array(toolReportSchema).optional(),
  reportedAt: z.string().optional(),
  hookVersion: z.string().max(64).optional(),
  /**
   * Set when this person's key was rotated, cleared by the first check that
   * arrives from this machine with the new one.
   *
   * Without it a rotation is invisible: the old key stops working instantly —
   * there is no grace period, by decision — and the only signal anybody gets is
   * an employee discovering they are refused. This turns that into something
   * the administrator can see on the screen where they pressed the button.
   */
  pendingSince: z.string().optional()
});
export type Device = z.infer<typeof deviceSchema>;

/** employee id → machine id → what is known about that machine. */
const storeSchema = z.record(z.string(), z.record(z.string(), deviceSchema));
export type DeviceStore = z.infer<typeof storeSchema>;

let cached: DeviceStore | null = null;

function load(): DeviceStore {
  if (cached) return cached;
  if (!existsSync(DEVICES_PATH)) return (cached = {});
  try {
    cached = storeSchema.parse(JSON.parse(readFileSync(DEVICES_PATH, 'utf8')));
  } catch {
    // Operational inventory, not a record anybody is accountable to. A file
    // that will not parse is rebuilt from the next report rather than being a
    // reason the gateway refuses to answer about anything else.
    cached = {};
  }
  return cached;
}

function save(store: DeviceStore): void {
  cached = store;
  // 0600 and gitignored: it holds hostnames, which are personal data.
  atomicJSON(DEVICES_PATH, store);
}

/** Only for tests, which swap `WARDEN_DEVICES_PATH` between cases. */
export function forgetDevices(): void {
  cached = null;
}

/**
 * A check arrived from this machine. Traffic, and only traffic.
 *
 * Deliberately does not touch `tools`: an arriving request proves that *this*
 * tool reached the gateway, and says nothing about the other three. Wiring is
 * reported, never inferred, and a sighting that quietly wrote `wired: true`
 * would be the gateway inventing the half of the picture it cannot see.
 */
export function recordMachineSeen(employeeId: string, machine: { id: string; name?: string }): void {
  if (!employeeId || !machine?.id) return;
  const store = load();
  const now = new Date().toISOString();
  const forPerson = store[employeeId] ?? {};
  const existing = forPerson[machine.id];
  const { pendingSince: _cleared, ...kept } = existing ?? {};
  save({
    ...store,
    [employeeId]: {
      ...forPerson,
      [machine.id]: {
        ...kept,
        // A machine that renames itself keeps its id and gets the new name.
        name: machine.name || existing?.name || '',
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now
        // `pendingSince` is dropped: a request arriving with the current key is
        // the proof that this machine picked up the rotation. That is the only
        // event that clears it, and it is why nothing else here writes it.
      }
    }
  });
}

/** This machine says what it found when it looked at its own configuration. */
export function recordWiringReport(
  employeeId: string,
  machine: { id: string; name?: string },
  tools: ToolReport[],
  hookVersion?: string
): void {
  if (!employeeId || !machine?.id) return;
  const store = load();
  const now = new Date().toISOString();
  const forPerson = store[employeeId] ?? {};
  const existing = forPerson[machine.id];
  save({
    ...store,
    [employeeId]: {
      ...forPerson,
      [machine.id]: {
        ...(existing ?? {}),
        name: machine.name || existing?.name || '',
        firstSeen: existing?.firstSeen ?? now,
        // A report is contact, so it is a sighting too — but not a *check*, and
        // the console reads `tools`/`reportedAt` for wiring and the traffic
        // counters in `activity.ts` for whether anything is being judged.
        lastSeen: existing?.lastSeen ?? now,
        tools,
        reportedAt: now,
        ...(hookVersion ? { hookVersion } : {})
      }
    }
  });
}

/**
 * Mark every machine of this person as waiting to pick up a new key.
 *
 * Called from the rotation itself rather than from the route, so that a key
 * issued from the console, from `/install`, or from anywhere added later all
 * leave the same mark. There is no grace period — the old key is dead the
 * instant this runs — so this flag is the entire warning an administrator gets
 * that somebody is about to start being refused.
 */
export function markPendingReconnect(employeeId: string): void {
  const store = load();
  const forPerson = store[employeeId];
  if (!forPerson || Object.keys(forPerson).length === 0) return;
  const now = new Date().toISOString();
  const marked: Record<string, Device> = {};
  for (const [machineId, device] of Object.entries(forPerson)) {
    // An earlier rotation nobody has reconnected from yet keeps its own date:
    // "pending since Tuesday" is the useful sentence, not "pending since now".
    marked[machineId] = { ...device, pendingSince: device.pendingSince ?? now };
  }
  save({ ...store, [employeeId]: marked });
}

/** Everything known about one person's machines, most recently seen first. */
export function devicesFor(employeeId: string): (Device & { machineId: string })[] {
  return Object.entries(load()[employeeId] ?? {})
    .map(([machineId, device]) => ({ machineId, ...device }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** The whole inventory, for the console's Team screen. */
export function allDevices(): Record<string, (Device & { machineId: string })[]> {
  const out: Record<string, (Device & { machineId: string })[]> = {};
  for (const employeeId of Object.keys(load())) out[employeeId] = devicesFor(employeeId);
  return out;
}
