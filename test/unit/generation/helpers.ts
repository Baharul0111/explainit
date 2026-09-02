/**
 * Shared helpers for the generation unit tests (plain Node, no vscode).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger, type Logger } from '../../../src/core/log';
import { inMemorySettings, type Settings, type SettingsValues } from '../../../src/core/settings';
import { contentHashOf } from '../../../src/core/hash';
import type { ConsentStore, ExplainFunctionInput, ExplainRequest, ExplanationCache } from '../../../src/core/interfaces';
import type { Channel, ChannelAvailability, Explanation } from '../../../src/core/types';
import { ChannelError, type ChannelRequest, type ChannelResult, type GenerationChannel } from '../../../src/generation/channels/types';

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
export const FAKE_CLAUDE = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-cli', 'claude.js');
export const FAKE_CODEX = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-cli', 'codex.js');
export const FIXTURE_WORKSPACE = path.join(REPO_ROOT, 'test', 'fixtures', 'workspace');

export function silentLogger(lines?: string[]): Logger {
  return createLogger([{ write: (l) => lines?.push(l) }], 'test', 'debug');
}

export function settings(overrides: Partial<SettingsValues> = {}): Settings {
  return inMemorySettings(overrides);
}

export function tmpDir(prefix = 'explainit-gen-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function fn(name: string, text: string, id = `${name}#0`): ExplainFunctionInput {
  return { functionId: id, name, text, contentHash: contentHashOf(text) };
}

export function manyFunctions(n: number): ExplainFunctionInput[] {
  return Array.from({ length: n }, (_, i) => fn(`f${i}`, `function f${i}(a) {\n  return a + ${i};\n}`));
}

export function request(functions: ExplainFunctionInput[], extra: Partial<ExplainRequest> = {}): ExplainRequest {
  return { fileName: 'util.ts', languageId: 'typescript', functions, ...extra };
}

export function memoryCache(): ExplanationCache & { store: Map<string, Explanation> } {
  const store = new Map<string, Explanation>();
  return {
    store,
    get: (h) => store.get(h),
    set: (h, e) => void store.set(h, e),
    has: (h) => store.has(h),
    size: () => store.size,
    flush: async () => undefined,
  };
}

export function consent(granted = true): ConsentStore & { value: boolean } {
  const c = {
    value: granted,
    granted: () => c.value,
    setGranted: async (v: boolean) => void (c.value = v),
  };
  return c;
}

/** Deterministic reply in the router's JSON shape for the functions found in the prompt's fence. */
export function goodReplyFor(prompt: string): string {
  const inside = /-----BEGIN UNTRUSTED CODE ([0-9a-f]+)-----\n([\s\S]*?)\n-----END UNTRUSTED CODE \1-----/.exec(prompt)?.[2] ?? '';
  const re = /\[Function (F\d+): ([^\]\n]*)\]/g;
  const items: unknown[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(inside))) {
    items.push({ functionId: m[1], name: m[2], summary: `It does its job for ${m[2]}.`, steps: ['It takes the input it is given.', 'It hands the result back.'] });
  }
  return JSON.stringify({ explanations: items });
}

export interface FakeChannelOptions {
  available?: boolean;
  reason?: string;
  /** Reply generator; receives the request and the 1-based call number. */
  reply?: (req: ChannelRequest, call: number) => string | Promise<string>;
  /** Throw this on every send. */
  error?: ChannelError | Error;
  availabilityDelayMs?: number;
}

export interface FakeChannel extends GenerationChannel {
  calls: ChannelRequest[];
  availabilityCalls: number;
}

export function fakeChannel(id: Channel, opts: FakeChannelOptions = {}): FakeChannel {
  const calls: ChannelRequest[] = [];
  const ch: FakeChannel = {
    id,
    calls,
    availabilityCalls: 0,
    async availability(): Promise<ChannelAvailability> {
      ch.availabilityCalls++;
      if (opts.availabilityDelayMs) await new Promise((r) => setTimeout(r, opts.availabilityDelayMs));
      return { channel: id, available: opts.available !== false, reason: opts.reason };
    },
    async send(req: ChannelRequest): Promise<ChannelResult> {
      calls.push(req);
      if (opts.error) throw opts.error;
      const text = await (opts.reply ? opts.reply(req, calls.length) : goodReplyFor(req.combined));
      if (req.onText) req.onText(text);
      return { text };
    },
  };
  return ch;
}

export function channelError(id: Channel, reason: ChannelError['reason'] = 'failed'): ChannelError {
  return new ChannelError(id, reason, `${id} failed for the test`);
}
