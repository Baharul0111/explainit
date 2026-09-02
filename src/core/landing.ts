/**
 * Shared, process-local record of files the gate has just written (or allowed), so the Copilot
 * watcher and the twin staleness logic can tell a gate-approved landing from a foreign edit.
 */
const landed = new Map<string, number>();

export function recordLanding(canonicalPath: string): void {
  landed.set(canonicalPath, Date.now());
  if (landed.size > 500) {
    const cutoff = Date.now() - 60_000;
    for (const [k, t] of landed) if (t < cutoff) landed.delete(k);
  }
}

export function landedRecently(canonicalPath: string, withinMs = 5000): boolean {
  const t = landed.get(canonicalPath);
  return t !== undefined && Date.now() - t <= withinMs;
}
