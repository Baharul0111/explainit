/**
 * Small pure parsers used by the doctor and onboarding. No `vscode` import.
 */

/** Result of reading the Codex user config for the ExplainIT hook trust record. */
export type CodexTrust = 'trusted' | 'untrusted' | 'no-config' | 'no-record';

/**
 * Codex records hook approvals in `~/.codex/config.toml` under `[hooks.state]` (shared by the CLI and the
 * VS Code extension). The exact key format has changed between Codex versions, so this is deliberately
 * lenient: any key/value line inside a `hooks.state` section that mentions the ExplainIT hook and is not
 * explicitly false/denied counts as trusted.
 */
export function codexHookTrust(configToml: string | undefined, marker = 'explainit'): CodexTrust {
  if (configToml === undefined) return 'no-config';
  const lines = configToml.replace(/\r\n?/g, '\n').split('\n');
  let inState = false;
  let sawStateSection = false;
  let sawRecord = false;
  const m = marker.toLowerCase();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[+\s*([^\]]+?)\s*\]+$/.exec(line);
    if (header) {
      const name = header[1].replace(/["']/g, '').toLowerCase();
      inState = name === 'hooks.state' || name.startsWith('hooks.state.');
      if (inState) sawStateSection = true;
      continue;
    }
    if (!inState) continue;
    if (!line.toLowerCase().includes(m)) continue;
    sawRecord = true;
    const value = line.split('=').slice(1).join('=').trim().toLowerCase();
    if (/\b(false|denied|deny|untrusted|rejected)\b/.test(value)) return 'untrusted';
    return 'trusted';
  }
  if (!sawStateSection) return 'no-record';
  return sawRecord ? 'trusted' : 'no-record';
}

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

/**
 * The Claude-shaped PreToolUse payload the doctor sends through the hook script to prove the wire works.
 * The content is a valid twin with one section: the gate auto-allows valid twin writes (and denies twins
 * without sections), so a healthy wire answers "allow" without any human involved. Nothing is written.
 */
export function syntheticWritePayload(folder: string, targetPath: string, sourceName: string): Record<string, unknown> {
  const content =
    `ExplainIT — plain-English twin of ${sourceName}\n` +
    'Written by ExplainIT. Not committed to git. Right-click a section for "Regenerate this section".\n' +
    '\n' +
    '1. doctor_probe\n' +
    'What it does: Proves that the ExplainIT hook can reach the checkpoint in this window.\n' +
    'How it works:\n' +
    '- The Doctor sends this synthetic write through the real hook script.\n' +
    '- The checkpoint recognises a valid twin and answers without asking anyone.\n' +
    '- Nothing is written to disk.\n';
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
