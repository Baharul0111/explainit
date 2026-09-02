/**
 * Conformance tests for hooks/explainit-hook.js (plain mocha; spawns node with the script; runs in
 * CI on every OS). Uses a stub gate on 127.0.0.1 and a temp EXPLAINIT_HOME.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { decideWith, json, longPollThen, runHook, startStub, writeSession, type HookRun, type StubGate } from './stubGate';

const ASK_REASON = 'ExplainIT is not responding; falling back to your normal permission prompt.';

suite('hook script conformance', function () {
  this.timeout(60000);
  let root: string;
  let home: string;
  let proj: string;
  let stub: StubGate;
  const outputs: HookRun[] = [];

  const claudePayload = (tool: string, input: Record<string, unknown>, event = 'PreToolUse'): string =>
    JSON.stringify({ session_id: 'sess', transcript_path: '/tmp/t.jsonl', cwd: proj, permission_mode: 'default', hook_event_name: event, tool_name: tool, tool_input: input, tool_use_id: 'toolu_1' });
  const codexPayload = (tool: string, input: Record<string, unknown>): string =>
    JSON.stringify({ session_id: 'c1', turn_id: 't1', transcript_path: null, cwd: proj, hook_event_name: 'PreToolUse', model: 'gpt', permission_mode: 'default', tool_name: tool, tool_input: input, tool_use_id: 'exec-1' });

  async function hook(args: string[], stdin: string | Buffer, extraEnv: Record<string, string | undefined> = {}): Promise<HookRun> {
    const r = await runHook(args, stdin, { EXPLAINIT_HOME: home, ...extraEnv });
    outputs.push(r);
    assert.strictEqual(r.code, 0, `exit code 0 expected, stderr: ${r.stderr}`);
    return r;
  }
  const parse = (r: HookRun): any => JSON.parse(r.stdout);

  suiteSetup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-hook-'));
    home = path.join(root, 'home');
    proj = path.join(root, 'proj');
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'app.py'), 'def greet(n):\n    return "Hello " + n\n');
    stub = await startStub();
  });
  suiteTeardown(async () => {
    await stub.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  setup(() => {
    for (const f of fs.readdirSync(path.join(home, 'sessions'))) fs.rmSync(path.join(home, 'sessions', f));
    stub.requests.length = 0;
    stub.handler = decideWith({ permissionDecision: 'allow' });
  });

  test('irrelevant tool -> empty stdout', async () => {
    writeSession(home, stub, [proj]);
    const r = await hook(['--agent', 'claude'], claudePayload('Read', { file_path: path.join(proj, 'src', 'app.py') }));
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(stub.requests.length, 0);
  });

  test('no session -> empty stdout (agent\'s own flow)', async () => {
    const r = await hook(['--agent', 'claude'], claudePayload('Write', { file_path: path.join(proj, 'src', 'app.py'), content: 'x' }));
    assert.strictEqual(r.stdout, '');
  });

  test('a session whose pid is dead is ignored', async () => {
    writeSession(home, stub, [proj], 2147483646);
    const r = await hook(['--agent', 'claude'], claudePayload('Write', { file_path: path.join(proj, 'src', 'app.py'), content: 'x' }));
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(stub.requests.length, 0);
  });

  test('a session for another folder is not used', async () => {
    writeSession(home, stub, [path.join(root, 'elsewhere')]);
    const r = await hook(['--agent', 'claude'], claudePayload('Write', { file_path: path.join(proj, 'src', 'app.py'), content: 'x' }));
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(stub.requests.length, 0);
  });

  test('protected path without a session: write inside the ExplainIT home -> deny', async () => {
    const r = await hook(['--agent', 'claude'], claudePayload('Write', { file_path: path.join(home, 'state.json'), content: '{}' }));
    const out = parse(r).hookSpecificOutput;
    assert.strictEqual(out.hookEventName, 'PreToolUse');
    assert.strictEqual(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /ExplainIT refused this change/);
  });

  test('protected: .git/info/exclude and Bash mentioning the hook are denied', async () => {
    const r1 = await hook(['--agent', 'claude'], claudePayload('Write', { file_path: path.join(proj, '.git', 'info', 'exclude'), content: '' }));
    assert.strictEqual(parse(r1).hookSpecificOutput.permissionDecision, 'deny');
    const r2 = await hook(['--agent', 'claude'], claudePayload('Bash', { command: 'rm -f ~/.explainit/hooks/explainit-hook.sh' }));
    assert.strictEqual(parse(r2).hookSpecificOutput.permissionDecision, 'deny');
    const r3 = await hook(['--agent', 'codex'], codexPayload('Bash', { command: 'sed -i "" "s/x/y/" ~/.codex/hooks.json' }));
    assert.strictEqual(parse(r3).hookSpecificOutput.permissionDecision, 'deny');
    const ok = await hook(['--agent', 'claude'], claudePayload('Bash', { command: 'npm test' }));
    assert.strictEqual(ok.stdout, '', 'harmless command with no session passes through');
  });

  test('protected: project .claude/settings.json is denied only when hooks change', async () => {
    const settings = path.join(proj, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'x/explainit-hook.sh' }] }] } }));
    const denyEdit = await hook(['--agent', 'claude'], claudePayload('Edit', { file_path: settings, old_string: '"hooks"', new_string: '"nohooks"' }));
    assert.strictEqual(parse(denyEdit).hookSpecificOutput.permissionDecision, 'deny');
    const denyWrite = await hook(['--agent', 'claude'], claudePayload('Write', { file_path: settings, content: JSON.stringify({ model: 'opus' }) }));
    assert.strictEqual(parse(denyWrite).hookSpecificOutput.permissionDecision, 'deny');
    const denyBroken = await hook(['--agent', 'claude'], claudePayload('Write', { file_path: settings, content: '{ not json' }));
    assert.strictEqual(parse(denyBroken).hookSpecificOutput.permissionDecision, 'deny');
    const sameHooks = await hook(['--agent', 'claude'], claudePayload('Write', { file_path: settings, content: JSON.stringify({ model: 'sonnet', hooks: JSON.parse(fs.readFileSync(settings, 'utf8')).hooks }) }));
    assert.strictEqual(sameHooks.stdout, '', 'hooks unchanged -> not protected (and no session -> nothing)');
    const plainEdit = await hook(['--agent', 'claude'], claudePayload('Edit', { file_path: settings, old_string: '"opus"', new_string: '"sonnet"' }));
    assert.strictEqual(plainEdit.stdout, '');
    // An edit that never says "hooks" but changes the hook command is still a hooks change (the edit is replayed).
    const sneaky = await hook(['--agent', 'claude'], claudePayload('Edit', { file_path: settings, old_string: 'x/', new_string: 'y/' }));
    assert.strictEqual(parse(sneaky).hookSpecificOutput.permissionDecision, 'deny');
    const sneakyMulti = await hook(['--agent', 'claude'], claudePayload('MultiEdit', { file_path: settings, edits: [{ old_string: '"opus"', new_string: '"haiku"' }, { old_string: '"Write"', new_string: '"Read"' }] }));
    assert.strictEqual(parse(sneakyMulti).hookSpecificOutput.permissionDecision, 'deny');
    const multiPlain = await hook(['--agent', 'claude'], claudePayload('MultiEdit', { file_path: settings, edits: [{ old_string: '"opus"', new_string: '"haiku"' }] }));
    assert.strictEqual(multiPlain.stdout, '', 'a MultiEdit that leaves hooks alone is not protected');
  });

  test('protected: project .codex files — any edit of hooks.json, and trust-record edits of config.toml', async () => {
    const codexDir = path.join(proj, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const hooks = path.join(codexDir, 'hooks.json');
    fs.writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x/explainit-hook.sh --agent codex' }] }] } }));
    const editHooks = await hook(['--agent', 'codex'], codexPayload('Edit', { file_path: hooks, old_string: 'Bash', new_string: 'Never' }));
    assert.strictEqual(parse(editHooks).hookSpecificOutput.permissionDecision, 'deny');
    const sameWrite = await hook(['--agent', 'codex'], codexPayload('Write', { file_path: hooks, content: fs.readFileSync(hooks, 'utf8') }));
    assert.strictEqual(sameWrite.stdout, '', 'rewriting hooks.json with identical hooks is not a change');
    const config = path.join(codexDir, 'config.toml');
    fs.writeFileSync(config, 'model = "gpt"\n\n[hooks.state."/h/hooks.json:pre_tool_use:0:0"]\nenabled = true\ntrusted_hash = "sha256:aaaa"\n');
    const hashOnly = await hook(['--agent', 'codex'], codexPayload('Edit', { file_path: config, old_string: 'sha256:aaaa', new_string: 'sha256:bbbb' }));
    assert.strictEqual(parse(hashOnly).hookSpecificOutput.permissionDecision, 'deny', 'replacing just the hash value is a trust change');
    const modelOnly = await hook(['--agent', 'codex'], codexPayload('Edit', { file_path: config, old_string: '"gpt"', new_string: '"gpt-6"' }));
    assert.strictEqual(modelOnly.stdout, '', 'changing the model line is not protected');
  });

  test('protected: shell commands naming ~/.explainit in any spelling are denied', async () => {
    for (const cmd of ['rm -rf ~/.explainit', 'rm -rf "$HOME/.explainit/sessions"', 'ls ~/.EXPLAINIT/hooks']) {
      const r = await hook(['--agent', 'claude'], claudePayload('Bash', { command: cmd }));
      assert.strictEqual(parse(r).hookSpecificOutput.permissionDecision, 'deny', cmd);
    }
  });

  test('protected: user-layer ~/.claude/settings.json and ~/.codex files are denied for whole-file writes', async () => {
    const userSettings = path.join(os.homedir(), '.claude', 'settings.json');
    const r = await hook(['--agent', 'claude'], claudePayload('Write', { file_path: userSettings, content: JSON.stringify({ hooks: { PreToolUse: [] } }) }));
    assert.strictEqual(parse(r).hookSpecificOutput.permissionDecision, 'deny');
    const c = await hook(['--agent', 'codex'], codexPayload('Write', { file_path: path.join(os.homedir(), '.codex', 'config.toml'), content: 'model = "x"\n' }));
    assert.strictEqual(parse(c).hookSpecificOutput.permissionDecision, 'deny');
  });

  test('protected: a custom CODEX_HOME is honoured for hooks.json and config.toml', async () => {
    const codexHome = path.join(root, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    const denied = await hook(['--agent', 'codex'], codexPayload('Write', { file_path: path.join(codexHome, 'hooks.json'), content: '{"hooks":{}}' }), { CODEX_HOME: codexHome });
    assert.strictEqual(parse(denied).hookSpecificOutput.permissionDecision, 'deny');
    const deniedToml = await hook(['--agent', 'codex'], codexPayload('Edit', { file_path: path.join(codexHome, 'config.toml'), old_string: 'trusted_hash', new_string: 'x' }), { CODEX_HOME: codexHome });
    assert.strictEqual(parse(deniedToml).hookSpecificOutput.permissionDecision, 'deny');
    const plain = await hook(['--agent', 'codex'], codexPayload('Write', { file_path: path.join(codexHome, 'notes.md'), content: 'hi' }), { CODEX_HOME: codexHome });
    assert.strictEqual(plain.stdout, '', 'other files in CODEX_HOME are not protected (and no session -> nothing)');
  });

  test('200 allow -> allow JSON; envelope and bearer token reach the gate', async () => {
    writeSession(home, stub, [proj]);
    const file = path.join(proj, 'src', 'app.py');
    const r = await hook(['--agent', 'claude', '--watchdog', '30'], claudePayload('Edit', { file_path: file, old_string: 'Hello', new_string: 'Hi' }));
    assert.deepStrictEqual(parse(r), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'ExplainIT checkpoint: allow' } });
    assert.strictEqual(stub.requests.length, 1);
    const req = stub.requests[0];
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url, '/v1/hook');
    assert.strictEqual(req.headers.authorization, `Bearer ${stub.token}`);
    assert.strictEqual(req.body.agent, 'claude');
    assert.strictEqual(req.body.event, 'PreToolUse');
    assert.strictEqual(req.body.payload.tool_name, 'Edit');
    assert.strictEqual(req.body.payload.tool_input.file_path, file);
    assert.ok(req.body.hookVersion);
  });

  test('allow with updatedInput and a custom reason is passed through', async () => {
    writeSession(home, stub, [proj]);
    stub.handler = (req, res) => json(res, 200, { decision: { permissionDecision: 'allow', reason: 'Accepted by the person.', updatedInput: { file_path: 'x', content: 'y' } } });
    const r = await hook(['--agent', 'claude'], claudePayload('Write', { file_path: path.join(proj, 'a.py'), content: 'x' }));
    const out = parse(r).hookSpecificOutput;
    assert.strictEqual(out.permissionDecisionReason, 'Accepted by the person.');
    assert.deepStrictEqual(out.updatedInput, { file_path: 'x', content: 'y' });
  });

  test('202 then done deny -> deny JSON with the reason', async () => {
    writeSession(home, stub, [proj]);
    stub.handler = longPollThen({ permissionDecision: 'deny', reason: 'Rejected: keep the greeting friendly.' }, 300);
    const r = await hook(['--agent', 'claude', '--watchdog', '30'], claudePayload('Write', { file_path: path.join(proj, 'src', 'app.py'), content: 'x' }));
    assert.deepStrictEqual(parse(r), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Rejected: keep the greeting friendly.' } });
    assert.deepStrictEqual(stub.requests.map((q) => q.method), ['POST', 'GET']);
    assert.strictEqual(stub.requests[1].url, '/v1/decision/req-1');
  });

  test('pending heartbeats beyond the watchdog keep the hook waiting', async () => {
    writeSession(home, stub, [proj]);
    stub.handler = longPollThen({ permissionDecision: 'allow' }, 1200, 3); // 3 x 1.2 s of "pending" > 2 s watchdog
    const r = await hook(['--agent', 'claude', '--watchdog', '2'], claudePayload('Write', { file_path: path.join(proj, 'src', 'app.py'), content: 'x' }));
    assert.strictEqual(parse(r).hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(r.ms >= 4500, `waited ${r.ms} ms`);
    assert.strictEqual(stub.requests.filter((q) => q.method === 'GET').length, 4);
  });

  test('silent gate -> ask JSON after the watchdog', async () => {
    writeSession(home, stub, [proj]);
    stub.handler = () => undefined; // never answers
    const r = await hook(['--agent', 'claude', '--watchdog', '2'], claudePayload('Write', { file_path: path.join(proj, 'src', 'app.py'), content: 'x' }));
    assert.deepStrictEqual(parse(r), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: ASK_REASON } });
    assert.ok(r.ms >= 1900 && r.ms < 8000, `took ${r.ms} ms`);
  });

  test('gate that stops answering mid long-poll -> ask', async () => {
    writeSession(home, stub, [proj]);
    stub.handler = (req, res) => {
      if (req.method === 'POST') return json(res, 202, { requestId: 'r' });
      /* never answer the poll */
    };
    const r = await hook(['--agent', 'claude', '--watchdog', '2'], claudePayload('Write', { file_path: path.join(proj, 'src', 'app.py'), content: 'x' }));
    assert.strictEqual(parse(r).hookSpecificOutput.permissionDecision, 'ask');
  });

  test('gate refusing connections -> ask', async () => {
    const dead = await startStub();
    const port = dead.port;
    await dead.close();
    writeSession(home, { port, token: 'deadbeef' }, [proj]);
    const r = await hook(['--agent', 'claude', '--watchdog', '5'], claudePayload('Write', { file_path: path.join(proj, 'src', 'app.py'), content: 'x' }));
    assert.strictEqual(parse(r).hookSpecificOutput.permissionDecision, 'ask');
    assert.ok(r.ms < 5000, 'connection errors do not wait out the whole watchdog');
  });

  test('none decision -> empty stdout', async () => {
    writeSession(home, stub, [proj]);
    stub.handler = decideWith({ permissionDecision: 'none' });
    const r = await hook(['--agent', 'claude'], claudePayload('Bash', { command: 'ls' }));
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(stub.requests.length, 1);
  });

  test('codex: apply_patch relative path resolves against cwd and reaches the gate', async () => {
    writeSession(home, stub, [proj]);
    const patch = '*** Begin Patch\n*** Update File: src/app.py\n@@\n-    return "Hello " + n\n+    return "Hi " + n\n*** End Patch';
    const r = await hook(['--agent', 'codex'], codexPayload('apply_patch', { command: patch }));
    assert.strictEqual(r.stdout, '', 'Codex treats a bare allow as unsupported, so allow prints nothing (normal flow proceeds)');
    assert.strictEqual(stub.requests[0].body.agent, 'codex');
    assert.strictEqual(stub.requests[0].body.payload.tool_input.command, patch);
    stub.handler = decideWith({ permissionDecision: 'deny', reason: 'Rejected: keep it.' });
    const d = await hook(['--agent', 'codex'], codexPayload('apply_patch', { command: patch }));
    assert.deepStrictEqual(parse(d), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Rejected: keep it.' } });
  });

  test('codex: allow with updatedInput is printed (the one allow form Codex accepts)', async () => {
    writeSession(home, stub, [proj]);
    stub.handler = (req, res) => json(res, 200, { decision: { permissionDecision: 'allow', updatedInput: { command: 'echo rewritten' } } });
    const r = await hook(['--agent', 'codex'], codexPayload('Bash', { command: 'echo hi' }));
    const out = parse(r).hookSpecificOutput;
    assert.strictEqual(out.permissionDecision, 'allow');
    assert.deepStrictEqual(out.updatedInput, { command: 'echo rewritten' });
  });

  test('codex: apply_patch outside every session folder -> nothing', async () => {
    writeSession(home, stub, [proj]);
    const patch = '*** Begin Patch\n*** Add File: ../outside.py\n+x\n*** End Patch';
    const r = await hook(['--agent', 'codex'], codexPayload('apply_patch', { command: patch }));
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(stub.requests.length, 0);
  });

  test('codex: ask is not supported by Codex, so it prints nothing on stdout', async () => {
    writeSession(home, stub, [proj]);
    stub.handler = decideWith({ permissionDecision: 'ask' });
    const r = await hook(['--agent', 'codex'], codexPayload('shell', { command: ['bash', '-lc', 'ls'] }));
    assert.strictEqual(r.stdout, '');
    assert.match(r.stderr, /ExplainIT/);
    const silent = await startStub();
    silent.handler = () => undefined;
    writeSession(home, silent, [proj]);
    const r2 = await hook(['--agent', 'codex', '--watchdog', '2'], codexPayload('Write', { file_path: path.join(proj, 'x.py'), content: 'x' }));
    assert.strictEqual(r2.stdout, '');
    await silent.close();
  });

  test('PostToolUse -> empty stdout and the stub received the POST', async () => {
    writeSession(home, stub, [proj]);
    const r = await hook(['--agent', 'claude', '--event', 'PostToolUse'], claudePayload('Write', { file_path: path.join(proj, 'src', 'app.py'), content: 'x' }, 'PostToolUse'));
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(stub.requests.length, 1);
    assert.strictEqual(stub.requests[0].body.event, 'PostToolUse');
    assert.ok(r.ms < 5000);
  });

  test('PostToolUse with a silent gate gives up within about 5 s', async () => {
    writeSession(home, stub, [proj]);
    stub.handler = () => undefined;
    const r = await hook(['--agent', 'codex', '--event', 'PostToolUse'], codexPayload('apply_patch', { command: '*** Begin Patch\n*** Update File: src/app.py\n*** End Patch' }));
    assert.strictEqual(r.stdout, '');
    assert.ok(r.ms < 8000, `took ${r.ms} ms`);
  });

  test('PostToolUse never denies, even for a protected path', async () => {
    const r = await hook(['--agent', 'claude', '--event', 'PostToolUse'], claudePayload('Write', { file_path: path.join(home, 'x'), content: '' }, 'PostToolUse'));
    assert.strictEqual(r.stdout, '');
  });

  test('malformed, empty and oversized stdin -> empty stdout, exit 0', async () => {
    writeSession(home, stub, [proj]);
    assert.strictEqual((await hook(['--agent', 'claude'], '{ this is not json')).stdout, '');
    assert.strictEqual((await hook(['--agent', 'claude'], '')).stdout, '');
    assert.strictEqual((await hook(['--agent', 'claude'], '[1,2,3]')).stdout, '');
    const big = Buffer.alloc(8 * 1024 * 1024 + 10, 0x20);
    assert.strictEqual((await hook(['--agent', 'claude'], big)).stdout, '');
    assert.strictEqual(stub.requests.length, 0);
  });

  test('--home overrides EXPLAINIT_HOME', async () => {
    const other = path.join(root, 'other-home');
    writeSession(other, stub, [proj]);
    const r = await hook(['--agent', 'claude', '--home', other], claudePayload('Write', { file_path: path.join(proj, 'a.py'), content: 'x' }), { EXPLAINIT_HOME: home });
    assert.strictEqual(parse(r).hookSpecificOutput.permissionDecision, 'allow');
  });

  test('the token never appears in stdout or stderr', () => {
    assert.ok(outputs.length > 10);
    for (const o of outputs) {
      assert.ok(!o.stdout.includes(stub.token));
      assert.ok(!o.stderr.includes(stub.token));
    }
  });
});
