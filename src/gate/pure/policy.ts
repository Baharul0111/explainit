/**
 * Protected-path policy (REQ-013, goal item 8) exactly as in CONTRACTS "Protected paths". Pure.
 *
 * The person's assistants must never be able to switch the checkpoint off, so every write that
 * could do that is refused with a plain-English reason. `.git/**` writes are allowed but handed to
 * the agent's own prompt with a warning. Everything is compared on canonical paths.
 */
import * as path from 'node:path';
import type { ProposedWrite } from '../../core/types';
import { canonicalPath, isInside } from '../../core/paths';
import type { ShellAnalysis } from './shell';

export interface PolicyContext {
  /** ExplainIT home (`explainitHome()`): hooks, sessions, state, journal, checkpoints, logs. */
  explainitHome: string;
  /** The person's home directory (`os.homedir()`); tests pass a temp folder. */
  userHome: string;
  /** Canonical workspace folders. */
  folders: string[];
  /** Extra protected files (e.g. the installed hook script path). */
  extraProtected?: string[];
  /**
   * Where Codex keeps `hooks.json` and `config.toml`: `$CODEX_HOME` when the person set it, else
   * `<userHome>/.codex`. The controller passes the environment value; tests pass a temp folder.
   */
  codexHome?: string;
}

/** Options for one policy check. */
export interface PolicyOptions {
  /**
   * The write came from a partial edit (Edit / MultiEdit / an apply_patch update) rather than a
   * whole-file write. `hooks.json` is nothing but hooks, so any partial edit of it is a hooks change,
   * even one that only reformats: the same rule the hook script applies.
   */
  partial?: boolean;
}

export type PolicyResult =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; warning: string };

const WIN = process.platform === 'win32';
const norm = (p: string): string => {
  const c = canonicalPath(p);
  return WIN ? c.toLowerCase() : c;
};
const sameFile = (a: string, b: string): boolean => norm(a) === norm(b);
const under = (parent: string, child: string): boolean => {
  try {
    return isInside(parent, child);
  } catch {
    return false;
  }
};

const CLAUDE_SETTINGS = ['settings.json', 'settings.local.json'];
const CODEX_FILES = ['hooks.json', 'config.toml'];

/** `$CODEX_HOME` when set, else `<userHome>/.codex` (mirrors the hook script and the installer). */
export function codexHomeOf(ctx: PolicyContext): string {
  const c = ctx.codexHome?.trim();
  return c ? path.resolve(c) : path.join(ctx.userHome, '.codex');
}

/** Basename and parent-folder name of a canonical path (case-folded on Windows). */
function tail(p: string): { base: string; parent: string } {
  const parts = norm(p).split(/[\\/]+/);
  return { base: parts[parts.length - 1] ?? '', parent: parts[parts.length - 2] ?? '' };
}

/**
 * `<anything>/.claude/settings.json` or `settings.local.json`: the user layer (`~/.claude`) and any
 * project layer. Claude Code reads the project layer from the folder the agent runs in, which may be
 * a sub-folder of the workspace, so the parent-folder name decides (same rule as the hook script).
 */
function isClaudeSettingsPath(p: string, ctx: PolicyContext): boolean {
  const t = tail(p);
  if (t.parent === '.claude' && CLAUDE_SETTINGS.includes(t.base)) return true;
  const roots = [ctx.userHome, ...ctx.folders];
  return roots.some((r) => CLAUDE_SETTINGS.some((f) => sameFile(path.join(r, '.claude', f), p)));
}

/** `<anything>/.codex/hooks.json|config.toml`, plus the same two files under `$CODEX_HOME`. */
function isCodexConfigPath(p: string, ctx: PolicyContext): boolean {
  const t = tail(p);
  if (t.parent === '.codex' && CODEX_FILES.includes(t.base)) return true;
  const roots = [codexHomeOf(ctx), path.join(ctx.userHome, '.codex'), ...ctx.folders.map((f) => path.join(f, '.codex'))];
  return roots.some((r) => CODEX_FILES.some((f) => sameFile(path.join(r, f), p)));
}

/** True when the path has a `.git` directory segment (any depth). */
export function isInsideGitDir(p: string): boolean {
  const parts = canonicalPath(p).split(/[\\/]+/);
  return parts.slice(0, -1).includes('.git');
}

export function isGitInfoExclude(p: string): boolean {
  const parts = canonicalPath(p).split(/[\\/]+/);
  const n = parts.length;
  return n >= 3 && parts[n - 1] === 'exclude' && parts[n - 2] === 'info' && parts[n - 3] === '.git';
}

/**
 * `.git/hooks/**` and `.git/config` (security review F2). Git runs hooks as the person, outside any
 * ExplainIT review, and `config` can point `core.hooksPath` anywhere or define aliases that run
 * commands, so both are denied outright rather than handed to the agent's own prompt.
 */
export function isGitHooksOrConfig(p: string): boolean {
  const parts = canonicalPath(p).split(/[\\/]+/);
  const i = parts.lastIndexOf('.git');
  if (i < 0 || i >= parts.length - 1) return false;
  if (parts[i + 1] === 'hooks') return true;
  return parts.length === i + 2 && parts[i + 1] === 'config';
}

/**
 * Claude settings: did the `hooks` object change? Returns 'unparseable' when either side is not
 * valid JSON (a missing before file counts as `{}`).
 */
export function claudeHooksChanged(before: string | null, after: string | null): boolean | 'unparseable' {
  const parse = (t: string | null): unknown => {
    if (t === null || t.trim() === '') return {};
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  const b = parse(before);
  const a = parse(after);
  if (b === undefined || a === undefined) return 'unparseable';
  // A missing hooks key and an empty hooks object mean the same thing: no hooks.
  const hooksOf = (v: unknown): unknown => {
    const h = v && typeof v === 'object' ? (v as Record<string, unknown>).hooks : undefined;
    if (h === undefined || h === null) return null;
    if (typeof h === 'object' && !Array.isArray(h) && Object.keys(h as object).length === 0) return null;
    return h;
  };
  return stableJson(hooksOf(b)) !== stableJson(hooksOf(a));
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * Words that mark a hook- or trust-related line in a codex config.toml: the hooks feature flag and
 * hook tables, our own hook, `trusted_hash = "sha256:..."` trust records and `enabled =` switches.
 * Same set as the hook script's TOML_TRUST_WORDS.
 */
const TOML_TRUST_WORDS = /hooks|explainit|trusted_hash|sha256:|enabled\s*=/i;

/**
 * The hook-related lines of a codex config.toml, in file order: any line matching
 * TOML_TRUST_WORDS, every line inside a `[features]` table, and every line inside a `[hooks...]`
 * table (trimmed; blank lines and comments ignored). Order matters: two `[hooks.state."..."]`
 * tables swapping their `trusted_hash` values keep the same set of lines but not the same sequence.
 */
export function codexHookLines(toml: string | null): string[] {
  if (!toml) return [];
  const out: string[] = [];
  let inRelevantTable = false;
  for (const raw of toml.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^\[.*\]$/.test(line)) {
      inRelevantTable = /^\[\s*features\s*\]$/.test(line) || /hooks/i.test(line);
      if (inRelevantTable || TOML_TRUST_WORDS.test(line)) out.push(line);
      continue;
    }
    if (inRelevantTable || TOML_TRUST_WORDS.test(line)) out.push(line);
  }
  return out;
}

/**
 * Best-effort TOML sanity check (no TOML parser is bundled). Outside a multi-line string or an open
 * array / inline table, every non-blank, non-comment line must be a table header or a `key = value`
 * line. Anything else means the hook lines cannot be trusted and the write is refused.
 */
export function tomlLooksValid(toml: string | null): boolean {
  if (toml === null || toml.trim() === '') return true;
  if (toml.includes('\0')) return false;
  let inMultiline = false;
  let depth = 0;
  for (const raw of toml.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (inMultiline) {
      if (/"""|'''/.test(line)) inMultiline = false;
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    if (depth > 0) {
      depth += bracketDelta(line);
      if (depth < 0) return false;
      continue;
    }
    if (/^\[.*\]$/.test(line)) continue;
    if (!/^[^=]+=/.test(line)) return false;
    const value = line.slice(line.indexOf('=') + 1).trim();
    const opens = (value.match(/"""|'''/g) ?? []).length;
    if (opens % 2 === 1) {
      inMultiline = true;
      continue;
    }
    depth = bracketDelta(value);
    if (depth < 0) return false;
  }
  return depth === 0 && !inMultiline;
}

/** Net count of `[`/`{` minus `]`/`}` outside quoted strings and comments on one line. */
function bracketDelta(line: string): number {
  const stripped = line.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''").replace(/#.*$/, '');
  let d = 0;
  for (const ch of stripped) {
    if (ch === '[' || ch === '{') d++;
    else if (ch === ']' || ch === '}') d--;
  }
  return d;
}

/**
 * Codex hooks.json / config.toml: did anything hook-related change? Both sides are the FULL file
 * content: the caller replays partial edits (Edit, MultiEdit, apply_patch) onto the current file
 * before asking. Returns 'unparseable' when either side cannot be read as JSON / TOML.
 */
export function codexHooksChanged(fileName: string, before: string | null, after: string | null): boolean | 'unparseable' {
  if (fileName.toLowerCase().endsWith('.json')) {
    // hooks.json is all hooks: any content change counts; unparseable JSON is refused.
    const parse = (t: string | null): unknown => {
      if (t === null || t.trim() === '') return {};
      try {
        return JSON.parse(t);
      } catch {
        return undefined;
      }
    };
    const b = parse(before);
    const a = parse(after);
    if (b === undefined || a === undefined) return 'unparseable';
    return stableJson(b) !== stableJson(a);
  }
  if (!tomlLooksValid(before) || !tomlLooksValid(after)) return 'unparseable';
  return codexHookLines(before).join('\n') !== codexHookLines(after).join('\n');
}

/**
 * Deny / ask / allow for one proposed write. `write.before` / `write.after` must be the FULL file
 * content on both sides (proposals.ts replays Edit / MultiEdit / apply_patch onto the current file
 * first), so the hooks comparison sees exactly what would land on disk.
 */
export function checkWritePolicy(write: ProposedWrite, ctx: PolicyContext, opts: PolicyOptions = {}): PolicyResult {
  const targets = [write.path, ...(write.newPath ? [write.newPath] : [])];
  for (const p of targets) {
    if (under(ctx.explainitHome, p)) {
      return {
        action: 'deny',
        reason: `ExplainIT: "${p}" is inside ExplainIT's own folder (hook scripts, sessions, journal and restore points). Assistants may not change it. Leave it alone and continue with the task.`,
      };
    }
    for (const extra of ctx.extraProtected ?? []) {
      if (extra && sameFile(extra, p)) {
        return { action: 'deny', reason: `ExplainIT: "${p}" is part of the ExplainIT checkpoint and may not be changed by an assistant.` };
      }
    }
    if (isGitInfoExclude(p)) {
      return {
        action: 'deny',
        reason: `ExplainIT: "${p}" keeps the plain-English twin files out of git and may not be changed by an assistant. Leave it alone and continue with the task.`,
      };
    }
    if (isGitHooksOrConfig(p)) {
      return {
        action: 'deny',
        reason: `ExplainIT: "${p}" is a git hook or the git config. Git runs those as the person, outside any review, so assistants may not change them. Ask the person to change git hooks or git config themselves and continue with the task.`,
      };
    }
    if (isClaudeSettingsPath(p, ctx)) {
      if (write.kind === 'delete' || write.kind === 'move') {
        return { action: 'deny', reason: `ExplainIT: "${p}" holds the Claude Code hooks that power the ExplainIT checkpoint. It may not be deleted or moved by an assistant.` };
      }
      const changed = claudeHooksChanged(write.before, write.after);
      if (changed === 'unparseable') {
        return { action: 'deny', reason: `ExplainIT: the proposed content for "${p}" is not valid JSON, so the hooks section cannot be verified. Only changes that leave the "hooks" section untouched are allowed.` };
      }
      if (changed) {
        return { action: 'deny', reason: `ExplainIT: the change to "${p}" would alter the "hooks" section, which powers the ExplainIT checkpoint. Assistants may change other settings but not hooks. Ask the person to change hooks themselves.` };
      }
    }
    if (isCodexConfigPath(p, ctx)) {
      if (write.kind === 'delete' || write.kind === 'move') {
        return { action: 'deny', reason: `ExplainIT: "${p}" holds the Codex hooks that power the ExplainIT checkpoint. It may not be deleted or moved by an assistant.` };
      }
      if (opts.partial && path.basename(p).toLowerCase() === 'hooks.json') {
        return {
          action: 'deny',
          reason: `ExplainIT: "${p}" is nothing but hooks, so any edit to it changes the hooks that power the ExplainIT checkpoint. Assistants may not change it. Ask the person to change hooks themselves.`,
        };
      }
      const changed = codexHooksChanged(path.basename(p), write.before, write.after);
      if (changed === 'unparseable') {
        return { action: 'deny', reason: `ExplainIT: the proposed content for "${p}" cannot be parsed, so the hook settings cannot be verified. Only changes that leave hook settings untouched are allowed.` };
      }
      if (changed) {
        return { action: 'deny', reason: `ExplainIT: the change to "${p}" would alter hook or hook-trust settings that power the ExplainIT checkpoint. Assistants may change other settings but not hooks. Ask the person to change hooks themselves.` };
      }
    }
  }
  for (const p of targets) {
    if (isInsideGitDir(p)) {
      return { action: 'ask', warning: `This change writes inside a .git folder (${p}). Git internals are not reviewed function by function; your normal permission prompt decides.` };
    }
  }
  return { action: 'allow' };
}

/**
 * Does a shell command mention a protected path? Returns the matched fragment for the reason.
 * Checked on the raw command text, case-insensitively on every platform (like the hook script: a
 * false deny only costs the person a retry by hand), with both separator styles.
 */
export function protectedPathMentioned(command: string, ctx: PolicyContext): string | undefined {
  const cmd = command.toLowerCase();
  const variants = (p: string): string[] => {
    const c = p.toLowerCase();
    return [...new Set([c, c.replace(/\\/g, '/'), c.replace(/\//g, '\\')])];
  };
  const candidates: string[] = [];
  candidates.push(...variants(ctx.explainitHome));
  for (const e of ctx.extraProtected ?? []) if (e) candidates.push(...variants(e));
  // Relative/short forms agents are likely to type.
  candidates.push(
    '.explainit',
    'explainit-hook',
    '.claude/settings',
    '.claude\\settings',
    '.codex/hooks',
    '.codex\\hooks',
    '.codex/config.toml',
    '.codex\\config.toml',
    '.git/info/exclude',
    '.git\\info\\exclude',
    '.git/hooks',
    '.git\\hooks',
    '.git/config',
    '.git\\config',
    // `git config core.hooksPath <dir>` points every hook at a folder the assistant controls.
    'core.hookspath',
  );
  for (const f of CODEX_FILES) candidates.push(...variants(path.join(codexHomeOf(ctx), f)));
  for (const r of [ctx.userHome, ...ctx.folders]) {
    for (const f of CLAUDE_SETTINGS) candidates.push(...variants(path.join(r, '.claude', f)));
    for (const f of CODEX_FILES) candidates.push(...variants(path.join(r, '.codex', f)));
    candidates.push(...variants(path.join(r, '.git', 'info', 'exclude')));
  }
  for (const c of candidates) {
    if (c && cmd.includes(c)) return c;
  }
  return undefined;
}

export function protectedMentionReason(fragment: string): string {
  return `ExplainIT: this command mentions "${fragment}", which is part of the ExplainIT checkpoint (its hooks, settings, session files, journal or restore points). Assistants may not touch it. Leave it alone and continue with the task.`;
}

/**
 * Would writing this path from a shell command touch something protected? Shell writes cannot be
 * content-checked (there is no before/after to compare), so every protected file counts, not only
 * hooks changes. Returns a short description of what the path is for the reason text.
 */
export function protectedShellFile(p: string, ctx: PolicyContext): string | undefined {
  if (under(ctx.explainitHome, p)) return "ExplainIT's own folder (hook scripts, sessions, journal and restore points)";
  for (const e of ctx.extraProtected ?? []) if (e && sameFile(e, p)) return 'the ExplainIT hook script';
  if (isGitInfoExclude(p)) return '.git/info/exclude, which keeps the twin files out of git';
  if (isGitHooksOrConfig(p)) return 'a git hook or the git config, which git runs outside any review';
  if (sameFile(path.join(ctx.userHome, '.gitconfig'), p)) return 'the global git config, which decides where git looks for hooks in every repository';
  if (isClaudeSettingsPath(p, ctx)) return 'the Claude Code settings that hold the ExplainIT hooks';
  if (isCodexConfigPath(p, ctx)) return 'the Codex configuration that holds the ExplainIT hooks';
  return undefined;
}

/**
 * A directory an assistant's shell command may not change into (security review F4): the ExplainIT
 * home, the user-layer `.claude` / `.codex` folders (and `$CODEX_HOME`), and any `.claude`, `.codex`,
 * `.explainit` or `.git` folder at any depth. A command that starts there can write protected files
 * with bare names (`cd ~/.claude && cat > settings.json`), so the cd itself is refused.
 */
export function isProtectedDirectory(dir: string, ctx: PolicyContext): boolean {
  if (under(ctx.explainitHome, dir)) return true;
  const roots = [path.join(ctx.userHome, '.claude'), path.join(ctx.userHome, '.codex'), codexHomeOf(ctx)];
  if (roots.some((r) => under(r, dir))) return true;
  const parts = norm(dir).split(/[\\/]+/);
  return parts.some((s) => s === '.claude' || s === '.codex' || s === '.explainit' || s === '.git');
}

export interface ShellProtectedHit {
  kind: 'directory' | 'file';
  /** The resolved path that was hit. */
  path: string;
  /** What that path is, for the reason text (files only). */
  what?: string;
}

/**
 * Check a shell analysis (targets already resolved against the effective cwd) against the protected
 * paths: a cd into a protected directory, or a redirect / tee / in-place write onto a protected file.
 * Applies in every `checkpoint.shellWrites` mode: protection is never a matter of taste.
 */
export function shellProtectedTarget(analysis: Pick<ShellAnalysis, 'enteredDirs' | 'writeTargets'>, ctx: PolicyContext): ShellProtectedHit | undefined {
  for (const d of analysis.enteredDirs) {
    if (isProtectedDirectory(d, ctx)) return { kind: 'directory', path: d };
  }
  for (const t of analysis.writeTargets) {
    const what = protectedShellFile(t, ctx);
    if (what) return { kind: 'file', path: t, what };
  }
  return undefined;
}

export function protectedShellReason(hit: ShellProtectedHit): string {
  if (hit.kind === 'directory') {
    return `ExplainIT: this command changes into "${hit.path}", which holds files that keep the ExplainIT checkpoint working (hooks, settings, session files, journal or restore points). Assistants may not work inside it. Leave it alone and continue with the task.`;
  }
  return `ExplainIT: this command would write "${hit.path}", which is ${hit.what}. Assistants may not change it from a shell command. Leave it alone and continue with the task.`;
}
