/**
 * Small pure parsers used by the doctor and onboarding. No `vscode` import.
 */
import * as path from 'node:path';
import type { IntegrityReport } from '../../core/interfaces';

// ---------------------------------------------------------------------------------------------
// Codex hook trust (reported by src/adapters/codex.ts as an integrity check)
// ---------------------------------------------------------------------------------------------

/** The integrity check name the Codex adapter uses for its hook-trust verdict. */
export const CODEX_TRUST_CHECK_NAME = 'Codex hook trust';
/** The adapter starts its detail with this when it cannot tell whether the hook is trusted. */
export const CODEX_TRUST_UNKNOWN_PREFIX = 'Trust unknown';

export function isCodexTrustCheck(name: string): boolean {
  return name.trim().toLowerCase() === CODEX_TRUST_CHECK_NAME.toLowerCase();
}

export type CodexTrustStatus = 'trusted' | 'not-trusted' | 'unknown' | 'not-reported';

export interface CodexTrustVerdict {
  status: CodexTrustStatus;
  /** The adapter's detail, verbatim (it carries the trust instructions). Empty when not reported. */
  detail: string;
}

/**
 * Reads the Codex adapter's "Codex hook trust" check out of an integrity report. The adapter reproduces
 * Codex's own trust hash, so the Doctor never re-parses config.toml itself: it shows the adapter's verdict
 * and detail verbatim. None of the failing states can be fixed by ExplainIT (the person has to trust the
 * hook inside codex), so callers offer no fix action for any of them.
 */
export function codexTrustFromIntegrity(report: Pick<IntegrityReport, 'checks'> | undefined): CodexTrustVerdict {
  const c = report?.checks?.find((x) => x && typeof x.name === 'string' && isCodexTrustCheck(x.name));
  if (!c) return { status: 'not-reported', detail: '' };
  const detail = (c.detail ?? '').trim();
  if (c.ok) return { status: 'trusted', detail: detail || 'Codex trusts the ExplainIT hook.' };
  if (detail.startsWith(CODEX_TRUST_UNKNOWN_PREFIX)) return { status: 'unknown', detail };
  return { status: 'not-trusted', detail: detail || 'Codex has not trusted the ExplainIT hook yet.' };
}

// ---------------------------------------------------------------------------------------------
// Codex home (mirrors src/adapters/installer.ts userHomeDir + codexHomeOverride and codex.ts codexHomeDir)
// ---------------------------------------------------------------------------------------------

/**
 * Where the assistants' user-layer config lives, the way the adapters decide it: `EXPLAINIT_USER_HOME`
 * wins; in test mode without an override it is a folder inside the ExplainIT home; else the real home.
 */
export function userHomeDir(env: NodeJS.ProcessEnv, realHome: string, explainitHome: string): string {
  const override = env.EXPLAINIT_USER_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  if (env.EXPLAINIT_TEST_MODE === '1') return path.join(explainitHome, 'user-home');
  return realHome;
}

/**
 * Codex keeps hooks.json, config.toml and auth.json under `CODEX_HOME` when that is set (the CLI and the
 * VS Code extension both honour it), else under `<user home>/.codex`. Like the adapters, `CODEX_HOME` is
 * honoured only for the real user home so test homes never point at the person's real Codex files.
 */
export function codexHomeDir(env: NodeJS.ProcessEnv, realHome: string, explainitHome: string): string {
  const userHome = userHomeDir(env, realHome, explainitHome);
  const raw = env.CODEX_HOME;
  if (raw && raw.trim() && userHome === realHome) return path.resolve(raw.trim());
  return path.join(userHome, '.codex');
}

/** `~/.codex/config.toml` style display for paths under the home folder; other paths are shown as they are. */
export function friendlyHomePath(p: string, homedir: string): string {
  const rel = path.relative(homedir, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~${path.sep}${rel}` : p;
}

/** Display strings for the two Codex files the Doctor and the status view talk about. */
export interface CodexPaths {
  hooksJson: string;
  configToml: string;
}

export function codexPathsFor(env: NodeJS.ProcessEnv, realHome: string, explainitHome: string): CodexPaths {
  const home = codexHomeDir(env, realHome, explainitHome);
  return {
    hooksJson: friendlyHomePath(path.join(home, 'hooks.json'), realHome),
    configToml: friendlyHomePath(path.join(home, 'config.toml'), realHome),
  };
}

// ---------------------------------------------------------------------------------------------
// git exclude / instruction sections
// ---------------------------------------------------------------------------------------------

/** True when a `.git/info/exclude` (or .gitignore) text already ignores `*_explain.txt`. */
export function hasTwinExclude(text: string | undefined): boolean {
  if (!text) return false;
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .some((l) => !l.startsWith('#') && (l === '*_explain.txt' || l === '**/*_explain.txt'));
}

/** True when an instruction file already carries the ExplainIT section (marker-delimited, idempotent). */
export function instructionSectionPresent(fileText: string | undefined, sectionText: string): boolean {
  if (!fileText) return false;
  const norm = (s: string) => s.replace(/\r\n?/g, '\n').trim();
  const file = norm(fileText);
  const section = norm(sectionText);
  if (section && file.includes(section)) return true;
  // The generator may have refreshed wording since the file was written; the marker line is what matters.
  return /<!--\s*explainit[:\s-]/i.test(file) || /^#+\s+ExplainIT\b/im.test(file);
}

// ---------------------------------------------------------------------------------------------
// Hook wiring live test
// ---------------------------------------------------------------------------------------------

/**
 * The line a twin carries when its source file has no functions. Owned by src/twin/pure/render.ts and
 * pinned in docs/dev/CONTRACTS.md ("Twin file contract"); mirrored here because ux may not import twin.
 */
export const TWIN_NO_FUNCTIONS_LINE = 'This file has no functions to explain.';

/**
 * The Claude-shaped PreToolUse payload the doctor sends through the hook script to prove the wire works.
 * The doctor runs the script with `--agent claude` on purpose: under Claude hook semantics every answer
 * (allow, deny, ask) is printed, whereas under `--agent codex` a bare allow prints nothing, which would be
 * indistinguishable from "no checkpoint found". The content is exactly the twin a file with no functions
 * renders to (header two lines, a blank line, the "no functions" line): a valid twin the checkpoint can
 * answer without a human. Nothing is written to disk.
 */
export function syntheticWritePayload(folder: string, targetPath: string, sourceName: string): Record<string, unknown> {
  const content =
    `ExplainIT — plain-English twin of ${sourceName}\n` +
    'Written by ExplainIT. Not committed to git. Right-click a section for "Regenerate this section".\n' +
    '\n' +
    `${TWIN_NO_FUNCTIONS_LINE}\n`;
  return {
    session_id: 'explainit-doctor',
    transcript_path: '',
    cwd: folder,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_use_id: 'explainit-doctor-probe',
    tool_input: { file_path: targetPath, content },
  };
}

/** Upper bound on hook stdout/stderr the doctor keeps (a runaway script must not eat memory). */
export const HOOK_OUTPUT_CAP = 64 * 1024;

/**
 * Parse a `<home>/sessions/<pid>.json` file. Anything that is not an object with a numeric pid and port
 * (arrays, garbage, half-written files) is treated as missing so no check ever prints "undefined".
 */
export function parseSessionFile(text: string | undefined): { pid: number; port: number; token: string; folders: string[]; startedAt: string; version: string } | undefined {
  if (!text || !text.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const o = parsed as Record<string, unknown>;
  if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0) return undefined;
  if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port <= 0 || o.port > 65535) return undefined;
  const folders = Array.isArray(o.folders) ? o.folders.filter((f): f is string => typeof f === 'string') : [];
  return {
    pid: o.pid,
    port: o.port,
    token: typeof o.token === 'string' ? o.token : '',
    folders,
    startedAt: typeof o.startedAt === 'string' ? o.startedAt : '',
    version: typeof o.version === 'string' ? o.version : '',
  };
}

export interface HookOutcome {
  /** The gate answered through the hook (any allow/deny/ask decision). */
  answered: boolean;
  decision?: string;
  reason?: string;
  /** What went wrong when `answered` is false. */
  problem?: string;
  /** How the hook was run, in plain English (e.g. "through the installed wrapper <path>"). */
  via?: string;
}

/** Interpret the hook script's stdout. Empty output means "no opinion" (no gate found, or paused). */
export function interpretHookOutput(stdout: string, exitCode: number | null, stderr = ''): HookOutcome {
  const text = stdout.trim();
  if (exitCode !== 0 && exitCode !== null) {
    return { answered: false, problem: `the hook script exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}` };
  }
  if (!text) {
    return { answered: false, problem: 'the hook script printed nothing, so it did not find a running checkpoint for this folder (or the checkpoint is paused)' };
  }
  try {
    const parsed = JSON.parse(text);
    const out = parsed?.hookSpecificOutput ?? parsed;
    const decision = String(out?.permissionDecision ?? out?.decision ?? '');
    const reason = out?.permissionDecisionReason ?? out?.reason;
    if (!decision) return { answered: false, problem: 'the hook script printed JSON without a permission decision' };
    if (decision === 'ask' && typeof reason === 'string' && /not responding/i.test(reason)) {
      return { answered: false, decision, reason, problem: 'the hook script timed out waiting for the checkpoint' };
    }
    return { answered: true, decision, reason: typeof reason === 'string' ? reason : undefined };
  } catch {
    return { answered: false, problem: `the hook script printed something that is not JSON: ${text.slice(0, 120)}` };
  }
}

/** Test-mode answers: EXPLAINIT_TEST_ANSWERS='{"consent":"Allow"}'. Malformed JSON yields an empty map. */
export function parseTestAnswers(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXPLAINIT_TEST_MODE === '1';
}

/** Human-readable size. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
