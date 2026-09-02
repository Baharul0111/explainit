/**
 * `codex exec` channel (REQ-007, REQ-022).
 *
 * Flags verified against codex-cli 0.152.0 (`codex exec --help`):
 *   codex exec --skip-git-repo-check --ephemeral --sandbox read-only -C <home>/tmp -o <tmpfile> [--json] -
 * `-` reads the prompt from stdin. The final message is read from the -o file; `--json` streams
 * JSONL events (item.completed / agent_message) to stdout which drive progress.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChannelAvailability } from '../../core/types';
import { explainitHome } from '../../core/paths';
import { randomId } from '../../core/hash';
import { classifyCliFailure, describeFailure, type CliChannelDeps } from './claude';
import { cliWorkDir, probeVersion, resolveCli, runCli, type CliSpec } from './cli';
import { ChannelError, type ChannelFailure, type ChannelRequest, type ChannelResult, type GenerationChannel } from './types';

export function codexArgs(cwd: string, outFile: string, stream: boolean): string[] {
  return ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', cwd, '-o', outFile, ...(stream ? ['--json'] : []), '-'];
}

export interface CodexEvent {
  kind: 'message' | 'status' | 'error' | 'other';
  text?: string;
}

/** One `--json` line -> a coarse event. */
export function parseCodexEventLine(line: string): CodexEvent | undefined {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!o || typeof o !== 'object') return undefined;
  const type = String(o.type ?? '');
  if (type === 'error') return { kind: 'error', text: typeof o.message === 'string' ? o.message : JSON.stringify(o) };
  if (type === 'item.completed' || type === 'item.updated') {
    const item = o.item as { type?: string; text?: string } | undefined;
    if (item?.type === 'agent_message' && typeof item.text === 'string') return { kind: 'message', text: item.text };
    return { kind: 'other' };
  }
  if (type === 'turn.started') return { kind: 'status', text: 'Codex is working…' };
  if (type === 'turn.failed') {
    const err = o.error as { message?: string } | undefined;
    return { kind: 'error', text: err?.message ?? 'turn failed' };
  }
  return { kind: 'other' };
}

/** Final text from the whole `--json` stdout (last agent_message wins) and any error message. */
export function parseCodexJsonStdout(stdout: string): { text?: string; error?: string } {
  let text: string | undefined;
  let error: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const ev = parseCodexEventLine(line.trim());
    if (!ev) continue;
    if (ev.kind === 'message') text = ev.text;
    if (ev.kind === 'error') error = ev.text;
  }
  return { text, error };
}

export function createCodexChannel(deps: CliChannelDeps): GenerationChannel {
  const log = deps.logger.child('codex');
  const resolve = (): CliSpec => deps.resolve?.() ?? resolveCli('codex', deps.settings.get('codexCliPath'), deps.resolveOptions);
  const home = (): string => deps.homeDir ?? explainitHome();

  return {
    id: 'codex',
    async availability(): Promise<ChannelAvailability> {
      const spec = resolve();
      if (spec.source === 'none') return { channel: 'codex', available: false, reason: 'Codex was not found.', detail: spec.detail };
      const probe = await probeVersion(spec, 10_000);
      if (!probe.ok) return { channel: 'codex', available: false, reason: 'Codex is installed but did not answer "--version".', detail: `${spec.detail}: ${probe.detail}` };
      return { channel: 'codex', available: true, detail: `${spec.detail}, ${probe.detail}. Sign-in is checked on first use.` };
    },
    async send(req: ChannelRequest): Promise<ChannelResult> {
      const spec = resolve();
      const stream = typeof req.onText === 'function';
      const cwd = cliWorkDir(home());
      const outFile = path.join(os.tmpdir(), `explainit-codex-${randomId()}.txt`);
      let pending = '';
      let streamedText = '';
      req.onStatus?.('Asking Codex…');
      try {
        const r = await runCli(spec, codexArgs(cwd, outFile, stream), {
          stdin: req.combined,
          timeoutMs: req.timeoutMs,
          token: req.token,
          cwd,
          onStdout: stream
            ? (chunk) => {
                pending += chunk;
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() ?? '';
                for (const line of lines) {
                  const ev = parseCodexEventLine(line.trim());
                  if (!ev) continue;
                  if (ev.kind === 'status' && ev.text) req.onStatus?.(ev.text);
                  if (ev.kind === 'message' && ev.text && ev.text.length > streamedText.length) {
                    // Codex sends whole messages, not deltas: forward only the new tail.
                    req.onText?.(ev.text.slice(streamedText.length));
                    streamedText = ev.text;
                  }
                }
              }
            : undefined,
        });
        let text = '';
        try {
          text = fs.readFileSync(outFile, 'utf8');
        } catch {
          /* no output file: fall back to stdout */
        }
        const fromJson = stream ? parseCodexJsonStdout(r.stdout) : { text: undefined, error: undefined };
        if (!text.trim()) text = fromJson.text ?? (stream ? '' : r.stdout);
        const detail = `codex ${spec.source} ${r.durationMs}ms exit=${r.code}`;
        if (!text.trim()) {
          const msg = (fromJson.error ?? r.stderr ?? '').trim().slice(0, 500);
          const reason: ChannelFailure = msg ? classifyCliFailure(msg) : 'bad-output';
          log.warn('codex failed', { reason, code: r.code, detail: msg.slice(0, 200) });
          throw new ChannelError('codex', reason, describeFailure('Codex', reason, msg, r.code));
        }
        if (r.code !== 0 && r.code !== null) {
          // Output plus a non-zero exit: the message is probably an error report from the CLI.
          const reason = classifyCliFailure(text + ' ' + r.stderr);
          if (reason !== 'failed') throw new ChannelError('codex', reason, describeFailure('Codex', reason, text.slice(0, 200), r.code));
        }
        return { text, detail };
      } finally {
        fs.promises.rm(outFile, { force: true }).catch(() => undefined);
      }
    },
  };
}
