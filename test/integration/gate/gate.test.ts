/**
 * Gate integration tests: run inside VS Code with test/fixtures/workspace open, EXPLAINIT_TEST_MODE=1
 * and EXPLAINIT_HOME pointing at a temp folder. Decisions are driven through the review presenter's
 * test hook (`globalThis.__explainitReviewTestHook`), so the full gate -> review -> journal path runs
 * with no stubs inside the extension.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Decision, GateRequest, HookDecision } from '../../../src/core/types';
import type { HookEnvelope } from '../../../src/core/interfaces';
import type { ExplainitApi } from '../../../src/extension';
import { HOME_LAYOUT, explainitHome } from '../../../src/core/paths';

type ReviewHook = (request: GateRequest) => Decision | Promise<Decision>;

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

/** Install a decision script for the review presenter's test hook. */
function setReviewHook(hook: ReviewHook | undefined): void {
  (globalThis as any).__explainitReviewTestHook = hook;
}

const decision = (verdict: Decision['verdict'], extra: Partial<Decision> = {}): Decision => ({
  requestId: '',
  verdict,
  scope: 'one',
  decidedAt: new Date().toISOString(),
  ...extra,
});

suite('gate (integration)', function () {
  this.timeout(120_000);

  let api: ExplainitApi;
  let workspace: string;
  let file: string;
  let twin: string;
  let port: number;
  let token: string;

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

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('BaharulIslam.explainit');
    assert.ok(ext, 'extension not found');
    api = (await ext.activate()) as ExplainitApi;
    workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
    file = path.join(workspace, 'tmp_gate.py');
    twin = path.join(workspace, 'tmp_gate_explain.txt');
    if (!api.gate.info) await api.gate.start();
    port = api.gate.info!.port;
    token = api.gate.info!.token;
    api.gate.setPaused(false);
  });

  setup(() => {
    fs.writeFileSync(file, PY);
    setReviewHook(undefined);
  });

  teardown(() => {
    setReviewHook(undefined);
    for (const p of [file, twin]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  suiteTeardown(async () => {
    setReviewHook(undefined);
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

  test('GET /v1/health answers without a token', async () => {
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
  });

  test('valid twin write -> allow; garbage twin -> deny', async () => {
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
    const bad = await api.gate.handle(claudeWrite(twin, 'not a twin'));
    assert.equal(bad.permissionDecision, 'deny');
    assert.match(bad.reason!, /Twin files are written by ExplainIT/);
  });

  test('Write accepted through the review hook -> allow, restore point saved, journal has proposed + decided', async () => {
    setReviewHook(() => decision('accept'));
    const after = PY.replace('"Hello, "', '"Hi, "');
    const r = await request(port, 'POST', '/v1/hook', JSON.stringify(claudeWrite(file, after)), token);
    let d: HookDecision;
    if (r.status === 202) {
      d = await pollDecision(r.body.requestId);
    } else {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      d = r.body.decision;
    }
    assert.deepEqual(d, { permissionDecision: 'allow' });
    assert.equal(fs.readFileSync(file, 'utf8'), PY, 'on allow the agent writes, not the gate');

    const kit = api.kits().find((k) => k.journal.file.length > 0)!;
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

  test('rejected through the review hook -> deny with the person\'s reason', async () => {
    setReviewHook(() => decision('reject', { reason: 'keep the old greeting' }));
    const d = await api.gate.handle(claudeWrite(file, PY.replace('Hello', 'Yo')));
    assert.equal(d.permissionDecision, 'deny');
    assert.equal(d.reason, 'Rejected by the person: keep the old greeting');
    assert.equal(fs.readFileSync(file, 'utf8'), PY);
  });

  test('partial acceptance writes the accepted parts and denies with the landed list', async () => {
    setReviewHook((req) => {
      const hunks = req.hunksByPath[req.writes[0].path];
      const hv: Record<string, 'accept' | 'reject'> = {};
      for (const h of hunks) hv[h.id] = h.functionName === 'greet' ? 'accept' : 'reject';
      return decision('partial', { hunkVerdicts: hv, reason: 'farewell stays' });
    });
    const after = PY.replace('"Hello, "', '"Hi, "').replace('"Bye, "', '"Ciao, "');
    const d = await api.gate.handle(claudeWrite(file, after));
    assert.equal(d.permissionDecision, 'deny');
    assert.match(d.reason!, /Partly accepted/);
    assert.match(d.reason!, /greet/);
    assert.match(d.reason!, /farewell/);
    assert.match(d.reason!, /Re-read the file before continuing/);
    assert.equal(fs.readFileSync(file, 'utf8'), PY.replace('"Hello, "', '"Hi, "'));
  });

  test('long-poll: 202 then pending with heartbeat, then done', async () => {
    let release: (() => void) | undefined;
    const gateOpen = new Promise<void>((r) => (release = r));
    setReviewHook(async () => {
      await gateOpen;
      return decision('accept');
    });
    const r = await request(port, 'POST', '/v1/hook', JSON.stringify(claudeWrite(file, PY.replace('Hello', 'Yo'))), token);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const id = r.body.requestId as string;
    assert.ok(id);
    // Poll while the review is still open: pending + heartbeat (the long-poll is capped at 25 s,
    // so release the review shortly after to keep the test fast).
    const pendingPoll = request(port, 'GET', `/v1/decision/${id}`, undefined, token);
    const releaseTimer = setTimeout(() => release!(), 1500);
    const first = await pendingPoll;
    clearTimeout(releaseTimer);
    release!();
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
