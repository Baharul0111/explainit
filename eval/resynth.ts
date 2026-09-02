/**
 * Resynthesis step of the round trip: ask the same assistant to write the Python function again from
 * ONLY its name, its signature, the file context (imports/helpers) and the plain-English explanation.
 *
 * The router has no generic "ask" method and does not export its channel objects, so this shells out
 * through the router's exported CLI helpers (`resolveCli` / `runCli` from src/generation): same path
 * resolution rules (setting -> PATH -> bundled extension binary), same flags as CONTRACTS "Channels",
 * argument arrays only, the prompt on stdin, timeout + one jittered retry inside runCli.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Settings } from '../src/core/settings';
import { randomId } from '../src/core/hash';
import { resolveCli, runCli, type CliSpec } from '../src/generation';
import { extractPythonCode } from './pure/humaneval';

export type ResynthKind = 'claude' | 'codex';

export interface ResynthInput {
  entryPoint: string;
  /** `def name(...) -> type:` line(s), exactly as in the original prompt. */
  signature: string;
  /** Imports and helper functions that already exist in the file (may be empty). */
  context: string;
  explanation: { summary: string; steps: string[]; warnings?: string[]; uncertainty?: string };
}

export const RESYNTH_TASK_HEADER = 'Task: resynthesize';

/** The prompt. It never contains the original body — that is the whole point of the eval. */
export function buildResynthPrompt(input: ResynthInput): string {
  const lines: string[] = [
    RESYNTH_TASK_HEADER,
    'You are given a plain-English description of one Python function. Write the complete Python function from that description alone.',
    '',
    `Function name: ${input.entryPoint}`,
    'Signature (keep it exactly as written):',
    input.signature,
    '',
  ];
  if (input.context.trim()) {
    lines.push('Context that already exists in the file (you may use it, do not repeat it):', input.context.trim(), '');
  }
  lines.push('Description:', `What it does: ${input.explanation.summary}`, 'How it works:');
  for (const s of input.explanation.steps) lines.push(`- ${s}`);
  if (input.explanation.warnings?.length) {
    lines.push('Watch out:');
    for (const w of input.explanation.warnings) lines.push(`- ${w}`);
  }
  if (input.explanation.uncertainty) lines.push(`Note: ${input.explanation.uncertainty}`);
  lines.push(
    '',
    'Rules:',
    '- Reply with only the Python code inside one ```python fence. No tests, no prints, no explanation.',
    '- Start with the def line shown above. You may add import lines before it.',
    '- Make the function work for every input that fits the description, not only the examples.',
  );
  return lines.join('\n');
}

export interface ResynthResult {
  /** Extracted Python code ('' when the reply had none). */
  code: string;
  /** The raw reply text. */
  reply: string;
  /** Where the CLI came from and how long it took. Never contains secrets. */
  detail: string;
}

export interface ResynthOptions {
  timeoutMs: number;
  /** ExplainIT home (cwd for the CLI is <home>/tmp so no project config is loaded). */
  homeDir: string;
  /** Test hook: replace CLI resolution. */
  resolve?: (kind: ResynthKind) => CliSpec;
}

export const CLAUDE_JSON_ARGS = ['-p', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--output-format', 'json'];

export function codexExecArgs(cwd: string, outFile: string): string[] {
  return ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', cwd, '-o', outFile, '-'];
}

/** `--output-format json` reply -> result text, or an error message. */
export function parseClaudeJsonReply(stdout: string): { text?: string; error?: string } {
  const objects: Record<string, unknown>[] = [];
  const tryPush = (s: string): void => {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object') objects.push(v as Record<string, unknown>);
    } catch {
      /* not JSON */
    }
  };
  tryPush(stdout.trim());
  if (!objects.length) for (const line of stdout.split(/\r?\n/)) tryPush(line.trim());
  const res = [...objects].reverse().find((o) => o.type === 'result' || typeof o.result === 'string');
  if (!res) return { error: stdout.trim() ? `unexpected output: ${stdout.trim().slice(0, 200)}` : 'no output' };
  const text = typeof res.result === 'string' ? res.result : undefined;
  if (res.is_error === true || (typeof res.subtype === 'string' && res.subtype.startsWith('error'))) {
    return { error: text ?? String(res.subtype ?? 'error') };
  }
  return { text };
}

function workDir(homeDir: string): string {
  const dir = path.join(homeDir, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Ask the CLI to write the function. Throws a plain-English Error when it cannot. */
export async function resynthesize(kind: ResynthKind, settings: Settings, input: ResynthInput, opts: ResynthOptions): Promise<ResynthResult> {
  const spec = opts.resolve ? opts.resolve(kind) : resolveCli(kind, settings.get(kind === 'claude' ? 'claudeCliPath' : 'codexCliPath'));
  if (spec.source === 'none') throw new Error(`${kind === 'claude' ? 'Claude Code' : 'Codex'} was not found: ${spec.detail}`);
  const prompt = buildResynthPrompt(input);
  const cwd = workDir(opts.homeDir);
  const started = Date.now();

  if (kind === 'claude') {
    const r = await runCli(spec, CLAUDE_JSON_ARGS, { stdin: prompt, timeoutMs: opts.timeoutMs, cwd });
    const parsed = parseClaudeJsonReply(r.stdout);
    if (parsed.error !== undefined || parsed.text === undefined) {
      const why = (parsed.error ?? r.stderr ?? '').trim().slice(0, 300);
      throw new Error(`Claude Code did not answer the re-implementation request (exit ${r.code}${why ? `: ${why}` : ''}). Run "claude -p hello" in a terminal to check it is signed in.`);
    }
    return { code: extractPythonCode(parsed.text, input.entryPoint), reply: parsed.text, detail: `claude ${spec.source} ${Date.now() - started}ms exit=${r.code}` };
  }

  const outFile = path.join(os.tmpdir(), `explainit-eval-codex-${randomId()}.txt`);
  try {
    const r = await runCli(spec, codexExecArgs(cwd, outFile), { stdin: prompt, timeoutMs: opts.timeoutMs, cwd });
    let text = '';
    try {
      text = fs.readFileSync(outFile, 'utf8');
    } catch {
      text = '';
    }
    if (!text.trim()) text = r.stdout;
    if (!text.trim()) {
      const why = (r.stderr ?? '').trim().slice(0, 300);
      throw new Error(`Codex did not answer the re-implementation request (exit ${r.code}${why ? `: ${why}` : ''}). Run "codex exec hello" in a terminal to check it is signed in.`);
    }
    return { code: extractPythonCode(text, input.entryPoint), reply: text, detail: `codex ${spec.source} ${Date.now() - started}ms exit=${r.code}` };
  } finally {
    fs.promises.rm(outFile, { force: true }).catch(() => undefined);
  }
}
