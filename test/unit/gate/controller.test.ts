import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Decision } from '../../../src/core/types';
import { landedRecently } from '../../../src/core/landing';
import { canonicalPath } from '../../../src/core/paths';
import { GateController, IngressValidationError, MAX_SOURCE_BYTES, REVIEW_SIZE_CAP, normalizeVerdict } from '../../../src/gate/controller';
import { claudeEnvelope, codexEnvelope, makeHarness, type Harness } from './fakes';

const PY = 'def greet(name):\n    return "Hello, " + name\n\n\ndef farewell(name):\n    return "Bye, " + name\n';

suite('gate/controller', () => {
  let h: Harness;
  let c: GateController;
  let file: string;

  setup(() => {
    h = makeHarness();
    c = new GateController(h.deps);
    file = canonicalPath(path.join(h.workspace, 'src', 'app.py'));
    fs.writeFileSync(file, PY);
  });
  teardown(() => h.cleanup());

  const decision = (verdict: Decision['verdict'], extra: Partial<Decision> = {}): Decision => ({ requestId: '', verdict, scope: 'one', decidedAt: new Date().toISOString(), ...extra });

  test('malformed envelope throws IngressValidationError (HTTP 400)', async () => {
    await assert.rejects(c.handle({ agent: 'nope' } as never), (e) => e instanceof IngressValidationError && e.status === 400);
  });

  test('paused -> none even for a code write', async () => {
    c.setPaused(true);
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: 'x = 1\n' }, h.workspace));
    assert.deepEqual(d, { permissionDecision: 'none' });
    assert.equal(h.review.requests.length, 0);
  });

  test('irrelevant tool -> none', async () => {
    const d = await c.handle(claudeEnvelope('Read', { file_path: file }, h.workspace));
    assert.equal(d.permissionDecision, 'none');
  });

  test('protected path -> deny with reason, no review', async () => {
    const target = path.join(h.home, 'hooks', 'explainit-hook.js');
    const d = await c.handle(claudeEnvelope('Write', { file_path: target, content: 'evil' }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /ExplainIT/);
    assert.equal(h.review.requests.length, 0);
  });

  test('claude settings hooks change -> deny; unrelated setting change goes to review', async () => {
    const settings = path.join(h.userHome, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write' }] }, theme: 'dark' }));
    const d = await c.handle(claudeEnvelope('Write', { file_path: settings, content: JSON.stringify({ theme: 'dark' }) }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /hooks/);
    h.setReview(() => decision('accept'));
    const ok = await c.handle(claudeEnvelope('Write', { file_path: settings, content: JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write' }] }, theme: 'light' }) }, h.workspace));
    assert.equal(ok.permissionDecision, 'none', 'settings live outside the workspace: agent flow');
  });

  test('.git/** write -> ask', async () => {
    const d = await c.handle(claudeEnvelope('Write', { file_path: path.join(h.workspace, '.git', 'hooks', 'pre-commit'), content: '#!/bin/sh' }, h.workspace));
    assert.equal(d.permissionDecision, 'ask');
    assert.match(d.reason!, /\.git/);
  });

  test('write outside every workspace folder -> none', async () => {
    const d = await c.handle(claudeEnvelope('Write', { file_path: path.join(h.root, 'elsewhere.py'), content: 'x' }, h.workspace));
    assert.equal(d.permissionDecision, 'none');
  });

  test('valid twin write -> allow; invalid twin -> deny', async () => {
    const twin = path.join(h.workspace, 'src', 'app_explain.txt');
    const ok = await c.handle(claudeEnvelope('Write', { file_path: twin, content: 'ExplainIT header\n\n1. greet\nWhat it does: Says hello.\n' }, h.workspace));
    assert.deepEqual(ok, { permissionDecision: 'allow' });
    const bad = await c.handle(claudeEnvelope('Write', { file_path: twin, content: 'garbage' }, h.workspace));
    assert.equal(bad.permissionDecision, 'deny');
    assert.equal(bad.reason, 'Twin files are written by ExplainIT; edit the code instead');
  });

  test('NotebookEdit -> ask', async () => {
    const d = await c.handle(claudeEnvelope('NotebookEdit', { notebook_path: path.join(h.workspace, 'n.ipynb'), new_source: 'x' }, h.workspace));
    assert.equal(d.permissionDecision, 'ask');
  });

  suite('shell commands', () => {
    test('protected path mention -> deny regardless of mode', async () => {
      await h.deps.settings.set('gateShellWrites', 'ignore');
      const d = await c.handle(claudeEnvelope('Bash', { command: 'rm -rf ~/.explainit' }, h.workspace));
      assert.equal(d.permissionDecision, 'deny');
    });
    test('in-place write: deny / ask / ignore per setting', async () => {
      const env = claudeEnvelope('Bash', { command: `sed -i 's/a/b/' ${file}` }, h.workspace);
      assert.equal((await c.handle(env)).permissionDecision, 'deny');
      await h.deps.settings.set('gateShellWrites', 'ask');
      assert.equal((await c.handle(env)).permissionDecision, 'ask');
      await h.deps.settings.set('gateShellWrites', 'ignore');
      assert.equal((await c.handle(env)).permissionDecision, 'none');
    });
    test('benign command -> none; codex argv shell too', async () => {
      assert.equal((await c.handle(claudeEnvelope('Bash', { command: 'npm test > log.txt' }, h.workspace))).permissionDecision, 'none');
      assert.equal((await c.handle(codexEnvelope('shell', { command: ['bash', '-lc', 'git status'] }, h.workspace))).permissionDecision, 'none');
      assert.equal((await c.handle(codexEnvelope('shell', { command: ['bash', '-lc', 'echo x > a.py'] }, h.workspace))).permissionDecision, 'deny');
    });
  });

  test('Edit with old_string not found -> none (tool fails itself)', async () => {
    const d = await c.handle(claudeEnvelope('Edit', { file_path: file, old_string: 'not here', new_string: 'x' }, h.workspace));
    assert.equal(d.permissionDecision, 'none');
    assert.equal(h.review.requests.length, 0);
  });

  test('identical content -> allow without review', async () => {
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: PY }, h.workspace));
    assert.deepEqual(d, { permissionDecision: 'allow' });
    assert.equal(h.review.requests.length, 0);
  });

  test('proposal above 2 MB -> ask', async () => {
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: 'x'.repeat(REVIEW_SIZE_CAP + 1) }, h.workspace));
    assert.equal(d.permissionDecision, 'ask');
    assert.match(d.reason!, /2 MB/);
  });

  test('review accept -> allow, restore point, journal proposed+decided, memory, explanation streamed', async () => {
    h.setReview(() => decision('accept', { scope: 'one' }));
    const after = PY.replace('"Hello, "', '"Hi, "');
    const d = await c.handle(claudeEnvelope('Edit', { file_path: file, old_string: '"Hello, "', new_string: '"Hi, "' }, h.workspace));
    assert.deepEqual(d, { permissionDecision: 'allow' });
    assert.equal(h.review.requests.length, 1);
    const req = h.review.requests[0];
    assert.equal(req.agent, 'claude');
    assert.equal(req.writes[0].after, after);
    const hunks = req.hunksByPath[req.writes[0].path];
    assert.deepEqual(hunks.map((x) => [x.functionName, x.changeType]), [['greet', 'modified']]);
    assert.equal(h.router.calls, 1, 'one explanation per hunk');
    assert.equal(h.safety.checkpoints.saved.length, 1);
    assert.equal(h.safety.checkpoints.contents.get('cp-1'), PY);
    assert.deepEqual(h.safety.entries.map((e) => e.kind), ['proposed', 'decided']);
    assert.equal(h.safety.entries[1].checkpointId, 'cp-1');
    assert.equal(h.memory.remembered.length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), PY, 'the agent writes on allow, not the gate');
  });

  test('review reject -> deny with the person\'s reason verbatim', async () => {
    h.setReview(() => decision('reject', { reason: 'keep the old greeting, please' }));
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: PY.replace('Hello', 'Yo') }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.equal(d.reason, 'Rejected by the person: keep the old greeting, please');
    assert.equal(h.safety.checkpoints.saved.length, 0);
    assert.deepEqual(h.safety.entries.map((e) => e.kind), ['proposed', 'decided']);
  });

  test('partial acceptance -> gate writes the reconstructed file, journals applied, denies with the landed list', async () => {
    const after = PY.replace('"Hello, "', '"Hi, "').replace('"Bye, "', '"Ciao, "');
    h.setReview((req) => {
      const hunks = req.hunksByPath[req.writes[0].path];
      const hv: Record<string, 'accept' | 'reject'> = {};
      for (const x of hunks) hv[x.id] = x.functionName === 'greet' ? 'accept' : 'reject';
      return decision('partial', { hunkVerdicts: hv, reason: 'farewell should stay polite' });
    });
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: after }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /Partly accepted/);
    assert.match(d.reason!, /greet/);
    assert.match(d.reason!, /Rejected: farewell \(farewell should stay polite\)/);
    assert.match(d.reason!, /Re-read the file before continuing; do not re-apply the accepted parts\./);
    assert.equal(fs.readFileSync(file, 'utf8'), PY.replace('"Hello, "', '"Hi, "'));
    assert.equal(h.safety.checkpoints.contents.get('cp-1'), PY);
    assert.deepEqual(h.safety.entries.map((e) => e.kind), ['proposed', 'decided', 'applied']);
    assert.ok(landedRecently(canonicalPath(file)));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(h.twin.updated, [file]);
  });

  test('partial acceptance preserves CRLF line endings', async () => {
    const crlf = PY.replace(/\n/g, '\r\n');
    fs.writeFileSync(file, crlf);
    const after = crlf.replace('"Hello, "', '"Hi, "').replace('"Bye, "', '"Ciao, "');
    h.setReview((req) => {
      const hv: Record<string, 'accept' | 'reject'> = {};
      for (const x of req.hunksByPath[req.writes[0].path]) hv[x.id] = x.functionName === 'greet' ? 'accept' : 'reject';
      return decision('partial', { hunkVerdicts: hv });
    });
    await c.handle(claudeEnvelope('Write', { file_path: file, content: after }, h.workspace));
    assert.equal(fs.readFileSync(file, 'utf8'), crlf.replace('"Hello, "', '"Hi, "'));
  });

  test('partial with every hunk accepted behaves like accept; every hunk rejected like reject', async () => {
    h.setReview((req) => decision('partial', { hunkVerdicts: Object.fromEntries(req.hunksByPath[req.writes[0].path].map((x) => [x.id, 'accept'])) }));
    assert.equal((await c.handle(claudeEnvelope('Write', { file_path: file, content: PY.replace('Hello', 'Yo') }, h.workspace))).permissionDecision, 'allow');
    h.setReview((req) => decision('partial', { hunkVerdicts: Object.fromEntries(req.hunksByPath[req.writes[0].path].map((x) => [x.id, 'reject'])), reason: 'no' }));
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: PY.replace('Hello', 'Yo') }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.equal(d.reason, 'Rejected by the person: no');
  });

  test('review ask -> ask', async () => {
    h.setReview(() => decision('ask', { reason: 'not sure' }));
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: PY.replace('Hello', 'Yo') }, h.workspace));
    assert.deepEqual(d, { permissionDecision: 'ask', reason: 'not sure' });
  });

  test('decision memory covering every hunk -> allow with an auto decision and a restore point', async () => {
    h.setReview(() => decision('accept'));
    const after = PY.replace('Hello', 'Yo');
    await c.handle(claudeEnvelope('Write', { file_path: file, content: after }, h.workspace));
    const hunk = h.review.requests[0].hunksByPath[file][0];
    h.memory.accepted.add(hunk.id);
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: after }, h.workspace));
    assert.deepEqual(d, { permissionDecision: 'allow' });
    assert.equal(h.review.requests.length, 1, 'no second review');
    assert.equal(h.safety.checkpoints.saved.length, 2);
    assert.equal(h.memory.remembered[1].verdict, 'auto');
  });

  test('explanation failure never auto-allows: the presenter sees the error and decides', async () => {
    h.cleanup();
    h = makeHarness({ routerFail: true, review: () => decision('reject', { reason: 'could not read the explanation' }) });
    c = new GateController(h.deps);
    file = canonicalPath(path.join(h.workspace, 'src', 'app.py'));
    fs.writeFileSync(file, PY);
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: PY.replace('Hello', 'Yo') }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.equal(h.review.explainErrors.length, 1);
    assert.match(h.review.explainErrors[0].message, /assistant unavailable/);
  });

  test('structure engine failure -> reviewed as other hunks, still not auto-allowed', async () => {
    h.structure.fail = true;
    h.setReview(() => decision('reject', { reason: 'nope' }));
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: PY.replace('Hello', 'Yo') }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.equal(h.review.requests[0].hunksByPath[file][0].kind, 'other');
  });

  test('a throwing presenter -> ask (never allow)', async () => {
    h.setReview(() => {
      throw new Error('panel crashed');
    });
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: PY.replace('Hello', 'Yo') }, h.workspace));
    assert.equal(d.permissionDecision, 'ask');
    assert.match(d.reason!, /panel crashed/);
  });

  test('PostToolUse after an allow: journal applied with match, landing recorded, twin updated', async () => {
    h.setReview(() => decision('accept'));
    const after = PY.replace('Hello', 'Yo');
    await c.handle(claudeEnvelope('Write', { file_path: file, content: after }, h.workspace));
    fs.writeFileSync(file, after);
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: after }, h.workspace, 'PostToolUse'));
    assert.deepEqual(d, { permissionDecision: 'none' });
    const applied = h.safety.entries.filter((e) => e.kind === 'applied');
    assert.equal(applied.length, 1);
    assert.match(applied[0].note!, /match/);
    assert.doesNotMatch(applied[0].note!, /mismatch/);
    assert.ok(landedRecently(canonicalPath(file)));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(h.twin.updated, [file]);
  });

  test('PostToolUse with different content on disk -> journal mismatch', async () => {
    h.setReview(() => decision('accept'));
    await c.handle(claudeEnvelope('Write', { file_path: file, content: PY.replace('Hello', 'Yo') }, h.workspace));
    fs.writeFileSync(file, 'something else\n');
    await c.handle(claudeEnvelope('Write', { file_path: file, content: 'x' }, h.workspace, 'PostToolUse'));
    const applied = h.safety.entries.filter((e) => e.kind === 'applied');
    assert.match(applied[0].note!, /mismatch/);
  });

  test('codex apply_patch goes through the same review with per-file hunks', async () => {
    h.setReview(() => decision('accept'));
    const patch = ['*** Begin Patch', '*** Update File: src/app.py', '@@ def greet(name):', '-    return "Hello, " + name', '+    return "Hey, " + name', '*** Add File: src/new.py', '+def added():', '+    return 1', '*** End Patch'].join('\n');
    const d = await c.handle(codexEnvelope('apply_patch', { command: ['apply_patch', patch] }, h.workspace));
    assert.deepEqual(d, { permissionDecision: 'allow' });
    const req = h.review.requests[0];
    assert.equal(req.agent, 'codex');
    assert.equal(req.writes.length, 2);
    assert.deepEqual(req.hunksByPath[req.writes[0].path].map((x) => x.functionName), ['greet']);
    assert.deepEqual(req.hunksByPath[req.writes[1].path].map((x) => [x.functionName, x.changeType]), [['added', 'added']]);
  });

  test('codex PostToolUse for a patch records a landing for every touched path (moves use the destination)', async () => {
    const moved = path.join(h.workspace, 'src', 'moved.py');
    fs.writeFileSync(moved, PY);
    const patch = ['*** Begin Patch', '*** Update File: src/app.py', '*** Move to: src/moved.py', '@@', '-x', '+y', '*** End Patch'].join('\n');
    const d = await c.handle(codexEnvelope('apply_patch', { command: ['apply_patch', patch] }, h.workspace, 'PostToolUse'));
    assert.deepEqual(d, { permissionDecision: 'none' });
    assert.ok(landedRecently(canonicalPath(moved)));
    const applied = h.safety.entries.filter((e) => e.kind === 'applied');
    assert.equal(applied.length, 1);
    assert.equal(applied[0].path, canonicalPath(moved));
    assert.match(applied[0].note!, /unexpected/);
  });

  test('malformed codex apply_patch -> deny with a format hint', async () => {
    const d = await c.handle(codexEnvelope('apply_patch', { command: ['apply_patch', '*** Begin Patch\nnonsense\n*** End Patch'] }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /patch format/);
  });

  test('onRequest fires with the prepared request and pending count rises during review', async () => {
    let seen: string | undefined;
    let pendingDuring = -1;
    c.onRequest((r) => (seen = r.id));
    h.setReview(() => {
      pendingDuring = c.pending;
      return decision('accept');
    });
    await c.handle(claudeEnvelope('Write', { file_path: file, content: PY.replace('Hello', 'Yo') }, h.workspace), 'req-fixed');
    assert.equal(seen, 'req-fixed');
    assert.equal(pendingDuring, 1);
    assert.equal(c.pending, 0);
  });

  test('dispose clears the PostToolUse fallback timers (no dangling handles)', async () => {
    h.setReview(() => decision('accept'));
    await c.handle(claudeEnvelope('Write', { file_path: file, content: PY.replace('Hello', 'Yo') }, h.workspace));
    c.dispose();
    assert.equal(c.pending, 0);
  });

  test('creating or deleting an empty file has nothing to show -> none (agent prompt), never a silent allow', async () => {
    const empty = path.join(h.workspace, 'src', 'empty.py');
    const d = await c.handle(claudeEnvelope('Write', { file_path: empty, content: '' }, h.workspace));
    assert.deepEqual(d, { permissionDecision: 'none' });
    assert.equal(h.review.requests.length, 0);
    fs.writeFileSync(empty, '');
    const patch = ['*** Begin Patch', '*** Delete File: src/empty.py', '*** End Patch'].join('\n');
    const del = await c.handle(codexEnvelope('apply_patch', { command: ['apply_patch', patch] }, h.workspace));
    assert.deepEqual(del, { permissionDecision: 'none' });
  });

  test('a source file above the read cap is never loaded: ask with a plain-English reason', async () => {
    const big = path.join(h.workspace, 'src', 'big.py');
    fs.writeFileSync(big, Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61));
    const d = await c.handle(claudeEnvelope('Edit', { file_path: big, old_string: 'a', new_string: 'b' }, h.workspace));
    assert.equal(d.permissionDecision, 'ask');
    assert.match(d.reason!, /larger than 8 MB/);
    assert.equal(h.structure.calls, 0, 'the structure engine never saw the file');
  });

  test('deleting a file larger than the review cap -> ask (the before side counts)', async () => {
    const big = path.join(h.workspace, 'src', 'big.py');
    fs.writeFileSync(big, 'x'.repeat(REVIEW_SIZE_CAP + 1));
    const patch = ['*** Begin Patch', '*** Delete File: src/big.py', '*** End Patch'].join('\n');
    const d = await c.handle(codexEnvelope('apply_patch', { command: ['apply_patch', patch] }, h.workspace));
    assert.equal(d.permissionDecision, 'ask');
    assert.match(d.reason!, /2 MB/);
  });

  test('partial acceptance when the file changed on disk during the review -> deny, nothing written', async () => {
    const after = PY.replace('"Hello, "', '"Hi, "').replace('"Bye, "', '"Ciao, "');
    h.setReview((req) => {
      // Someone else writes the file while the review is open.
      fs.writeFileSync(file, PY + '\n\ndef extra():\n    pass\n');
      const hv: Record<string, 'accept' | 'reject'> = {};
      for (const x of req.hunksByPath[req.writes[0].path]) hv[x.id] = x.functionName === 'greet' ? 'accept' : 'reject';
      return decision('partial', { hunkVerdicts: hv, reason: 'no' });
    });
    const d = await c.handle(claudeEnvelope('Write', { file_path: file, content: after }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /changed on disk/);
    assert.match(d.reason!, /Re-read the file/);
    assert.equal(fs.readFileSync(file, 'utf8'), PY + '\n\ndef extra():\n    pass\n', 'the concurrent write survives');
    assert.equal(h.safety.checkpoints.saved.length, 0);
    assert.deepEqual(h.safety.entries.map((e) => e.kind), ['proposed', 'decided']);
    assert.deepEqual(h.twin.updated, []);
  });

  test('PostToolUse for a path outside every workspace folder is ignored (no journal, no twin update)', async () => {
    const outside = path.join(h.root, 'elsewhere.py');
    fs.writeFileSync(outside, 'x = 1\n');
    const d = await c.handle(claudeEnvelope('Write', { file_path: outside, content: 'x = 1\n' }, h.workspace, 'PostToolUse'));
    assert.deepEqual(d, { permissionDecision: 'none' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.safety.entries.length, 0);
    assert.deepEqual(h.twin.updated, []);
  });

  test('PostToolUse for a twin file never asks the twin engine to regenerate from the twin', async () => {
    const twin = path.join(h.workspace, 'src', 'app_explain.txt');
    fs.writeFileSync(twin, 'ExplainIT header\n\n1. greet\nWhat it does: Says hello.\n');
    const d = await c.handle(claudeEnvelope('Write', { file_path: twin, content: 'x' }, h.workspace, 'PostToolUse'));
    assert.deepEqual(d, { permissionDecision: 'none' });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(h.twin.updated, []);
    assert.equal(h.safety.entries.length, 0);
  });

  test('Edit whose old_string spans CRLF text on a CRLF file is reviewed with CRLF kept in the proposal', async () => {
    const crlf = PY.replace(/\n/g, '\r\n');
    fs.writeFileSync(file, crlf);
    h.setReview(() => decision('accept'));
    const d = await c.handle(claudeEnvelope('Edit', { file_path: file, old_string: '"Hello, " + name\n\n', new_string: '"Hi, " + name\n\n' }, h.workspace));
    assert.deepEqual(d, { permissionDecision: 'allow' });
    assert.equal(h.review.requests[0].writes[0].after, crlf.replace('"Hello, "', '"Hi, "'));
  });
});

suite('gate/controller: protected config files (hook script parity)', () => {
  let h: Harness;
  let c: GateController;
  const decision = (verdict: Decision['verdict'], extra: Partial<Decision> = {}): Decision => ({ requestId: '', verdict, scope: 'one', decidedAt: new Date().toISOString(), ...extra });

  const CMD = '/x/hooks/explainit-hook.sh --agent claude';
  const MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
  const PRE_ENTRY = `      { "matcher": "${MATCHER}", "hooks": [{ "type": "command", "command": "${CMD}", "timeout": 7200 }] }\n`;
  const POST_ENTRY = `      { "matcher": "${MATCHER}", "hooks": [{ "type": "command", "command": "${CMD} --event PostToolUse", "timeout": 10 }] }\n`;
  const SETTINGS = `{\n  "model": "opus",\n  "hooks": {\n    "PreToolUse": [\n${PRE_ENTRY}    ],\n    "PostToolUse": [\n${POST_ENTRY}    ]\n  },\n  "theme": "dark"\n}\n`;
  const TOML = ['model = "gpt-5"', '', '[features]', 'hooks = true', '', '[hooks.state."abc"]', 'trusted_hash = "sha256:1111"', '', '[tui]', 'theme = "dark"', ''].join('\n');
  const HOOKS_JSON = '{"hooks": {"PreToolUse": [{"matcher": "apply_patch", "hooks": [{"type": "command", "command": "/x/hooks/explainit-hook.sh --agent codex"}]}]}}\n';

  const write = (p: string, text: string): string => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };

  setup(() => {
    h = makeHarness();
    c = new GateController(h.deps);
  });
  teardown(() => h.cleanup());

  test('Edit that swaps "--agent claude" for "--agent x" inside our hook entry -> deny', async () => {
    const settings = write(path.join(h.userHome, '.claude', 'settings.json'), SETTINGS);
    const d = await c.handle(claudeEnvelope('Edit', { file_path: settings, old_string: '--agent claude"', new_string: '--agent x"' }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /hooks/);
    assert.equal(h.review.requests.length, 0);
    assert.equal(fs.readFileSync(settings, 'utf8'), SETTINGS, 'nothing written');
  });

  test('Edit that changes an unrelated setting in settings.json goes through to the normal flow', async () => {
    // Project layer inside the workspace: reviewed like any other file and allowed on accept.
    const project = write(path.join(h.workspace, '.claude', 'settings.json'), SETTINGS);
    h.setReview(() => decision('accept'));
    const d = await c.handle(claudeEnvelope('Edit', { file_path: project, old_string: '"theme": "dark"', new_string: '"theme": "light"' }, h.workspace));
    assert.deepEqual(d, { permissionDecision: 'allow' });
    assert.equal(h.review.requests.length, 1);
    assert.equal(h.review.requests[0].writes[0].after, SETTINGS.replace('"theme": "dark"', '"theme": "light"'));
    // User layer lives outside the workspace: not protected for this change, so the agent's own flow.
    const user = write(path.join(h.userHome, '.claude', 'settings.json'), SETTINGS);
    const u = await c.handle(claudeEnvelope('Edit', { file_path: user, old_string: '"theme": "dark"', new_string: '"theme": "light"' }, h.workspace));
    assert.deepEqual(u, { permissionDecision: 'none' });
    assert.equal(h.review.requests.length, 1, 'no review for a file outside the workspace');
  });

  test('MultiEdit that removes our entry -> deny, even when another edit in the batch is harmless', async () => {
    const settings = write(path.join(h.workspace, '.claude', 'settings.json'), SETTINGS);
    h.setReview(() => decision('accept'));
    const d = await c.handle(
      claudeEnvelope(
        'MultiEdit',
        {
          file_path: settings,
          edits: [
            { old_string: '"theme": "dark"', new_string: '"theme": "light"' },
            { old_string: PRE_ENTRY, new_string: '' },
          ],
        },
        h.workspace,
      ),
    );
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /hooks/);
    assert.equal(h.review.requests.length, 0);
  });

  test('Edit that leaves settings.json unparseable -> deny (hooks cannot be verified)', async () => {
    const settings = write(path.join(h.workspace, '.claude', 'settings.json'), SETTINGS);
    const d = await c.handle(claudeEnvelope('Edit', { file_path: settings, old_string: '"timeout": 7200', new_string: '"timeout": 7200,' }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /not valid JSON/);
  });

  test('config.toml edit that changes trusted_hash -> deny; theme change is not a hooks change', async () => {
    const toml = write(path.join(h.userHome, '.codex', 'config.toml'), TOML);
    const d = await c.handle(codexEnvelope('Edit', { file_path: toml, old_string: 'sha256:1111', new_string: 'sha256:9999' }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /hook/);
    const flag = await c.handle(claudeEnvelope('Edit', { file_path: toml, old_string: 'hooks = true', new_string: 'hooks = false' }, h.workspace));
    assert.equal(flag.permissionDecision, 'deny');
    const ok = await c.handle(codexEnvelope('Edit', { file_path: toml, old_string: 'theme = "dark"', new_string: 'theme = "light"' }, h.workspace));
    assert.deepEqual(ok, { permissionDecision: 'none' }, 'outside the workspace and not a hooks change: agent flow');
    const garbage = await c.handle(codexEnvelope('Write', { file_path: toml, content: 'this is not toml\n' }, h.workspace));
    assert.equal(garbage.permissionDecision, 'deny');
    assert.match(garbage.reason!, /cannot be parsed/);
  });

  test('CODEX_HOME set: hooks.json and config.toml are resolved under it', async () => {
    const codexHome = path.join(h.root, 'codex-home');
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const hooksJson = write(path.join(codexHome, 'hooks.json'), HOOKS_JSON);
      const toml = write(path.join(codexHome, 'config.toml'), TOML);
      // A whitespace-only partial edit of hooks.json is still a hooks change.
      const ws = await c.handle(codexEnvelope('Edit', { file_path: hooksJson, old_string: '"PreToolUse": [', new_string: '"PreToolUse":  [' }, h.workspace));
      assert.equal(ws.permissionDecision, 'deny');
      assert.match(ws.reason!, /nothing but hooks/);
      const swap = await c.handle(codexEnvelope('Edit', { file_path: hooksJson, old_string: '--agent codex', new_string: '--agent x' }, h.workspace));
      assert.equal(swap.permissionDecision, 'deny');
      const trust = await c.handle(codexEnvelope('Edit', { file_path: toml, old_string: 'sha256:1111', new_string: 'sha256:9999' }, h.workspace));
      assert.equal(trust.permissionDecision, 'deny');
      assert.match(trust.reason!, /hook/);
      const bad = await c.handle(codexEnvelope('Write', { file_path: hooksJson, content: '{"hooks": ' }, h.workspace));
      assert.equal(bad.permissionDecision, 'deny');
      const theme = await c.handle(codexEnvelope('Edit', { file_path: toml, old_string: 'theme = "dark"', new_string: 'theme = "light"' }, h.workspace));
      assert.deepEqual(theme, { permissionDecision: 'none' });
      const shell = await c.handle(codexEnvelope('shell', { command: ['bash', '-lc', `echo x > ${hooksJson}`] }, h.workspace));
      assert.equal(shell.permissionDecision, 'deny');
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
    // Without CODEX_HOME that folder is an ordinary place outside the workspace.
    const plain = await c.handle(codexEnvelope('Edit', { file_path: path.join(codexHome, 'hooks.json'), old_string: '--agent codex', new_string: '--agent x' }, h.workspace));
    assert.deepEqual(plain, { permissionDecision: 'none' });
  });

  test('codex apply_patch update of a project .codex/hooks.json is a partial edit -> deny', async () => {
    write(path.join(h.workspace, '.codex', 'hooks.json'), HOOKS_JSON);
    const patch = ['*** Begin Patch', '*** Update File: .codex/hooks.json', '@@', `-${HOOKS_JSON.trimEnd()}`, `+${JSON.stringify(JSON.parse(HOOKS_JSON))}`, '*** End Patch'].join('\n');
    const d = await c.handle(codexEnvelope('apply_patch', { command: ['apply_patch', patch] }, h.workspace));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /hooks/);
    assert.equal(h.review.requests.length, 0);
  });
});

suite('gate/controller: normalizeVerdict', () => {
  const decision = (verdict: Decision['verdict'], extra: Partial<Decision> = {}): Decision => ({ requestId: 'r', verdict, scope: 'one', decidedAt: '', ...extra });
  const hunk = (id: string) => ({ id, kind: 'function' as const, changeType: 'modified' as const, beforeText: 'a', afterText: 'b', trivial: false });

  test('special verdicts map directly', () => {
    assert.equal(normalizeVerdict(decision('paused'), [hunk('a')]), 'none');
    assert.equal(normalizeVerdict(decision('deny-protected'), [hunk('a')]), 'deny');
    assert.equal(normalizeVerdict(decision('ask'), [hunk('a')]), 'ask');
    assert.equal(normalizeVerdict(decision('auto'), []), 'accept');
  });
  test('an empty hunk list keeps the decision\'s own verdict (a stray partial is not an accept)', () => {
    assert.equal(normalizeVerdict(decision('accept'), []), 'accept');
    assert.equal(normalizeVerdict(decision('reject'), []), 'reject');
    assert.equal(normalizeVerdict(decision('partial', { hunkVerdicts: {} }), []), 'reject');
    assert.equal(normalizeVerdict(decision('partial'), []), 'reject');
  });
  test('per-hunk verdicts decide: all accept, all reject, mixed', () => {
    const hs = [hunk('a'), hunk('b')];
    assert.equal(normalizeVerdict(decision('partial', { hunkVerdicts: { a: 'accept', b: 'accept' } }), hs), 'accept');
    assert.equal(normalizeVerdict(decision('partial', { hunkVerdicts: { a: 'reject', b: 'reject' } }), hs), 'reject');
    assert.equal(normalizeVerdict(decision('partial', { hunkVerdicts: { a: 'accept', b: 'reject' } }), hs), 'partial');
    // A hunk the decision does not mention follows the overall verdict.
    assert.equal(normalizeVerdict(decision('accept', { hunkVerdicts: { a: 'reject' } }), hs), 'partial');
    assert.equal(normalizeVerdict(decision('partial', { hunkVerdicts: { a: 'accept' } }), hs), 'partial');
    assert.equal(normalizeVerdict(decision('reject', { hunkVerdicts: {} }), hs), 'reject');
  });
});
