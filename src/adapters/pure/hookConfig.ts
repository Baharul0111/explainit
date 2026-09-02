/**
 * Surgical JSON edits of the agents' hook configuration files.
 *   Claude: ~/.claude/settings.json      -> { ..., "hooks": { "PreToolUse": [ { matcher, hooks: [...] } ] } }
 *   Codex:  ~/.codex/hooks.json          -> { "hooks": { "PreToolUse": [ ... ] } }   (no other top-level keys allowed)
 * Both use the same group shape, so one set of helpers serves both. Our entries are recognised by
 * their command containing `explainit-hook`; everything else in the file is left untouched.
 */
import { sha256, canonicalJson } from '../../core/hash';

export type HookEvent = 'PreToolUse' | 'PostToolUse';

export interface HookEntrySpec {
  event: HookEvent;
  matcher: string;
  command: string;
  timeout: number;
}

export const OUR_MARK = 'explainit-hook';
export const CLAUDE_PRE_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
export const CLAUDE_POST_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit';
export const CODEX_PRE_MATCHER = 'apply_patch|Edit|Write|Bash';
export const CODEX_POST_MATCHER = 'apply_patch|Edit|Write';
export const PRE_TIMEOUT = 7200;
export const POST_TIMEOUT = 10;

/** `quotedWrapper` is the wrapper path already quoted for the shell (see shQuote/cmdQuote). */
export function claudeEntrySpecs(quotedWrapper: string, watchdogSeconds: number): HookEntrySpec[] {
  const w = Math.max(30, Math.floor(watchdogSeconds) || 120);
  return [
    { event: 'PreToolUse', matcher: CLAUDE_PRE_MATCHER, command: `${quotedWrapper} --agent claude --watchdog ${w}`, timeout: PRE_TIMEOUT },
    { event: 'PostToolUse', matcher: CLAUDE_POST_MATCHER, command: `${quotedWrapper} --agent claude --event PostToolUse`, timeout: POST_TIMEOUT },
  ];
}

export function codexEntrySpecs(quotedWrapper: string, watchdogSeconds: number): HookEntrySpec[] {
  const w = Math.max(30, Math.floor(watchdogSeconds) || 120);
  return [
    { event: 'PreToolUse', matcher: CODEX_PRE_MATCHER, command: `${quotedWrapper} --agent codex --watchdog ${w}`, timeout: PRE_TIMEOUT },
    { event: 'PostToolUse', matcher: CODEX_POST_MATCHER, command: `${quotedWrapper} --agent codex --event PostToolUse`, timeout: POST_TIMEOUT },
  ];
}

export function isOurHook(h: unknown): boolean {
  return !!h && typeof h === 'object' && typeof (h as any).command === 'string' && (h as any).command.includes(OUR_MARK);
}

type Root = Record<string, any>;

function groupsOf(root: Root, event: string): any[] {
  const g = root.hooks?.[event];
  return Array.isArray(g) ? g : [];
}

/** Removes every ExplainIT entry (and groups left empty by that) from `root`. Mutates and returns whether anything changed. */
export function removeOurEntries(root: Root): boolean {
  if (!root.hooks || typeof root.hooks !== 'object') return false;
  let changed = false;
  for (const event of Object.keys(root.hooks)) {
    const groups = root.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: any[] = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const others = g.hooks.filter((h: unknown) => !isOurHook(h));
      if (others.length === g.hooks.length) { kept.push(g); continue; }
      changed = true;
      if (others.length > 0) kept.push({ ...g, hooks: others });
    }
    if (kept.length !== groups.length) changed = true;
    if (kept.length === 0) delete root.hooks[event];
    else root.hooks[event] = kept;
  }
  if (Object.keys(root.hooks).length === 0) { delete root.hooks; changed = true; }
  return changed;
}

/** Replaces our entries with `specs` (appended after the user's own groups). Mutates and returns whether anything changed. */
export function upsertOurEntries(root: Root, specs: HookEntrySpec[]): boolean {
  const before = canonicalJson(root);
  removeOurEntries(root);
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) root.hooks = {};
  for (const s of specs) {
    const groups = groupsOf(root, s.event).slice();
    groups.push({ matcher: s.matcher, hooks: [{ type: 'command', command: s.command, timeout: s.timeout }] });
    root.hooks[s.event] = groups;
  }
  return canonicalJson(root) !== before;
}

export interface FoundEntry {
  event: string;
  groupIndex: number;
  handlerIndex: number;
  matcher: string | undefined;
  command: string;
  timeout: number | undefined;
}

export function findOurEntries(root: Root): FoundEntry[] {
  const out: FoundEntry[] = [];
  if (!root?.hooks || typeof root.hooks !== 'object') return out;
  for (const event of Object.keys(root.hooks)) {
    const groups = root.hooks[event];
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) => {
      if (!g || !Array.isArray(g.hooks)) return;
      g.hooks.forEach((h: any, hi: number) => {
        if (isOurHook(h)) out.push({ event, groupIndex: gi, handlerIndex: hi, matcher: g.matcher, command: h.command, timeout: h.timeout });
      });
    });
  }
  return out;
}

/** True when the file contains exactly our expected entries (matcher, command, timeout) and nothing extra of ours. */
export function entriesMatch(root: Root, specs: HookEntrySpec[]): { ok: boolean; detail: string } {
  const found = findOurEntries(root);
  const missing: string[] = [];
  for (const s of specs) {
    const hit = found.find((f) => f.event === s.event && f.matcher === s.matcher && f.command === s.command && f.timeout === s.timeout);
    if (!hit) missing.push(s.event);
  }
  const extra = found.length - (specs.length - missing.length);
  if (missing.length === 0 && extra === 0) return { ok: true, detail: 'Hook entries present and unchanged.' };
  const parts: string[] = [];
  if (missing.length) parts.push(`${missing.join(' and ')} entry missing or changed`);
  if (extra > 0) parts.push(`${extra} unexpected ExplainIT entr${extra === 1 ? 'y' : 'ies'}`);
  return { ok: false, detail: parts.join('; ') + '.' };
}

export function configHashFor(specs: HookEntrySpec[]): string {
  return sha256(canonicalJson(specs));
}

// ---- text-level helpers (keep the person's formatting as far as JSON allows) ----------------------

export interface ParsedJsonFile {
  value: Root | undefined;
  error?: string;
  indent: string;
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
}

export function parseJsonFile(text: string | undefined): ParsedJsonFile {
  const eol: '\n' | '\r\n' = text && text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = !text || /\r?\n$/.test(text);
  const indentMatch = text ? /^(?:\{|\[)\r?\n([ \t]+)/.exec(text) : null;
  const indent = indentMatch ? indentMatch[1] : '  ';
  if (text === undefined || text.trim() === '') return { value: {}, indent, eol, trailingNewline };
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    const v = JSON.parse(clean);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { value: undefined, error: 'top level is not an object', indent, eol, trailingNewline };
    return { value: v, indent, eol, trailingNewline };
  } catch (e) {
    return { value: undefined, error: (e as Error).message, indent, eol, trailingNewline };
  }
}

export function stringifyJsonFile(value: Root, fmt: Pick<ParsedJsonFile, 'indent' | 'eol' | 'trailingNewline'>): string {
  let text = JSON.stringify(value, null, fmt.indent);
  if (fmt.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return text + (fmt.trailingNewline ? fmt.eol : '');
}
