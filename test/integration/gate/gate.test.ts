/**
 * Gate integration tests: run inside VS Code with test/fixtures/workspace open, EXPLAINIT_TEST_MODE=1
 * and EXPLAINIT_HOME pointing at a temp folder. Decisions are driven through the real review
 * presenter's test hook (`globalThis.__explainitReviewTestHook`, an object installed by the review
 * module — never overwritten here), so the full gate -> review -> journal path runs with no stubs
 * inside the extension. Only the router's model call is stubbed (no assistant is signed in on CI).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { ChangeExplanation, GateRequest, HookDecision } from '../../../src/core/types';
import type { ChangeExplainRequest, GenerationOptions, HookEnvelope } from '../../../src/core/interfaces';
import type { ExplainitApi } from '../../../src/extension';
import type { ReviewTestHook } from '../../../src/review/panel';
import { HOME_LAYOUT, canonicalPath, explainitHome } from '../../../src/core/paths';

const PY = 'def greet(name):\n    return "Hello, " + name\n\n\ndef farewell(name):\n    return "Bye, " + name\n';

interface Resp {
  status: number;
  body: any;
}

function request(port: number, method: string, urlPath: string, body?: string, token?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
          ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* keep text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** The review presenter's hook object (installed by createReviewPresenter in EXPLAINIT_TEST_MODE). */
function hook(): ReviewTestHook {
  const h = (globalThis as Record<string, unknown>).__explainitReviewTestHook as ReviewTestHook | undefined;
  assert.ok(h, 'review test hook must be installed in EXPLAINIT_TEST_MODE');
  return h;
}

type CardPlan = ['accept'] | ['acceptFile'] | ['acceptSession'] | ['reject', string];
type Planner = (card: { id: string; title: string; hunkIds: string[]; path: string }, request: GateRequest | undefined) => CardPlan;

/**
 * Drive the review the way a person would: wait for the panel to show, then for every card wait
 * until its explanation rendered (Accept is refused before that, host-side) and decide.
 */
async function driveReview(plan: Planner, requestRef: () => GateRequest | undefined): Promise<void> {
  const h = hook();
  await waitFor(() => h.current() !== undefined, 'the review to be shown');
  for (let guard = 0; guard < 50; guard++) {
    const cur = h.current();
    if (!cur) return;
    const card = cur.cards[cur.hunkIndex];
    assert.ok(card, 'a current card');
    const d = plan(card, requestRef());
    if (d[0] === 'reject') {
      assert.equal(h.decide('reject', d[1]), true, `reject ${card.title}`);
    } else {
      await h.waitForExplained();
      assert.equal(h.decide(d[0]), true, `${d[0]} ${card.title}`);
    }
    await sleep(10);
  }
  throw new Error('the review never completed');
}

suite('gate (integration)', function () {
  this.timeout(120_000);

  let api: ExplainitApi;
  let workspace: string;
  let file: string;
  let twin: string;
  let port: number;
  let token: string;
  let sandbox: sinon.SinonSandbox;
  let lastRequest: GateRequest | undefined;
  let requestSub: { dispose(): void } | undefined;

  const claudeWrite = (filePath: string, content: string, event: 'PreToolUse' | 'PostToolUse' = 'PreToolUse'): HookEnvelope => ({
    agent: 'claude',
    event,
    payload: {
      session_id: 'integration-session',
      cwd: workspace,
      hook_event_name: event,
      tool_name: 'Write',
      tool_input: { file_path: filePath, content },
      tool_use_id: `toolu_${Date.now()}`,
    },
  });

  /** Deterministic "explanation" so the review's Accept can be enabled without an assistant. */
  function stubExplain(): sinon.SinonStub {
    return sandbox.stub(api.router, 'explainChange').callsFake(async (req: ChangeExplainRequest, o?: GenerationOptions): Promise<ChangeExplanation> => {
      o?.progress?.onText?.('The function now ');
      await sleep(20);
      o?.progress?.onText?.('says something else.');
      return {
        functionName: req.functionName,
        whatChanged: `${req.functionName} now returns different text.`,
        whyItMatters: ['Anyone calling it will see the new text.'],
        modelChannel: 'claude',
        createdAt: new Date().toISOString(),
      };
    });
  }

  async function closeStaleReview(): Promise<void> {
    const h = hook();
    for (let i = 0; i < 20 && h.current(); i++) {
      h.closePanel();
      await sleep(50);
    }
  }

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('BaharulIslam.explainit');
    assert.ok(ext, 'extension not found');
    api = (await ext.activate()) as ExplainitApi;
    workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
    file = canonicalPath(path.join(workspace, 'tmp_gate.py'));
    twin = canonicalPath(path.join(workspace, 'tmp_gate_explain.txt'));
    if (!api.gate.info) await api.gate.start();
    port = api.gate.info!.port;
    token = api.gate.info!.token;
    api.gate.setPaused(false);
    requestSub = api.gate.onRequest((r) => (lastRequest = r));
  });

  setup(async () => {
    sandbox = sinon.createSandbox();
    lastRequest = undefined;
    api.memory.clearAll();
    fs.writeFileSync(file, PY);
    await closeStaleReview();
  });

  teardown(async () => {
    await closeStaleReview();
    sandbox.restore();
    for (const p of [file, twin]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  suiteTeardown(async () => {
    requestSub?.dispose();
    api.gate.setPaused(false);
    for (const p of [file, twin]) fs.rmSync(p, { force: true });
    // Close any editors the review opened for our temp files.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('server starts on 127.0.0.1 with a random port and a 64-hex token', () => {
    const info = api.gate.info!;
    assert.ok(info.port > 0);
    assert.match(info.token, /^[a-f0-9]{64}$/);
    assert.equal(info.pid, process.pid);
    assert.ok(info.folders.length >= 1);
  });

  test('GET /v1/health answers without a token and includes the pid (the Doctor relies on it)', async () => {
    const r = await request(port, 'GET', '/v1/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.pid, process.pid);
    assert.equal(r.body.paused, false);
    assert.equal(typeof r.body.version, 'string');
  });

  test('401 on a bad token', async () => {
    const r = await request(port, 'POST', '/v1/hook', JSON.stringify(claudeWrite(file, 'x')), 'f'.repeat(64));
    assert.equal(r.status, 401);
    assert.doesNotMatch(JSON.stringify(r.body), new RegExp(token), 'the real token is never echoed');
  });

  test('400 on malformed JSON and on an unknown agent', async () => {
    assert.equal((await request(port, 'POST', '/v1/hook', '{oops', token)).status, 400);
    const r = await request(port, 'POST', '/v1/hook', JSON.stringify({ agent: 'copilot', event: 'PreToolUse', payload: { tool_name: 'Write', tool_input: {} } }), token);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /agent/i);
  });

  test('session file exists under <home>/sessions/<pid>.json with mode 0600', () => {
    const sessionFile = path.join(HOME_LAYOUT.sessions(), `${process.pid}.json`);
    assert.ok(fs.existsSync(sessionFile), sessionFile);
    const parsed = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(parsed.port, port);
    assert.equal(parsed.token, token);
    assert.ok(Array.isArray(parsed.folders) && parsed.folders.length >= 1);
    if (process.platform !== 'win32') assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
  });

  test('paused -> none', async () => {
    api.gate.setPaused(true);
    try {
      const d = await api.gate.handle(claudeWrite(file, PY.replace('Hello', 'Yo')));
      assert.deepEqual(d, { permissionDecision: 'none' });
      const health = await request(port, 'GET', '/v1/health');
      assert.equal(health.body.paused, true);
    } finally {
      api.gate.setPaused(false);
    }
  });

  test('protected path -> deny with a plain-English reason', async () => {
    const d = await api.gate.handle(claudeWrite(path.join(explainitHome(), 'state.json'), '{}'));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /ExplainIT/);
    const exclude = await api.gate.handle(claudeWrite(path.join(workspace, '.git', 'info', 'exclude'), ''));
    assert.equal(exclude.permissionDecision, 'deny');
    // Git hooks and the git config run as the person outside any review: denied outright, not `ask`.
    const gitHook = await api.gate.handle(claudeWrite(path.join(workspace, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n'));
    assert.equal(gitHook.permissionDecision, 'deny');
    assert.match(gitHook.reason!, /git hook or the git config/);
    const gitConfig = await api.gate.handle(claudeWrite(path.join(workspace, '.git', 'config'), '[core]\n'));
    assert.equal(gitConfig.permissionDecision, 'deny');
    assert.equal(hook().current(), undefined, 'no review was opened');
  });

  test('a shell command that changes into a protected folder is denied whatever the shellWrites setting', async () => {
    const env: HookEnvelope = {
      agent: 'claude',
      event: 'PreToolUse',
      payload: { session_id: 'integration-session', cwd: workspace, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cd ~/.claude && cat > settings.json' } },
    };
    const d = await api.gate.handle(env);
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /ExplainIT/);
    assert.equal(hook().current(), undefined, 'no review was opened');
  });

  test('a PostToolUse for a write ExplainIT never allowed is noted in the journal and otherwise ignored', async () => {
    // A file of its own, so no landing expected by an earlier accepted write can be mistaken for this one.
    const forged = canonicalPath(path.join(workspace, 'tmp_gate_forged.py'));
    fs.writeFileSync(forged, PY);
    try {
      const kit = api.kits()[0];
      const post = await api.gate.handle(claudeWrite(forged, PY, 'PostToolUse'));
      assert.deepEqual(post, { permissionDecision: 'none' });
      const entries = await kit.journal.list({ path: forged });
      assert.equal(entries.filter((e) => e.kind === 'applied').length, 0, 'no applied entry for a write nobody allowed');
      assert.ok(entries.some((e) => e.kind === 'system' && /had not allowed/.test(e.note ?? '')), 'a note records the ignored PostToolUse');
    } finally {
      fs.rmSync(forged, { force: true });
    }
  });

  test('valid twin write -> allow without a review (twin-file fast path); garbage twin -> deny', async () => {
    const valid = [
      'ExplainIT — plain-English twin of tmp_gate.py',
      'Written by ExplainIT. Not committed to git. Right-click a section for "Regenerate this section".',
      '',
      '1. greet',
      'What it does: Builds a greeting for the given name.',
      'How it works:',
      '- It joins the word Hello with the name.',
      '- It hands the text back.',
      '',
    ].join('\n');
    const ok = await api.gate.handle(claudeWrite(twin, valid));
    assert.deepEqual(ok, { permissionDecision: 'allow' });
    assert.equal(hook().current(), undefined, 'a valid twin never opens the review');
    const bad = await api.gate.handle(claudeWrite(twin, 'not a twin'));
    assert.equal(bad.permissionDecision, 'deny');
    assert.match(bad.reason!, /Twin files are written by ExplainIT/);
  });

  test('Write accepted through the review -> allow, restore point saved, journal has proposed + decided', async () => {
    const explain = stubExplain();
    const after = PY.replace('"Hello, "', '"Hi, "');
    const posted = request(port, 'POST', '/v1/hook', JSON.stringify(claudeWrite(file, after)), token);
    await driveReview(() => ['accept'], () => lastRequest);
    const r = await posted;
    let d: HookDecision;
    if (r.status === 202) {
      d = await pollDecision(r.body.requestId);
    } else {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      d = r.body.decision;
    }
    assert.deepEqual(d, { permissionDecision: 'allow' });
    assert.ok(explain.callCount >= 1, 'the explanation was requested through the router');
    assert.equal(fs.readFileSync(file, 'utf8'), PY, 'on allow the agent writes, not the gate');
    assert.ok(lastRequest, 'onRequest fired with the prepared request');
    assert.equal(lastRequest!.writes[0].path, file);

    const kit = api.kits()[0];
    const entries = await kit.journal.list({ path: file });
    const kinds = entries.map((e) => e.kind);
    assert.ok(kinds.includes('proposed'), kinds.join());
    assert.ok(kinds.includes('decided'), kinds.join());
    const cps = await kit.checkpoints.list(file);
    assert.ok(cps.length >= 1, 'a restore point was saved before the accepted write');

    // PostToolUse after the agent wrote: none, and an 'applied' entry lands.
    fs.writeFileSync(file, after);
    const post = await api.gate.handle(claudeWrite(file, after, 'PostToolUse'));
    assert.deepEqual(post, { permissionDecision: 'none' });
    const applied = (await kit.journal.list({ path: file })).filter((e) => e.kind === 'applied');
    assert.ok(applied.length >= 1);
  });

  test("rejected through the review -> deny with the person's reason verbatim, no reason needed to be explained first", async () => {
    stubExplain();
    const pending = api.gate.handle(claudeWrite(file, PY.replace('Hello', 'Yo')));
    await driveReview(() => ['reject', 'keep the old greeting'], () => lastRequest);
    const d = await pending;
    assert.equal(d.permissionDecision, 'deny');
    assert.equal(d.reason, 'Rejected by the person: keep the old greeting');
    assert.equal(fs.readFileSync(file, 'utf8'), PY);
  });

  test('partial acceptance writes the accepted parts and denies with the landed list', async () => {
    stubExplain();
    const after = PY.replace('"Hello, "', '"Hi, "').replace('"Bye, "', '"Ciao, "');
    const pending = api.gate.handle(claudeWrite(file, after));
    await driveReview((card, req) => {
      const hunks = req ? req.hunksByPath[req.writes[0].path] : [];
      const names = card.hunkIds.map((id) => hunks.find((h) => h.id === id)?.functionName ?? '');
      return names.includes('greet') ? ['accept'] : ['reject', 'farewell stays'];
    }, () => lastRequest);
    const d = await pending;
    assert.ok(lastRequest, 'onRequest fired');
    const hunkNames = lastRequest!.hunksByPath[file].map((h) => h.functionName);
    assert.ok(hunkNames.includes('greet') && hunkNames.includes('farewell'), `per-function hunks: ${hunkNames.join()}`);
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /Partly accepted/);
    assert.match(d.reason!, /greet/);
    assert.match(d.reason!, /farewell/);
    assert.match(d.reason!, /farewell stays/);
    assert.match(d.reason!, /Re-read the file before continuing/);
    assert.equal(fs.readFileSync(file, 'utf8'), PY.replace('"Hello, "', '"Hi, "'));
    const applied = (await api.kits()[0].journal.list({ path: file })).filter((e) => e.kind === 'applied');
    assert.ok(applied.length >= 1, 'the gate journaled its own write');
  });

  test('"accept rest of file" is remembered: the same change again is allowed without a review', async () => {
    stubExplain();
    const after = PY.replace('Hello', 'Yo');
    const first = api.gate.handle(claudeWrite(file, after));
    await driveReview(() => ['acceptFile'], () => lastRequest);
    assert.deepEqual(await first, { permissionDecision: 'allow' });
    const again = await api.gate.handle(claudeWrite(file, after));
    assert.deepEqual(again, { permissionDecision: 'allow' });
    assert.equal(hook().current(), undefined, 'decision memory answered without a second review');
  });

  test('long-poll: 202 then pending with heartbeat (or done), then done', async () => {
    stubExplain();
    const r = await request(port, 'POST', '/v1/hook', JSON.stringify(claudeWrite(file, PY.replace('Hello', 'Yo'))), token);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const id = r.body.requestId as string;
    assert.ok(id);
    // Poll while the review is still open, then decide: the poll answers `done` as soon as the
    // decision exists (the long-poll is capped at 25 s, so a `pending` heartbeat is also acceptable).
    const pendingPoll = request(port, 'GET', `/v1/decision/${id}`, undefined, token);
    await sleep(300);
    await driveReview(() => ['accept'], () => lastRequest);
    const first = await pendingPoll;
    assert.equal(first.status, 200);
    if (first.body.status === 'pending') {
      assert.match(first.body.heartbeat, /^\d{4}-\d{2}-\d{2}T/);
      const done = await pollDecision(id);
      assert.deepEqual(done, { permissionDecision: 'allow' });
    } else {
      assert.deepEqual(first.body, { status: 'done', decision: { permissionDecision: 'allow' } });
    }
    assert.equal((await request(port, 'GET', '/v1/decision/req-does-not-exist', undefined, token)).status, 404);
  });

  test('closing the review panel rejects the change (never allows)', async () => {
    stubExplain();
    const pending = api.gate.handle(claudeWrite(file, PY.replace('Hello', 'Yo')));
    const h = hook();
    await waitFor(() => h.current() !== undefined, 'the review to be shown');
    h.closePanel();
    const d = await pending;
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /Review closed without a decision/);
    assert.equal(fs.readFileSync(file, 'utf8'), PY);
  });

  test('a failing explanation never auto-allows: accept stays refused, reject still works', async () => {
    sandbox.stub(api.router, 'explainChange').rejects(new Error('assistant unavailable'));
    const pending = api.gate.handle(claudeWrite(file, PY.replace('Hello', 'Yo')));
    const h = hook();
    await waitFor(() => h.current() !== undefined, 'the review to be shown');
    await waitFor(() => h.current()?.cards[h.current()!.hunkIndex]?.explain === 'error', 'the error state', 30_000);
    assert.equal(h.decide('accept'), false, 'accept is refused without an explanation');
    assert.equal(h.decide('reject', 'could not read an explanation'), true);
    const d = await pending;
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /could not read an explanation/);
  });

  test('heartbeat event fires with a pending count', async () => {
    const beat = await new Promise<{ ts: string; pending: number }>((resolve) => {
      const d = api.gate.onHeartbeat((e) => {
        d.dispose();
        resolve(e);
      });
      api.gate.setPaused(false); // setPaused emits a heartbeat immediately
    });
    assert.match(beat.ts, /^\d{4}-/);
    assert.equal(typeof beat.pending, 'number');
  });

  async function pollDecision(id: string): Promise<HookDecision> {
    for (let i = 0; i < 20; i++) {
      const r = await request(port, 'GET', `/v1/decision/${id}`, undefined, token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      if (r.body.status === 'done') return r.body.decision;
    }
    throw new Error('decision never arrived');
  }
});
