/**
 * PATH lookup without spawning a shell (works the same on Windows, macOS and Linux).
 */
import * as path from 'node:path';

export interface LookupEnv {
  pathEnv: string | undefined;
  /** Windows PATHEXT, e.g. ".COM;.EXE;.BAT;.CMD". Ignored on other platforms. */
  pathExt?: string | undefined;
  platform: NodeJS.Platform;
  isFile: (p: string) => boolean;
}

/** Candidate file names for `name` on this platform (Windows appends PATHEXT extensions). */
export function candidateNames(name: string, platform: NodeJS.Platform, pathExt?: string): string[] {
  if (platform !== 'win32') return [name];
  const exts = (pathExt && pathExt.trim() ? pathExt : '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  return hasExt ? [name] : [...exts.map((e) => name + e.toLowerCase()), name];
}

/** First existing executable named `name` in PATH order, or undefined. */
export function findOnPath(name: string, env: LookupEnv): string | undefined {
  if (!name) return undefined;
  // Use the target platform's path rules so the lookup is testable for Windows on any host.
  const P = env.platform === 'win32' ? path.win32 : path.posix;
  if (name.includes('/') || name.includes('\\')) return env.isFile(name) ? (P.isAbsolute(name) ? name : path.resolve(name)) : undefined;
  const dirs = (env.pathEnv ?? '').split(P.delimiter).filter((d) => d.trim());
  for (const dir of dirs) {
    for (const cand of candidateNames(name, env.platform, env.pathExt)) {
      const full = P.join(dir, cand);
      if (env.isFile(full)) return full;
    }
  }
  return undefined;
}

/**
 * Well-known install locations to try when VS Code was launched with a stripped PATH
 * (macOS Dock launches, some Linux desktops). Returned in preference order.
 */
export function wellKnownNodeLocations(platform: NodeJS.Platform, homeDir: string, env: Record<string, string | undefined>): string[] {
  if (platform === 'win32') {
    const out: string[] = [];
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
      if (base) out.push(path.join(base, 'nodejs', 'node.exe'));
    }
    if (env.APPDATA) out.push(path.join(env.APPDATA, 'nvm', 'node.exe'));
    return out;
  }
  const out = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/snap/bin/node'];
  out.push(path.join(homeDir, '.volta', 'bin', 'node'), path.join(homeDir, '.local', 'bin', 'node'));
  return out;
}

/** Accepts "node /abs/script.js" style values (split on the first space only when the value ends with .js). */
export function splitCliValue(value: string): { cmd: string; args: string[] } {
  const v = value.trim();
  if (v.toLowerCase().endsWith('.js')) {
    const i = v.indexOf(' ');
    if (i > 0) return { cmd: v.slice(0, i), args: [v.slice(i + 1).trim()] };
  }
  return { cmd: v, args: [] };
}
