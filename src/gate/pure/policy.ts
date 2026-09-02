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

export interface PolicyContext {
  /** ExplainIT home (`explainitHome()`): hooks, sessions, state, journal, checkpoints, logs. */
  explainitHome: string;
  /** The person's home directory (`os.homedir()`); tests pass a temp folder. */
  userHome: string;
  /** Canonical workspace folders. */
  folders: string[];
  /** Extra protected files (e.g. the installed hook script path). */
  extraProtected?: string[];
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

function isClaudeSettingsPath(p: string, ctx: PolicyContext): boolean {
  const roots = [ctx.userHome, ...ctx.folders];
  return roots.some((r) => CLAUDE_SETTINGS.some((f) => sameFile(path.join(r, '.claude', f), p)));
}

function isCodexConfigPath(p: string, ctx: PolicyContext): boolean {
  const roots = [ctx.userHome, ...ctx.folders];
  return roots.some((r) => CODEX_FILES.some((f) => sameFile(path.join(r, '.codex', f), p)));
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
 * The hook-related lines of a codex config.toml: any line mentioning `hooks`, every line inside a
 * `[features]` table, and every line inside a `[hooks...]` table (trimmed; comments ignored).
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
      if (inRelevantTable) out.push(line);
      continue;
    }
    if (inRelevantTable || /hooks/i.test(line)) out.push(line);
  }
  return out;
}

/** Codex hooks.json / config.toml: did anything hook-related change? */
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
  const bs = new Set(codexHookLines(before));
  const as = new Set(codexHookLines(after));
  if (bs.size !== as.size) return true;
  for (const l of bs) if (!as.has(l)) return true;
  return false;
}

/** Deny / ask / allow for one proposed write. */
export function checkWritePolicy(write: ProposedWrite, ctx: PolicyContext): PolicyResult {
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
      const changed = codexHooksChanged(path.basename(p), write.before, write.after);
      if (changed === 'unparseable') {
        return { action: 'deny', reason: `ExplainIT: the proposed content for "${p}" cannot be parsed, so the hook settings cannot be verified. Only changes that leave hook settings untouched are allowed.` };
      }
      if (changed) {
        return { action: 'deny', reason: `ExplainIT: the change to "${p}" would alter hook settings that power the ExplainIT checkpoint. Assistants may change other settings but not hooks. Ask the person to change hooks themselves.` };
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
 * Checked on the raw command text (case-insensitive on Windows) with both separator styles.
 */
export function protectedPathMentioned(command: string, ctx: PolicyContext): string | undefined {
  const cmd = WIN ? command.toLowerCase() : command;
  const variants = (p: string): string[] => {
    const c = WIN ? p.toLowerCase() : p;
    return [...new Set([c, c.replace(/\\/g, '/'), c.replace(/\//g, '\\')])];
  };
  const candidates: string[] = [];
  candidates.push(...variants(ctx.explainitHome));
  for (const e of ctx.extraProtected ?? []) if (e) candidates.push(...variants(e));
  // Relative/short forms agents are likely to type.
  candidates.push('.explainit', 'explainit-hook', '.claude/settings', '.claude\\settings', '.codex/hooks', '.codex\\hooks', '.codex/config.toml', '.codex\\config.toml', '.git/info/exclude', '.git\\info\\exclude');
  for (const r of [ctx.userHome, ...ctx.folders]) {
    for (const f of CLAUDE_SETTINGS) candidates.push(...variants(path.join(r, '.claude', f)));
    for (const f of CODEX_FILES) candidates.push(...variants(path.join(r, '.codex', f)));
    candidates.push(...variants(path.join(r, '.git', 'info', 'exclude')));
  }
  for (const c of candidates) {
    if (c && cmd.includes(WIN ? c.toLowerCase() : c)) return c;
  }
  return undefined;
}

export function protectedMentionReason(fragment: string): string {
  return `ExplainIT: this command mentions "${fragment}", which is part of the ExplainIT checkpoint (its hooks, settings, session files, journal or restore points). Assistants may not touch it. Leave it alone and continue with the task.`;
}
