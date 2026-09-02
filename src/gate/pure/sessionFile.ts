/**
 * Session discovery files: `<home>/sessions/<pid>.json` (GateSessionInfo), private to the user.
 * The hook script reads these to find a running gate. Pure Node.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GateSessionInfo } from '../../core/interfaces';
import { ensureDir, writePrivateFile } from '../../core/paths';

export function sessionFilePath(dir: string, pid: number): string {
  return path.join(dir, `${pid}.json`);
}

export function writeSessionFile(dir: string, info: GateSessionInfo): string {
  const file = sessionFilePath(dir, info.pid);
  writePrivateFile(file, JSON.stringify(info, null, 2) + '\n');
  return file;
}

export function removeSessionFile(dir: string, pid: number): void {
  try {
    fs.rmSync(sessionFilePath(dir, pid), { force: true });
  } catch {
    /* already gone */
  }
}

/** Default liveness probe: signal 0. EPERM means "alive but not ours". */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Delete session files whose pid is dead (or which are unreadable). Returns the removed file names. */
export function purgeDeadSessions(dir: string, isAlive: (pid: number) => boolean = pidAlive): string[] {
  ensureDir(dir);
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let pid = Number.parseInt(name.slice(0, -5), 10);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<GateSessionInfo>;
      if (typeof parsed.pid === 'number') pid = parsed.pid;
    } catch {
      pid = NaN;
    }
    if (!Number.isFinite(pid) || !isAlive(pid)) {
      try {
        fs.rmSync(file, { force: true });
        removed.push(name);
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

/** Read every readable session file (for the doctor / tests). */
export function readSessions(dir: string): GateSessionInfo[] {
  const out: GateSessionInfo[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as GateSessionInfo;
      if (parsed && typeof parsed.pid === 'number' && typeof parsed.port === 'number') out.push(parsed);
    } catch {
      /* skip */
    }
  }
  return out;
}
