/**
 * Keeps ExplainIT's files out of git without touching the team's shared .gitignore (REQ-004, goal
 * item 6): appends patterns to `<gitdir>/info/exclude`. Handles worktrees and submodules, where
 * `.git` is a FILE containing `gitdir: <path>` and the exclude file lives in the common dir. Node only.
 * Shared by the twin engine (`*_explain.txt`) and the instructions generator (files it creates).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const TWIN_IGNORE_PATTERN = '*_explain.txt';

export interface GitLocation {
  /** Directory that contains `.git` (the working tree root). */
  root: string;
  /** The repository's git directory (for worktrees: the per-worktree dir). */
  gitDir: string;
  /** Where `info/exclude` lives: `<gitDir>/commondir` when present, else gitDir. */
  commonDir: string;
}

/** Parse the content of a `.git` file: `gitdir: <path>` (relative paths resolve against `baseDir`). */
export function parseGitdirPointer(content: string, baseDir: string): string | undefined {
  const m = /^\s*gitdir\s*:\s*(.+?)\s*$/m.exec(content);
  if (!m) return undefined;
  const target = m[1].trim();
  return path.resolve(baseDir, target);
}

async function statKind(p: string): Promise<'dir' | 'file' | 'none'> {
  try {
    const st = await fs.promises.stat(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none';
  }
}

/** Walk up from `startDir` until a `.git` entry (directory or pointer file) is found. */
export async function findGitLocation(startDir: string): Promise<GitLocation | undefined> {
  let dir = path.resolve(startDir);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const kind = await statKind(dotGit);
    if (kind === 'dir') return { root: dir, gitDir: dotGit, commonDir: await resolveCommonDir(dotGit) };
    if (kind === 'file') {
      let gitDir: string | undefined;
      try {
        gitDir = parseGitdirPointer(await fs.promises.readFile(dotGit, 'utf8'), dir);
      } catch {
        gitDir = undefined;
      }
      if (gitDir && (await statKind(gitDir)) === 'dir') return { root: dir, gitDir, commonDir: await resolveCommonDir(gitDir) };
      return undefined; // a broken pointer: do not guess
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Worktrees keep a `commondir` file whose (usually relative) content points at the main .git. */
async function resolveCommonDir(gitDir: string): Promise<string> {
  try {
    const txt = (await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    if (txt) return path.resolve(gitDir, txt);
  } catch {
    /* not a worktree */
  }
  return gitDir;
}

/** True when a line of an ignore file equals the pattern (comments and blanks ignored). */
export function hasIgnoreLine(text: string, pattern: string): boolean {
  return text.split(/\r?\n/).some((l) => l.trim() === pattern);
}

/** Append `line` to ignore-file text, adding a newline first when the text does not end with one. */
export function appendIgnoreLine(text: string, line: string): string {
  if (text.length === 0) return line + '\n';
  return (text.endsWith('\n') ? text : text + '\n') + line + '\n';
}

export type ExcludeResult = 'added' | 'present' | 'no-git' | 'error';

/** Idempotently add `pattern` to `<commonDir>/info/exclude`, creating `info/` when needed. */
export async function ensureExcludePattern(startDir: string, pattern = TWIN_IGNORE_PATTERN): Promise<{ result: ExcludeResult; file?: string; error?: string }> {
  let loc: GitLocation | undefined;
  try {
    loc = await findGitLocation(startDir);
  } catch (e) {
    return { result: 'error', error: (e as Error).message };
  }
  if (!loc) return { result: 'no-git' };
  const file = path.join(loc.commonDir, 'info', 'exclude');
  try {
    let text = '';
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      text = '';
    }
    if (hasIgnoreLine(text, pattern)) return { result: 'present', file };
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, appendIgnoreLine(text, pattern), 'utf8');
    return { result: 'added', file };
  } catch (e) {
    return { result: 'error', file, error: (e as Error).message };
  }
}

/**
 * The exclude pattern for one file inside a repository: its path relative to the repo root, with
 * forward slashes and a leading slash so it matches only that file (`/docs/CLAUDE.md`).
 */
export function excludePatternForFile(repoRoot: string, file: string): string {
  const rel = path.relative(repoRoot, file).split(path.sep).join('/');
  return '/' + rel;
}

/** Keep one specific file out of git through the local exclude file (never the shared .gitignore). */
export async function ensureFileExcluded(file: string): Promise<{ result: ExcludeResult; pattern?: string; file?: string; error?: string }> {
  let loc: GitLocation | undefined;
  try {
    loc = await findGitLocation(path.dirname(file));
  } catch (e) {
    return { result: 'error', error: (e as Error).message };
  }
  if (!loc) return { result: 'no-git' };
  const pattern = excludePatternForFile(loc.root, file);
  const r = await ensureExcludePattern(path.dirname(file), pattern);
  return { ...r, pattern };
}

/** The shared .gitignore path for the repository containing `startDir` (does not read or write it). */
export async function sharedGitignorePath(startDir: string): Promise<string | undefined> {
  const loc = await findGitLocation(startDir);
  return loc ? path.join(loc.root, '.gitignore') : undefined;
}

/** Append the pattern to a .gitignore file ONLY when it is not already present. Returns what happened. */
export async function addToGitignore(file: string, pattern = TWIN_IGNORE_PATTERN): Promise<'added' | 'present'> {
  let text = '';
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    text = '';
  }
  if (hasIgnoreLine(text, pattern)) return 'present';
  await fs.promises.writeFile(file, appendIgnoreLine(text, pattern), 'utf8');
  return 'added';
}
