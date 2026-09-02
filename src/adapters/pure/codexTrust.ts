/**
 * Codex only runs hooks the person has trusted. Trust is recorded in ~/.codex/config.toml as
 *   [hooks.state."<hooks.json path>:<event label>:<group index>:<handler index>"]
 *   trusted_hash = "sha256:<hex>"   enabled = true|false
 * (format read from codex-rs/hooks/src/lib.rs `hook_key`, config_rules.rs `hook_states_from_stack`
 * and engine/discovery.rs `hook_hash` on 2026-09-02). The hash is sha256 of the compact,
 * key-sorted JSON of the normalised hook identity. This file reproduces both so the Doctor can say
 * whether the ExplainIT hook is trusted; when nothing matches it says "unknown", never "trusted".
 */
import { sha256 } from '../../core/hash';

export interface HookState {
  enabled?: boolean;
  trusted_hash?: string;
}

const EVENT_LABEL: Record<string, string> = { PreToolUse: 'pre_tool_use', PostToolUse: 'post_tool_use' };

export function codexEventLabel(event: 'PreToolUse' | 'PostToolUse'): string {
  return EVENT_LABEL[event];
}

export function codexHookKey(hooksJsonPath: string, event: 'PreToolUse' | 'PostToolUse', groupIndex: number, handlerIndex: number): string {
  return `${hooksJsonPath}:${codexEventLabel(event)}:${groupIndex}:${handlerIndex}`;
}

/**
 * Quotes a string as a TOML basic string. Backslashes MUST be escaped: a Windows key written raw
 * (`"C:\Users\x\.codex\hooks.json:..."`) parses back with its separators eaten (`\U` -> `U`,
 * `\r` -> a carriage return), which is exactly how a trust record goes missing on Windows.
 */
export function tomlBasicString(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/** The exact `[hooks.state."<key>"]` table header Codex writes for one handler, on any platform. */
export function codexHookStateHeader(hooksJsonPath: string, event: 'PreToolUse' | 'PostToolUse', groupIndex: number, handlerIndex: number): string {
  return `[hooks.state.${tomlBasicString(codexHookKey(hooksJsonPath, event, groupIndex, handlerIndex))}]`;
}

export interface CodexHandlerIdentity {
  command: string;
  /** Codex normalises a missing timeout to 600 before hashing. */
  timeout?: number;
  async?: boolean;
  statusMessage?: string;
}

/** Mirrors `hook_hash` in codex-rs/hooks/src/engine/discovery.rs. */
export function codexHookHash(event: 'PreToolUse' | 'PostToolUse', matcher: string | undefined, handler: CodexHandlerIdentity): string {
  const h: Record<string, unknown> = { async: handler.async ?? false, command: handler.command, timeout: handler.timeout ?? 600, type: 'command' };
  if (handler.statusMessage !== undefined) h.statusMessage = handler.statusMessage;
  const identity: Record<string, unknown> = { event_name: codexEventLabel(event), hooks: [sortKeys(h)] };
  if (matcher !== undefined) identity.matcher = matcher;
  return 'sha256:' + sha256(JSON.stringify(sortKeys(identity)));
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

// ---- minimal TOML reader for the [hooks.state] table -----------------------------------------------

/** Splits a dotted TOML key into segments, honouring quoted segments ("a.b".c -> ["a.b", "c"]). */
export function splitTomlKey(key: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < key.length) { cur += unescapeChar(key[++i]); continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '.') { segs.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  segs.push(cur.trim());
  return segs;
}

function unescapeChar(c: string): string {
  return c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
}

function parseTomlScalar(raw: string): string | boolean | number | undefined {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1).replace(/\\(.)/g, (_m, c: string) => unescapeChar(c));
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  return undefined;
}

/** Parses `{ enabled = true, trusted_hash = "sha256:..." }`. */
function parseInlineTable(raw: string): HookState {
  const out: HookState = {};
  const body = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const part of splitTopLevel(body, ',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    applyField(out, splitTomlKey(part.slice(0, eq))[0], parseTomlScalar(part.slice(eq + 1)));
  }
  return out;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const c of s) {
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === sep) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function applyField(state: HookState, field: string, value: unknown): void {
  if (field === 'enabled' && typeof value === 'boolean') state.enabled = value;
  if (field === 'trusted_hash' && typeof value === 'string') state.trusted_hash = value;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** Reads every `[hooks.state]` entry from config.toml text. Tolerant: unknown or malformed lines are skipped. */
export function parseHookStates(toml: string): Record<string, HookState> {
  const states: Record<string, HookState> = {};
  let table: string[] = [];
  const get = (key: string): HookState => (states[key] ??= {});
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const header = /^\[\[?(.+?)\]\]?$/.exec(line);
    if (header) { table = splitTomlKey(header[1]); continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const keyPath = [...table, ...splitTomlKey(line.slice(0, eq))];
    const rawValue = line.slice(eq + 1).trim();
    if (keyPath[0] !== 'hooks' || keyPath[1] !== 'state' || keyPath.length < 3) continue;
    const hookKey = keyPath[2];
    if (keyPath.length === 3) {
      if (rawValue.startsWith('{')) Object.assign(get(hookKey), parseInlineTable(rawValue));
    } else if (keyPath.length === 4) {
      applyField(get(hookKey), keyPath[3], parseTomlScalar(rawValue));
    }
  }
  return states;
}

export type TrustStatus = 'trusted' | 'modified' | 'untrusted' | 'disabled' | 'unknown';

export interface TrustLookup {
  status: TrustStatus;
  key?: string;
  detail: string;
}

/** `C:\...`, `C:/...` or a UNC / `\\?\` path — a key that came from a Windows machine. */
function looksWindows(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * Path comparison the way the trust key is written: separators normalised to `/`, and case folded
 * on a case-insensitive filesystem. Windows-shaped paths are folded wherever they are read, so a
 * key Codex wrote as `C:\Users\x\.codex\hooks.json` matches the `c:/Users/x/.codex/hooks.json` the
 * adapter computed (drive-letter case and separator style differ between `path.join`, the raw
 * config value and `fs.realpathSync.native`).
 */
export function foldHookPath(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' || looksWindows(p) ? norm.toLowerCase() : norm;
}

/**
 * Looks up the trust record for one of our handlers. Codex keys the record by the hooks.json path
 * (its canonical/real path, as Codex displays it) plus `:<event>:<group>:<handler>`. When
 * `hooksJsonPaths` is given (the path we installed to, real and as-configured) the key source must
 * equal one of them; otherwise any source named `hooks.json` counts. Indexes and hash are strict.
 */
export function lookupTrust(
  states: Record<string, HookState>,
  event: 'PreToolUse' | 'PostToolUse',
  groupIndex: number,
  handlerIndex: number,
  expectedHash: string,
  hooksJsonPaths?: string[],
): TrustLookup {
  const suffix = `:${codexEventLabel(event)}:${groupIndex}:${handlerIndex}`;
  const wanted = (hooksJsonPaths ?? []).map(foldHookPath);
  const sourceMatches = (source: string): boolean => (wanted.length ? wanted.includes(foldHookPath(source)) : /(^|[\\/])hooks\.json$/i.test(source));
  const keys = Object.keys(states).filter((k) => k.endsWith(suffix) && sourceMatches(k.slice(0, -suffix.length)));
  if (keys.length === 0) return { status: 'untrusted', detail: 'Codex has no trust record for the ExplainIT hook yet.' };
  for (const key of keys) {
    const s = states[key];
    if (s.enabled === false) return { status: 'disabled', key, detail: 'The ExplainIT hook is disabled in Codex (enabled = false in config.toml).' };
    if (s.trusted_hash === expectedHash) return { status: 'trusted', key, detail: 'Codex trusts the ExplainIT hook.' };
  }
  const withHash = keys.find((k) => states[k].trusted_hash);
  if (withHash) {
    return {
      status: 'modified',
      key: withHash,
      detail: 'Codex has a trust record for the ExplainIT hook, but it does not match the current hook entry. Codex will not run it until you trust it again.',
    };
  }
  return { status: 'unknown', key: keys[0], detail: 'A Codex hook state entry exists but has no trusted hash; trust is unknown.' };
}
