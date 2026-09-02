/**
 * Which Node runs the hook script, and the wrapper scripts that pin it.
 * Order: `node` on PATH -> well-known install locations -> VS Code's own executable
 * (Electron, which behaves as Node when ELECTRON_RUN_AS_NODE=1 is set by the wrapper).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256 } from '../core/hash';
import { ensureDir } from '../core/paths';
import { findOnPath, wellKnownNodeLocations } from './pure/pathLookup';
import { WRAPPER_CMD, WRAPPER_SH, wrapperCmdContent, wrapperShContent } from './pure/wrappers';

export interface NodeRuntime {
  path: string;
  /** Needs ELECTRON_RUN_AS_NODE=1 (VS Code / Cursor / VSCodium executable). */
  electron: boolean;
  source: 'path' | 'well-known' | 'electron';
}

export interface RuntimeProbe {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execPath?: string;
  homeDir?: string;
  isFile?: (p: string) => boolean;
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function resolveNodeRuntime(probe: RuntimeProbe = {}): NodeRuntime {
  const env = probe.env ?? process.env;
  const platform = probe.platform ?? process.platform;
  const execPath = probe.execPath ?? process.execPath;
  const homeDir = probe.homeDir ?? os.homedir();
  const isFile = probe.isFile ?? defaultIsFile;
  const onPath = findOnPath('node', { pathEnv: env.PATH ?? env.Path, pathExt: env.PATHEXT, platform, isFile });
  if (onPath) return { path: onPath, electron: false, source: 'path' };
  for (const cand of wellKnownNodeLocations(platform, homeDir, env as Record<string, string | undefined>)) {
    if (isFile(cand)) return { path: cand, electron: false, source: 'well-known' };
  }
  const base = path.basename(execPath).toLowerCase();
  const electron = !(base === 'node' || base === 'node.exe');
  return { path: execPath, electron, source: 'electron' };
}

export interface WrittenWrappers {
  sh: { path: string; hash: string };
  cmd: { path: string; hash: string };
}

/** Writes both wrappers (always both, so a synced home works on every OS) and returns their hashes. */
export function writeWrappers(hooksDir: string, runtime: NodeRuntime, scriptPath: string): WrittenWrappers {
  ensureDir(hooksDir);
  const input = { runtime: runtime.path, script: scriptPath, electron: runtime.electron };
  const sh = path.join(hooksDir, WRAPPER_SH);
  const cmd = path.join(hooksDir, WRAPPER_CMD);
  const shText = wrapperShContent(input);
  const cmdText = wrapperCmdContent(input);
  atomicWrite(sh, shText, 0o755);
  atomicWrite(cmd, cmdText, 0o755);
  return { sh: { path: sh, hash: sha256(shText) }, cmd: { path: cmd, hash: sha256(cmdText) } };
}

/** Write via a temp file + rename so a crash never leaves a half-written hook file. */
export function atomicWrite(file: string, content: string | Buffer, mode = 0o644): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    /* windows */
  }
  fs.renameSync(tmp, file);
}
