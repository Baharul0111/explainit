/**
 * `claude -p` channel (REQ-007, REQ-022).
 *
 * Flags verified against Claude Code 2.1.252 (`claude --help`):
 *   -p --output-format json --tools "" --no-session-persistence --strict-mcp-config
 *   streaming: --output-format stream-json --include-partial-messages --verbose
 * The prompt is sent on stdin (documented: `claude -p` reads it when no prompt argument is given),
 * which keeps agent text off the command line and away from Windows' argv limit.
 * cwd = <explainit home>/tmp so no project CLAUDE.md / hooks / MCP servers are loaded.
 * Never uses --bare (it disables the person's OAuth sign-in).
 */
import type { Logger } from '../../core/log';
import type { Settings } from '../../core/settings';
import type { ChannelAvailability } from '../../core/types';
import { explainitHome } from '../../core/paths';
import { SIGN_IN_MESSAGE, cliWorkDir, probeVersion, resolveCli, runCli, type CliSpec, type ResolveOptions } from './cli';
import { ChannelError, type ChannelFailure, type ChannelRequest, type ChannelResult, type GenerationChannel } from './types';

export interface CliChannelDeps {
  settings: Settings;
  logger: Logger;
  /** Override the ExplainIT home (cwd = <home>/tmp). */
  homeDir?: string;
  resolveOptions?: ResolveOptions;
  /** Test hook: replace resolution entirely. */
  resolve?: () => CliSpec;
}

export const CLAUDE_BASE_ARGS = ['-p', '--tools', '', '--no-session-persistence', '--strict-mcp-config'];

export function claudeArgs(stream: boolean): string[] {
  return stream ? [...CLAUDE_BASE_ARGS, '--output-format', 'stream-json', '--include-partial-messages', '--verbose'] : [...CLAUDE_BASE_ARGS, '--output-format', 'json'];
}

/**
 * Signed-out output, as the real CLIs print it:
 *   claude: "Not logged in · Please run /login", API errors with "authentication_error"
 *   codex:  "refresh token was revoked", "Please log out and sign in again", "token_revoked", "401 Unauthorized"
 */
const SIGNED_OUT_RE = /not logged in|please (run )?\/?login|log in|sign in|authenticat|api key|unauthori[sz]ed|credential|oauth|token has expired|token.{0,24}revoked|token_revoked|\brevoked\b|invalid.*key/;

/** True when the CLI's output says the person is not signed in (or the stored sign-in no longer works). */
export function looksSignedOut(text: string): boolean {
  return SIGNED_OUT_RE.test(text.toLowerCase());
}

/** Classify an error message from the CLI into a ChannelFailure. */
export function classifyCliFailure(text: string): ChannelFailure {
  const t = text.toLowerCase();
  if (SIGNED_OUT_RE.test(t)) return 'auth';
  if (/rate.?limit|quota|usage limit|limit reached|too many requests|overloaded|out of credits|insufficient credits|429|529|exceeded/.test(t)) return 'quota';
  return 'failed';
}

export interface ClaudeJsonResult {
  result?: string;
  isError: boolean;
  subtype?: string;
  detail?: string;
}

function safeParse(line: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `--output-format json`: one object with type "result". Tolerates stray lines before/after it. */
export function parseClaudeJson(stdout: string): ClaudeJsonResult {
  const whole = safeParse(stdout.trim());
  const candidates: Record<string, unknown>[] = whole ? [whole] : [];
  if (!whole) {
    for (const line of stdout.split(/\r?\n/)) {
      const o = safeParse(line.trim());
      if (o) candidates.push(o);
    }
  }
  const res = [...candidates].reverse().find((o) => o.type === 'result' || typeof o.result === 'string') ?? candidates[candidates.length - 1];
  if (!res) return { isError: true, detail: stdout.trim().slice(0, 300) || 'no output' };
  const result = typeof res.result === 'string' ? res.result : undefined;
  const isError = res.is_error === true || (typeof res.subtype === 'string' && res.subtype.startsWith('error'));
  return { result, isError, subtype: typeof res.subtype === 'string' ? res.subtype : undefined, detail: typeof res.api_error_status === 'string' ? res.api_error_status : undefined };
}

/** Text deltas from stream-json lines (used for progress); returns the text found in the lines. */
export function extractStreamDeltas(lines: string[]): string {
  let out = '';
  for (const line of lines) {
    const o = safeParse(line.trim());
    if (!o || o.type !== 'stream_event') continue;
    const ev = o.event as Record<string, unknown> | undefined;
    if (!ev || ev.type !== 'content_block_delta') continue;
    const delta = ev.delta as Record<string, unknown> | undefined;
    if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') out += delta.text;
  }
  return out;
}

/**
 * `--output-format stream-json`: the final "result" line is authoritative; otherwise the assistant
 * message text; otherwise the concatenated deltas.
 */
export function parseClaudeStream(stdout: string): ClaudeJsonResult {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  let resultLine: Record<string, unknown> | undefined;
  let assistantText = '';
  for (const line of lines) {
    const o = safeParse(line.trim());
    if (!o) continue;
    if (o.type === 'result') resultLine = o;
    if (o.type === 'assistant') {
      const msg = o.message as { content?: { type?: string; text?: string }[] } | undefined;
      const text = (msg?.content ?? [])
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('');
      if (text) assistantText = text; // the last assistant message wins
    }
  }
  if (resultLine) {
    const r = parseClaudeJson(JSON.stringify(resultLine));
    if (r.result !== undefined || r.isError) return r;
  }
  const deltas = extractStreamDeltas(lines);
  const text = assistantText || deltas;
  if (text) return { result: text, isError: false };
  return { isError: true, detail: 'no assistant text in the stream' };
}

export function createClaudeChannel(deps: CliChannelDeps): GenerationChannel {
  const log = deps.logger.child('claude');
  const resolve = (): CliSpec => deps.resolve?.() ?? resolveCli('claude', deps.settings.get('claudeCliPath'), deps.resolveOptions);
  const home = (): string => deps.homeDir ?? explainitHome();

  return {
    id: 'claude',
    async availability(): Promise<ChannelAvailability> {
      const spec = resolve();
      if (spec.source === 'none') return { channel: 'claude', available: false, reason: 'Claude Code was not found.', detail: spec.detail };
      const probe = await probeVersion(spec, 10_000);
      if (!probe.ok) return { channel: 'claude', available: false, reason: 'Claude Code is installed but did not answer "--version".', detail: `${spec.detail}: ${probe.detail}` };
      return { channel: 'claude', available: true, detail: `${spec.detail}, ${probe.detail}. Sign-in is checked on first use.` };
    },
    async send(req: ChannelRequest): Promise<ChannelResult> {
      const spec = resolve();
      const stream = typeof req.onText === 'function';
      const cwd = cliWorkDir(home());
      let pending = '';
      const started = Date.now();
      req.onStatus?.('Asking Claude Code…');
      const r = await runCli(spec, claudeArgs(stream), {
        stdin: req.combined,
        timeoutMs: req.timeoutMs,
        token: req.token,
        cwd,
        onStdout: stream
          ? (chunk) => {
              pending += chunk;
              const lines = pending.split(/\r?\n/);
              pending = lines.pop() ?? '';
              const text = extractStreamDeltas(lines);
              if (text) req.onText?.(text);
            }
          : undefined,
      });
      const parsed = stream ? parseClaudeStream(r.stdout) : parseClaudeJson(r.stdout);
      const detail = `claude ${spec.source} ${r.durationMs}ms exit=${r.code}`;
      if (parsed.isError || parsed.result === undefined) {
        const msg = (parsed.result ?? (r.stdout.trim() ? parsed.detail : '') ?? '').trim().slice(0, 500) || r.stderr.trim().slice(0, 500);
        let reason: ChannelFailure = classifyCliFailure(msg + ' ' + r.stderr);
        if (reason === 'failed' && r.code !== 0) reason = 'bad-output';
        log.warn('claude failed', { reason, code: r.code, detail: (msg || r.stderr.trim()).slice(0, 200) });
        throw new ChannelError('claude', reason, describeFailure('Claude Code', reason, msg, r.code));
      }
      if (!parsed.result.trim()) throw new ChannelError('claude', 'bad-output', 'Claude Code answered with an empty reply. Try again, or pick another assistant in the ExplainIT settings.');
      log.debug('claude ok', { ms: Date.now() - started, chars: parsed.result.length });
      return { text: parsed.result, detail };
    },
  };
}

/**
 * Plain-English failure text: what happened and what to do next. The sign-in message is fixed
 * (no raw CLI text) because the twin, the status view and the Doctor show it verbatim.
 */
export function describeFailure(tool: string, reason: ChannelFailure, msg: string, code: number | null): string {
  const tail = msg ? ` (${msg.replace(/\s+/g, ' ').slice(0, 200)})` : '';
  switch (reason) {
    case 'auth':
      return SIGN_IN_MESSAGE[tool.toLowerCase().includes('claude') ? 'claude' : 'codex'];
    case 'quota':
      return `${tool} reported a usage limit${tail}. Wait for the limit to reset or pick another assistant in the ExplainIT settings.`;
    case 'bad-output':
      return `${tool} exited with code ${code} without an answer${tail}. Run it once in a terminal to see what it says, then try again.`;
    default:
      return `${tool} could not answer${tail}. Run "ExplainIT: Doctor" for details.`;
  }
}
