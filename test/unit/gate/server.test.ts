import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HookDecision } from '../../../src/core/types';
import type { HookEnvelope } from '../../../src/core/interfaces';
import { IngressValidationError } from '../../../src/gate/controller';
import { BODY_LIMIT, FAST_PATH_MS, GateHttpServer, MAX_IN_FLIGHT } from '../../../src/gate/server';
import { quietLogger } from './fakes';

interface Resp {
  status: number;
  body: any;
}

function request(port: number, method: string, urlPath: string, body?: string, token?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) } },
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

suite('gate/server', () => {
  let dir: string;
  let server: GateHttpServer;
  let port: number;
  let token: string;
  let disposables: { dispose(): void }[];
  let resolveSlow: ((d: HookDecision) => void) | undefined;
  let paused = false;

  const handle = async (envelope: HookEnvelope, requestId: string): Promise<HookDecision> => {
    const agent = (envelope as any)?.agent;
    if (agent !== 'claude' && agent !== 'codex') throw new IngressValidationError('bad envelope');
    const tool = (envelope.payload as any)?.tool_name;
    if (tool === 'Slow') return new Promise<HookDecision>((r) => (resolveSlow = r));
    if (tool === 'Boom') throw new Error('kaboom');
    return { permissionDecision: 'deny', reason: `fast ${requestId}` };
  };

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-server-'));
    disposables = [];
    server = new GateHttpServer({ logger: quietLogger(), version: '9.9.9', folders: () => ['/ws'], paused: () => paused, handle, disposables, sessionsDir: () => dir, fastPathMs: 300, longPollMs: 400 });
    const info = await server.start();
    port = info.port;
    token = info.token;
  });
  teardown(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const envelope = (tool: string): string => JSON.stringify({ agent: 'claude', event: 'PreToolUse', payload: { tool_name: tool, tool_input: {} } });

  test('binds 127.0.0.1 on a random port with a 64-hex token and writes the session file (0600)', () => {
    assert.ok(port > 0);
    assert.match(token, /^[a-f0-9]{64}$/);
    const file = path.join(dir, `${process.pid}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.port, port);
    assert.equal(parsed.token, token);
    assert.deepEqual(parsed.folders, ['/ws']);
    assert.equal(parsed.version, '9.9.9');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test('start purges stale session files of dead pids', async () => {
    await server.stop();
    fs.writeFileSync(path.join(dir, '999999.json'), JSON.stringify({ pid: 999999, port: 1, token: 'x' }));
    await server.start();
    assert.equal(fs.existsSync(path.join(dir, '999999.json')), false);
    assert.equal(fs.existsSync(path.join(dir, `${process.pid}.json`)), true);
  });

  test('GET /v1/health needs no token', async () => {
    const r = await request(port, 'GET', '/v1/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, version: '9.9.9', paused: false, pid: process.pid });
    paused = true;
    assert.equal((await request(port, 'GET', '/v1/health')).body.paused, true);
    paused = false;
  });

  test('401 on a missing or wrong token; the error never echoes the token', async () => {
    const r1 = await request(port, 'POST', '/v1/hook', envelope('Write'));
    assert.equal(r1.status, 401);
    const r2 = await request(port, 'POST', '/v1/hook', envelope('Write'), 'f'.repeat(64));
    assert.equal(r2.status, 401);
    assert.doesNotMatch(JSON.stringify(r2.body), new RegExp(token));
  });

  test('404 for unknown routes and unknown decision ids', async () => {
    assert.equal((await request(port, 'GET', '/v1/nope', undefined, token)).status, 404);
    assert.equal((await request(port, 'GET', '/v1/decision/req-unknown', undefined, token)).status, 404);
    assert.equal((await request(port, 'PUT', '/v1/hook', envelope('Write'), token)).status, 404);
  });

  test('400 for malformed JSON and for schema failures, with an error message', async () => {
    const r1 = await request(port, 'POST', '/v1/hook', '{not json', token);
    assert.equal(r1.status, 400);
    assert.match(r1.body.error, /not valid JSON/);
    const r2 = await request(port, 'POST', '/v1/hook', JSON.stringify({ agent: 'nope' }), token);
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error, 'bad envelope');
  });

  test('413 when the body is larger than 8 MB', async () => {
    const big = JSON.stringify({ agent: 'claude', event: 'PreToolUse', payload: { tool_name: 'Write', tool_input: { content: 'x'.repeat(BODY_LIMIT + 10) } } });
    const r = await request(port, 'POST', '/v1/hook', big, token);
    assert.equal(r.status, 413);
  });

  test('413 for a chunked body (no content-length) that grows past 8 MB, answered before the socket drops', async function () {
    this.timeout(20_000);
    const r = await new Promise<Resp>((resolve, reject) => {
      let status = 0;
      let text = '';
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep text */
        }
        resolve({ status, body: parsed });
      };
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/v1/hook', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
        (res) => {
          status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            text = Buffer.concat(chunks).toString('utf8');
            settle();
          });
        },
      );
      // Some platforms still reset the connection once the answer is out (the client is usually
      // mid-write when the cap is hit). That is fine as long as the answer arrived first; a reset
      // with no answer at all is the failure this test guards.
      req.on('error', (e) => (status ? settle() : reject(e)));
      req.write('{"agent":"claude","event":"PreToolUse","payload":{"tool_name":"Write","tool_input":{"content":"');
      const piece = Buffer.alloc(256 * 1024, 0x78);
      let sent = 0;
      const pump = (): void => {
        while (sent <= BODY_LIMIT + piece.length) {
          sent += piece.length;
          if (!req.write(piece)) {
            req.once('drain', pump);
            return;
          }
        }
        req.end('"}}');
      };
      pump();
    });
    assert.equal(r.status, 413);
    if (typeof r.body === 'object' && r.body) assert.match(r.body.error, /larger than 8 MB/);
  });

  test('500 with a message when handling throws unexpectedly', async () => {
    const r = await request(port, 'POST', '/v1/hook', envelope('Boom'), token);
    assert.equal(r.status, 500);
    assert.match(r.body.error, /kaboom/);
  });

  test('fast path: 200 with the decision', async () => {
    const r = await request(port, 'POST', '/v1/hook', envelope('Write'), token);
    assert.equal(r.status, 200);
    assert.equal(r.body.decision.permissionDecision, 'deny');
    assert.match(r.body.decision.reason, /^fast req-/);
  });

  test('slow path: 202 + requestId, long-poll returns pending with a heartbeat then done', async function () {
    this.timeout(FAST_PATH_MS + 10_000);
    const started = Date.now();
    const r = await request(port, 'POST', '/v1/hook', envelope('Slow'), token);
    assert.equal(r.status, 202);
    assert.ok(Date.now() - started >= 250, 'the fast-path window was waited out');
    const id = r.body.requestId as string;
    assert.match(id, /^req-/);
    assert.equal(server.inFlight, 1);
    // The long-poll window (400 ms here, 25 s in production) elapses -> pending + heartbeat.
    const pending = await request(port, 'GET', `/v1/decision/${id}`, undefined, token);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, 'pending');
    assert.match(pending.body.heartbeat, /^\d{4}-\d{2}-\d{2}T/);
    // A poll that races the decision: resolve shortly after polling starts.
    const poll = request(port, 'GET', `/v1/decision/${id}`, undefined, token);
    await new Promise((res) => setTimeout(res, 100));
    resolveSlow!({ permissionDecision: 'allow' });
    const done = await poll;
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { status: 'done', decision: { permissionDecision: 'allow' } });
    // Late polls still find the finished decision.
    const again = await request(port, 'GET', `/v1/decision/${id}`, undefined, token);
    assert.equal(again.body.status, 'done');
    assert.equal(server.inFlight, 0);
  });

  test('beyond the in-flight cap the server answers ask at once instead of queueing more work (F7)', async function () {
    this.timeout(10_000);
    await server.stop();
    server = new GateHttpServer({ logger: quietLogger(), version: '9.9.9', folders: () => ['/ws'], paused: () => paused, handle, disposables, sessionsDir: () => dir, fastPathMs: 100, longPollMs: 200, maxInFlight: 1 });
    const info = await server.start();
    port = info.port;
    token = info.token;
    assert.equal(MAX_IN_FLIGHT, 64);
    const first = await request(port, 'POST', '/v1/hook', envelope('Slow'), token);
    assert.equal(first.status, 202);
    assert.equal(server.inFlight, 1);
    const second = await request(port, 'POST', '/v1/hook', envelope('Write'), token);
    assert.equal(second.status, 200);
    assert.equal(second.body.decision.permissionDecision, 'ask');
    assert.match(second.body.decision.reason, /1 changes waiting for a decision/);
    assert.equal(server.inFlight, 1, 'the capped call never reached the controller');
    resolveSlow!({ permissionDecision: 'allow' });
    const done = await request(port, 'GET', `/v1/decision/${first.body.requestId}`, undefined, token);
    assert.equal(done.body.status, 'done');
    assert.equal(server.inFlight, 0);
    const third = await request(port, 'POST', '/v1/hook', envelope('Write'), token);
    assert.equal(third.body.decision.permissionDecision, 'deny', 'the slot was released');
  });

  test('stop removes the session file and releases the port', async () => {
    await server.stop();
    assert.equal(fs.existsSync(path.join(dir, `${process.pid}.json`)), false);
    await assert.rejects(request(port, 'GET', '/v1/health'));
    assert.equal(server.info, undefined);
  });

  test('refreshFolders rewrites the session file', () => {
    server.refreshFolders();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${process.pid}.json`), 'utf8')).folders, ['/ws']);
  });
});
