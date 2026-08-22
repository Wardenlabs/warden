/**
 * Which tools each employee has actually been seen using.
 *
 * The console can list what an employee was *told* to install. That is not the
 * same as knowing whether they did, and the difference is the one an admin
 * cares about: a directory full of people whose tools were never wired up is a
 * gateway that governs nobody while looking fully deployed.
 *
 * There is no separate check-in for this. Every hook call already names the
 * tool it came from, so a request arriving from Claude Code is itself the
 * evidence that Claude Code is connected. Nothing is asked of the employee and
 * nothing new is stored about what they typed.
 *
 * In memory, resetting with the process, exactly like the quota counters. That
 * is honest for what it is — a liveness view, not a record. The audit log is
 * the record.
 */

export type Seen = {
  /** `claude-code`, `codex`, `opencode`, `cursor`, `generic`… */
  tool: string;
  at: string;
  count: number;
};

/** employee id → tool → last sighting. */
const seen = new Map<string, Map<string, Seen>>();

export function recordActivity(employeeId: string, tool: string | undefined): void {
  // A caller that did not say is not evidence about any particular tool, and
  // inventing one would put a wrong badge on somebody's card.
  if (!employeeId || !tool || tool === 'unknown') return;

  const byTool = seen.get(employeeId) ?? new Map<string, Seen>();
  const previous = byTool.get(tool);
  byTool.set(tool, {
    tool,
    at: new Date().toISOString(),
    count: (previous?.count ?? 0) + 1
  });
  seen.set(employeeId, byTool);
}

/** Tools this person has used, most recently seen first. */
export function activityFor(employeeId: string): Seen[] {
  return [...(seen.get(employeeId)?.values() ?? [])].sort((a, b) => b.at.localeCompare(a.at));
}

/** Everyone with at least one sighting, for the dashboard's headline count. */
export function connectedCount(): number {
  return seen.size;
}

/** Used by tests and the demo reset. */
export function resetActivity(): void {
  seen.clear();
}
