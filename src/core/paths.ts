import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { sha256 } from './hash';

/**
 * ExplainIT keeps everything that agents must never touch outside the workspace, under one home
 * directory. `EXPLAINIT_HOME` overrides it (tests, CI). Layout:
 *   <home>/hooks/           hook script + platform wrappers (integrity-hashed)
 *   <home>/sessions/        one JSON per running VS Code window: {pid, port, token, folders}
 *   <home>/state.json       adapter state, consent, integrity hashes
 *   <home>/logs/            rolling local log files (no telemetry, ever)
 *   <home>/workspaces/<key>/journal.jsonl
 *   <home>/workspaces/<key>/checkpoints/<id>.snap + index.json
 *   <home>/workspaces/<key>/cache.json   explanation cache (contentHash -> Explanation)
 */
export function explainitHome(): string {
  const override = process.env.EXPLAINIT_HOME;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), '.explainit');
}

export const HOME_LAYOUT = {
  hooks: () => path.join(explainitHome(), 'hooks'),
  sessions: () => path.join(explainitHome(), 'sessions'),
  stateFile: () => path.join(explainitHome(), 'state.json'),
  logs: () => path.join(explainitHome(), 'logs'),
  workspaces: () => path.join(explainitHome(), 'workspaces'),
  workspace: (folderPath: string) => path.join(explainitHome(), 'workspaces', workspaceKey(folderPath)),
  journal: (folderPath: string) => path.join(HOME_LAYOUT.workspace(folderPath), 'journal.jsonl'),
  checkpoints: (folderPath: string) => path.join(HOME_LAYOUT.workspace(folderPath), 'checkpoints'),
  cache: (folderPath: string) => path.join(HOME_LAYOUT.workspace(folderPath), 'cache.json'),
  backfill: (folderPath: string) => path.join(HOME_LAYOUT.workspace(folderPath), 'backfill.json'),
};

/** Stable key for a workspace folder, derived from its canonical path. */
export function workspaceKey(folderPath: string): string {
  return sha256(canonicalPath(folderPath)).slice(0, 16);
}

/**
 * realpath when the path exists; otherwise realpath of the nearest existing ancestor joined with the
 * remaining segments. Normalises separators and (on Windows) lower-cases the drive letter.
 */
export function canonicalPath(p: string): string {
  let abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      abs = rest.length ? path.join(real, ...rest.reverse()) : real;
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  if (process.platform === 'win32') {
    abs = abs.replace(/^([a-zA-Z]):/, (_m, d: string) => d.toLowerCase() + ':');
  }
  return abs;
}

/** True when `child` is `parent` or lives underneath it (both canonicalised). */
export function isInside(parent: string, child: string): boolean {
  const p = canonicalPath(parent);
  const c = canonicalPath(child);
  const rel = path.relative(p, c);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write a file readable only by the current user (best effort on Windows). */
export function writePrivateFile(file: string, data: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}
