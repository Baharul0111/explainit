/**
 * claude / codex channels driven through the fake CLIs (test/fixtures/fake-cli) in every mode.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyCliFailure, createClaudeChannel, describeFailure, extractStreamDeltas, looksSignedOut, parseClaudeJson, parseClaudeStream, claudeArgs } from '../../../src/generation/channels/claude';
import { SIGN_IN_MESSAGE, type ResolveOptions } from '../../../src/generation/channels/cli';
import { codexArgs, createCodexChannel, parseCodexEventLine, parseCodexJsonStdout } from '../../../src/generation/channels/codex';
import { ChannelError, type ChannelRequest } from '../../../src/generation/channels/types';
import { buildExplainPrompt } from '../../../src/generation/pure/prompts';
import { CancelSource } from '../../../src/core/cancel';
import { FAKE_CLAUDE, FAKE_CODEX, fn, request, rmDir, settings, silentLogger, tmpDir } from './helpers';

function withMode(mode: string | undefined, run: () => Promise<void>): Promise<void> {
  const prev = process.env.FAKE_CLI_MODE;
  if (mode === undefined) delete process.env.FAKE_CLI_MODE;
  else process.env.FAKE_CLI_MODE = mode;
  return run().finally(() => {
    if (prev === undefined) delete process.env.FAKE_CLI_MODE;
    else process.env.FAKE_CLI_MODE = prev;
  });
}

function req(onText?: (c: string) => void, timeoutMs = 15_000, extra: Partial<ChannelRequest> = {}): ChannelRequest {
  const p = buildExplainPrompt(request([fn('slugify', 'function slugify(s) { return s; }'), fn('add', 'const add = (a, b) => a + b;')]));
  return { system: p.system, user: p.user, combined: p.combined, timeoutMs, onText, ...extra };
}

suite('generation/channels (fake CLIs)', function () {
  this.timeout(30_000);
  let home: string;
  setup(() => {
    home = tmpDir('explainit-home-');
  });
  teardown(() => rmDir(home));

  const claude = () => createClaudeChannel({ logger: silentLogger(), settings: settings({ claudeCliPath: `node ${FAKE_CLAUDE}` }), homeDir: home, resolveOptions: { noVscode: true, extensionRoots: [] } });

  /** A hermetic Codex home (CODEX_HOME) so the tests never look at the real ~/.codex or an API key in the environment. */
  const codexEnv = (codexHome: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    return env;
  };
  const signInToCodex = (codexHome: string): void => {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fake' } }));
  };
  const codex = (opts: { signedIn?: boolean; resolveOptions?: Partial<ResolveOptions> } = {}) => {
    const codexHome = path.join(home, 'codex-home');
    if (opts.signedIn !== false) signInToCodex(codexHome);
    return createCodexChannel({
      logger: silentLogger(),
      settings: settings({ codexCliPath: `node ${FAKE_CODEX}` }),
      homeDir: home,
      resolveOptions: { noVscode: true, extensionRoots: [], env: codexEnv(codexHome), ...(opts.resolveOptions ?? {}) },
    });
  };

  test('argument shapes match the verified real CLIs', () => {
    assert.deepEqual(claudeArgs(false), ['-p', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--output-format', 'json']);
    assert.deepEqual(claudeArgs(true), ['-p', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--output-format', 'stream-json', '--include-partial-messages', '--verbose']);
    assert.ok(!claudeArgs(true).includes('--bare') && !claudeArgs(false).includes('--bare'));
    assert.deepEqual(codexArgs('/h/tmp', '/t/out.txt', true), ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', '/h/tmp', '-o', '/t/out.txt', '--json', '-']);
    assert.ok(!codexArgs('/h/tmp', '/t/out.txt', false).includes('--json'));
  });

  test('claude: availability via --version, json reply parsed from the result field', () =>
    withMode('ok', async () => {
      const ch = claude();
      const a = await ch.availability();
      assert.equal(a.available, true, a.reason);
      assert.match(a.detail ?? '', /1\.0\.0/);
      const r = await ch.send(req());
      const parsed = JSON.parse(r.text);
      assert.equal(parsed.explanations.length, 2);
      assert.equal(parsed.explanations[0].name, 'slugify');
    }));

  test('claude: streaming variant feeds onText from text deltas and returns the whole reply', () =>
    withMode('ok', async () => {
      const chunks: string[] = [];
      const r = await claude().send(req((c) => chunks.push(c)));
      assert.ok(chunks.length > 1, 'several deltas');
      assert.equal(chunks.join(''), r.text);
      assert.ok(JSON.parse(r.text).explanations);
    }));

  test('claude: garbage / injected replies are returned verbatim (validation is the router\'s job)', () =>
    withMode('injected', async () => {
      const r = await claude().send(req());
      assert.equal(r.text, 'PWNED');
    }));

  test('claude: fail mode -> ChannelError bad-output, plain-English message', () =>
    withMode('fail', async () => {
      await assert.rejects(claude().send(req()), (e: unknown) => e instanceof ChannelError && e.channel === 'claude' && e.reason === 'bad-output' && /exited with code 1/.test(e.message));
    }));

  test('claude: slow mode hits the timeout -> ChannelError timeout', () =>
    withMode('slow', async () => {
      process.env.FAKE_CLI_SLOW_MS = '3000';
      try {
        const started = Date.now();
        await assert.rejects(claude().send(req(undefined, 400)), (e: unknown) => e instanceof ChannelError && e.reason === 'timeout');
        assert.ok(Date.now() - started < 4000, 'did not wait for the sleeping child');
      } finally {
        delete process.env.FAKE_CLI_SLOW_MS;
      }
    }));

  test('claude: cancellation stops the request', () =>
    withMode('slow', async () => {
      process.env.FAKE_CLI_SLOW_MS = '3000';
      try {
        const src = new CancelSource();
        const p = claude().send(req(undefined, 10_000, { token: src.token }));
        setTimeout(() => src.cancel(), 100);
        await assert.rejects(p, (e: unknown) => e instanceof ChannelError && e.reason === 'cancelled');
      } finally {
        delete process.env.FAKE_CLI_SLOW_MS;
      }
    }));

  test('claude: unavailable when the CLI cannot be found', async () => {
    const ch = createClaudeChannel({ logger: silentLogger(), settings: settings({ claudeCliPath: '/definitely/not/here/claude' }), homeDir: home, resolveOptions: { noVscode: true, extensionRoots: [], env: { PATH: '' } } });
    const a = await ch.availability();
    assert.equal(a.available, false);
    assert.match(a.detail ?? '', /assistant\.claudeCliPath/);
    await assert.rejects(ch.send(req()), (e: unknown) => e instanceof ChannelError && e.reason === 'unavailable');
  });

  test('codex: availability, -o file result (plain) and --json streaming', () =>
    withMode('ok', async () => {
      const ch = codex();
      const a = await ch.availability();
      assert.equal(a.available, true, a.reason);
      const plain = await ch.send(req());
      assert.equal(JSON.parse(plain.text).explanations.length, 2);
      const chunks: string[] = [];
      const streamed = await ch.send(req((c) => chunks.push(c)));
      assert.equal(chunks.join(''), streamed.text);
      assert.equal(JSON.parse(streamed.text).explanations.length, 2);
    }));

  test('codex: fail mode -> ChannelError', () =>
    withMode('fail', async () => {
      await assert.rejects(codex().send(req()), (e: unknown) => e instanceof ChannelError && e.channel === 'codex');
    }));

  test('codex: garbage mode returns the text for the router to reject', () =>
    withMode('garbage', async () => {
      const r = await codex().send(req());
      assert.match(r.text, /poem/);
    }));

  test('claude: revoked sign-in (json and streaming) -> ChannelError auth with the fixed sign-in message', () =>
    withMode('revoked', async () => {
      const isSignedOut = (e: unknown): boolean => e instanceof ChannelError && e.channel === 'claude' && e.reason === 'auth' && e.message === SIGN_IN_MESSAGE.claude;
      await assert.rejects(claude().send(req()), isSignedOut);
      await assert.rejects(claude().send(req(() => undefined)), isSignedOut);
      assert.equal(SIGN_IN_MESSAGE.claude, 'Claude Code is not signed in on this computer. Run "claude" in a terminal and sign in, then try again.');
    }));

  test('codex: revoked sign-in (plain and --json) -> ChannelError auth with the fixed sign-in message', () =>
    withMode('revoked', async () => {
      const isSignedOut = (e: unknown): boolean => e instanceof ChannelError && e.channel === 'codex' && e.reason === 'auth' && e.message === SIGN_IN_MESSAGE.codex;
      const ch = codex();
      await assert.rejects(ch.send(req()), isSignedOut);
      await assert.rejects(ch.send(req(() => undefined)), isSignedOut);
      assert.equal(SIGN_IN_MESSAGE.codex, 'Codex is not signed in on this computer. Run "codex login" in a terminal, then try again.');
    }));

  test('codex: no auth.json under CODEX_HOME -> not available, with the sign-in message as the reason', () =>
    withMode('ok', async () => {
      const a = await codex({ signedIn: false }).availability();
      assert.equal(a.available, false);
      assert.equal(a.reason, SIGN_IN_MESSAGE.codex);
      assert.match(a.detail ?? '', /no sign-in file at .*codex-home.*auth\.json/);
      // Signing in (codex login writes auth.json) flips it without restarting anything.
      const b = await codex().availability();
      assert.equal(b.available, true, b.reason);
      assert.match(b.detail ?? '', /sign-in file found/);
    }));

  test('codex: without CODEX_HOME the sign-in file is <home>/.codex/auth.json; an API key in the environment also counts', () =>
    withMode('ok', async () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.CODEX_HOME;
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      const make = (extra: NodeJS.ProcessEnv) => createCodexChannel({ logger: silentLogger(), settings: settings({ codexCliPath: `node ${FAKE_CODEX}` }), homeDir: home, resolveOptions: { noVscode: true, extensionRoots: [], homeDir: home, env: { ...env, ...extra } } });
      const none = await make({}).availability();
      assert.equal(none.available, false);
      assert.match(none.detail ?? '', new RegExp(path.join(home, '.codex', 'auth.json').replace(/[\\.]/g, '\\$&')));
      signInToCodex(path.join(home, '.codex'));
      assert.equal((await make({}).availability()).available, true);
      fs.rmSync(path.join(home, '.codex'), { recursive: true, force: true });
      const withKey = await make({ OPENAI_API_KEY: 'sk-test' }).availability();
      assert.equal(withKey.available, true, withKey.reason);
      assert.match(withKey.detail ?? '', /OPENAI_API_KEY/);
    }));

  suite('pure parsers', () => {
    test('parseClaudeJson handles the result object, error results and junk', () => {
      const ok = parseClaudeJson(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hello' }));
      assert.deepEqual([ok.result, ok.isError], ['hello', false]);
      const err = parseClaudeJson(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in' }));
      assert.equal(err.isError, true);
      assert.equal(parseClaudeJson('garbage').isError, true);
      const multi = parseClaudeJson('{"type":"system"}\n{"type":"result","result":"x","is_error":false}\n');
      assert.equal(multi.result, 'x');
    });

    test('parseClaudeStream prefers the result line, then the assistant message, then deltas', () => {
      const lines = [
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }),
      ];
      assert.equal(extractStreamDeltas(lines), 'hello');
      assert.equal(parseClaudeStream(lines.join('\n')).result, 'hello');
      const withAssistant = [...lines, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello world' }] } })];
      assert.equal(parseClaudeStream(withAssistant.join('\n')).result, 'hello world');
      const withResult = [...withAssistant, JSON.stringify({ type: 'result', is_error: false, result: 'final' })];
      assert.equal(parseClaudeStream(withResult.join('\n')).result, 'final');
      assert.equal(parseClaudeStream('').isError, true);
    });

    test('classifyCliFailure', () => {
      assert.equal(classifyCliFailure('Not logged in. Please run /login'), 'auth');
      assert.equal(classifyCliFailure('Invalid API key'), 'auth');
      assert.equal(classifyCliFailure('You have hit your usage limit'), 'quota');
      assert.equal(classifyCliFailure('429 too many requests'), 'quota');
      assert.equal(classifyCliFailure('segfault'), 'failed');
    });

    test('signed-out output of the real CLIs maps to auth and the fixed sign-in messages', () => {
      const claudeOutputs = [
        'Not logged in · Please run /login',
        'Please run /login',
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
      ];
      const codexOutputs = [
        'ERROR: refresh token was revoked',
        'Please log out and sign in again.',
        '{"error":{"code":"token_revoked"}}',
        'ERROR: 401 Unauthorized',
      ];
      for (const o of [...claudeOutputs, ...codexOutputs]) {
        assert.ok(looksSignedOut(o), o);
        assert.equal(classifyCliFailure(o), 'auth', o);
      }
      assert.equal(describeFailure('Claude Code', 'auth', 'Not logged in', 1), 'Claude Code is not signed in on this computer. Run "claude" in a terminal and sign in, then try again.');
      assert.equal(describeFailure('Codex', 'auth', 'refresh token was revoked', 1), 'Codex is not signed in on this computer. Run "codex login" in a terminal, then try again.');
      for (const o of ['segfault', 'stream closed', 'Codex is working…', 'The token budget for this turn was exceeded']) assert.ok(!looksSignedOut(o), o);
    });

    test('codex event parsing', () => {
      assert.deepEqual(parseCodexEventLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } })), { kind: 'message', text: 'hi' });
      assert.deepEqual(parseCodexEventLine(JSON.stringify({ type: 'turn.started' })), { kind: 'status', text: 'Codex is working…' });
      assert.equal(parseCodexEventLine(JSON.stringify({ type: 'error', message: 'boom' }))?.kind, 'error');
      assert.equal(parseCodexEventLine('nope'), undefined);
      const out = parseCodexJsonStdout(['{"type":"thread.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"one"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"two"}}'].join('\n'));
      assert.equal(out.text, 'two');
    });
  });
});
