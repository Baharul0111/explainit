/**
 * Copilot channel against a fake `vscode` API (no real VS Code needed).
 */
import * as assert from 'node:assert/strict';
import type * as vscodeTypes from 'vscode';
import { classifyLmError, createLmChannel, pickModel } from '../../../src/generation/channels/lm';
import { ChannelError, type ChannelRequest } from '../../../src/generation/channels/types';
import { CancelSource } from '../../../src/core/cancel';
import type { Disposable } from '../../../src/core/interfaces';
import { consent, settings, silentLogger } from './helpers';

class FakeLmError extends Error {
  constructor(public code: string, message = code) {
    super(message);
    this.name = 'LanguageModelError';
  }
  static NoPermissions(m?: string) { return new FakeLmError('NoPermissions', m); }
  static Blocked(m?: string) { return new FakeLmError('Blocked', m); }
  static NotFound(m?: string) { return new FakeLmError('NotFound', m); }
}

class FakeCts {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}

interface FakeModel { family: string; name: string; sendRequest: (...a: unknown[]) => Promise<{ text: AsyncIterable<string> }> }

function fakeVscode(models: FakeModel[] | (() => Promise<FakeModel[]>)): { api: unknown; selectCalls: number } {
  const state = { selectCalls: 0 };
  const api = {
    lm: {
      selectChatModels: async () => {
        state.selectCalls++;
        return typeof models === 'function' ? models() : models;
      },
    },
    LanguageModelChatMessage: { User: (content: string) => ({ role: 1, content }) },
    LanguageModelError: FakeLmError,
    CancellationTokenSource: FakeCts,
  };
  return { api, get selectCalls() { return state.selectCalls; } };
}

async function* streamOf(parts: string[]): AsyncIterable<string> {
  for (const p of parts) yield p;
}

function model(family: string, reply: string[] | Error): FakeModel {
  return {
    family,
    name: family,
    sendRequest: async () => {
      if (reply instanceof Error) throw reply;
      return { text: streamOf(reply) };
    },
  };
}

const req = (extra: Partial<ChannelRequest> = {}): ChannelRequest => ({ system: 'sys', user: 'usr', combined: 'sys\n\nusr', timeoutMs: 5000, ...extra });

suite('generation/channels/lm (Copilot)', () => {
  test('outside VS Code: unavailable and never throws', async () => {
    const disposables: Disposable[] = [];
    const ch = createLmChannel({ logger: silentLogger(), settings: settings(), consent: consent(true), disposables, loadVscode: () => undefined });
    const a = await ch.availability();
    assert.equal(a.available, false);
    assert.match(a.reason ?? '', /inside VS Code/);
    await assert.rejects(ch.send(req()), (e: unknown) => e instanceof ChannelError && e.reason === 'unavailable');
  });

  test('consent not granted: selectChatModels is never called', async () => {
    const fake = fakeVscode([model('gpt-4o', ['x'])]);
    const c = consent(false);
    const ch = createLmChannel({ logger: silentLogger(), settings: settings(), consent: c, disposables: [], loadVscode: () => fake.api as typeof vscodeTypes });
    const a = await ch.availability();
    assert.equal(a.available, false);
    assert.match(a.reason ?? '', /permission/);
    await assert.rejects(ch.send(req()), (e: unknown) => e instanceof ChannelError && e.reason === 'auth');
    assert.equal(fake.selectCalls, 0);
    c.value = true;
    assert.equal((await ch.availability()).available, true);
    assert.equal(fake.selectCalls, 1);
  });

  test('no models -> unavailable with a sign-in hint', async () => {
    const fake = fakeVscode([]);
    const ch = createLmChannel({ logger: silentLogger(), settings: settings(), consent: consent(true), disposables: [], loadVscode: () => fake.api as typeof vscodeTypes });
    const a = await ch.availability();
    assert.equal(a.available, false);
    assert.match(a.reason ?? '', /Sign in to GitHub Copilot/);
  });

  test('a slow selectChatModels never blocks availability for long', async () => {
    const fake = fakeVscode(() => new Promise((r) => setTimeout(() => r([]), 6000)));
    const ch = createLmChannel({ logger: silentLogger(), settings: settings(), consent: consent(true), disposables: [], loadVscode: () => fake.api as typeof vscodeTypes });
    const started = Date.now();
    const a = await ch.availability();
    assert.equal(a.available, false);
    assert.ok(Date.now() - started < 3500);
  });

  test('streams text chunks through onText and prefers gpt-4.1 > gpt-4o > claude > first', async () => {
    assert.equal(pickModel([{ family: 'o3' }, { family: 'claude-3.5' }, { family: 'gpt-4o' }, { family: 'gpt-4.1-mini' }])?.family, 'gpt-4.1-mini');
    assert.equal(pickModel([{ family: 'o3' }, { family: 'claude-3.5' }, { family: 'gpt-4o' }])?.family, 'gpt-4o');
    assert.equal(pickModel([{ family: 'o3' }, { family: 'claude-3.5' }])?.family, 'claude-3.5');
    assert.equal(pickModel([{ family: 'o3' }])?.family, 'o3');
    assert.equal(pickModel([]), undefined);
    const fake = fakeVscode([model('o3', ['wrong']), model('gpt-4.1', ['{"explanations"', ':[]}'])]);
    const disposables: Disposable[] = [];
    const ch = createLmChannel({ logger: silentLogger(), settings: settings(), consent: consent(true), disposables, loadVscode: () => fake.api as typeof vscodeTypes });
    const chunks: string[] = [];
    const r = await ch.send(req({ onText: (c) => chunks.push(c) }));
    assert.equal(r.text, '{"explanations":[]}');
    assert.deepEqual(chunks, ['{"explanations"', ':[]}']);
    assert.equal(disposables.length, 0, 'the cancellation source is removed again after the call');
  });

  test('LanguageModelError codes map to typed ChannelErrors so the router can fall back', async () => {
    for (const [err, reason] of [
      [FakeLmError.NoPermissions('no'), 'auth'],
      [FakeLmError.Blocked('policy'), 'blocked'],
      [FakeLmError.NotFound('gone'), 'unavailable'],
      [new Error('You have exceeded your premium requests quota'), 'quota'],
      [new Error('something odd'), 'failed'],
    ] as const) {
      const fake = fakeVscode([model('gpt-4o', err as Error)]);
      const ch = createLmChannel({ logger: silentLogger(), settings: settings(), consent: consent(true), disposables: [], loadVscode: () => fake.api as typeof vscodeTypes });
      await assert.rejects(ch.send(req()), (e: unknown) => e instanceof ChannelError && e.reason === reason && e.retryable === false, `${reason}`);
    }
    assert.equal(classifyLmError(new Error('rate limit exceeded'), undefined).reason, 'quota');
    assert.equal(classifyLmError({ code: 'NoPermissions', message: 'x' }, undefined).reason, 'auth');
  });

  test('empty reply -> bad-output; cancellation -> cancelled', async () => {
    const fake = fakeVscode([model('gpt-4o', [''])]);
    const ch = createLmChannel({ logger: silentLogger(), settings: settings(), consent: consent(true), disposables: [], loadVscode: () => fake.api as typeof vscodeTypes });
    await assert.rejects(ch.send(req()), (e: unknown) => e instanceof ChannelError && e.reason === 'bad-output');
    const src = new CancelSource();
    src.cancel();
    const slow = fakeVscode([{ family: 'gpt-4o', name: 'x', sendRequest: async () => { throw new Error('Canceled'); } }]);
    const ch2 = createLmChannel({ logger: silentLogger(), settings: settings(), consent: consent(true), disposables: [], loadVscode: () => slow.api as typeof vscodeTypes });
    await assert.rejects(ch2.send(req({ token: src.token })), (e: unknown) => e instanceof ChannelError && e.reason === 'cancelled');
  });
});
