/**
 * Test helpers shared by the hook conformance and real-agent suites: a stub ExplainIT gate on
 * 127.0.0.1 with a bearer token, session-file writing, and a runner for the hook script.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

export interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
  at: number;
}

export type StubHandler = (req: Recorded, res: http.ServerResponse) => void;

export interface StubGate {
  port: number;
  token: string;
  requests: Recorded[];
  handler: StubHandler;
  close(): Promise<void>;
}

export const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Handler that answers PreToolUse with 200 {decision} and PostToolUse with 200 none. */
export function decideWith(decision: { permissionDecision: string; reason?: string }): StubHandler {
  return (req, res) => json(res, 200, { decision });
}

/** Handler that answers 202 and completes the long-poll with `decision` after `afterMs`. */
export function longPollThen(decision: { permissionDecision: string; reason?: string }, afterMs: number, pendingRounds = 0): StubHandler {
  let polls = 0;
  return (req, res) => {
    if (req.method === 'POST') return json(res, 202, { requestId: 'req-1' });
    if (req.method === 'GET' && req.url.startsWith('/v1/decision/req-1')) {
      polls++;
      if (polls <= pendingRounds) return void setTimeout(() => json(res, 200, { status: 'pending', heartbeat: new Date().toISOString() }), afterMs);
      return void setTimeout(() => json(res, 200, { status: 'done', decision }), afterMs);
    }
    json(res, 404, { error: 'not found' });
  };
}

export function startStub(): Promise<StubGate> {
  const token = randomBytes(32).toString('hex');
  const requests: Recorded[] = [];
  const stub: Partial<StubGate> = { token, requests, handler: decideWith({ permissionDecision: 'allow' }) };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: any = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      } catch {
        body = null;
      }
      const rec: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, at: Date.now() };
      requests.push(rec);
      if (rec.url === '/v1/health') return json(res, 200, { ok: true, version: 'stub', paused: false, pid: process.pid });
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'bad token' });
      stub.handler!(rec, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        token,
        requests,
        get handler() {
          return stub.handler!;
        },
        set handler(h: StubHandler) {
          stub.handler = h;
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Writes <home>/sessions/<pid>.json the way the real gate does. */
export function writeSession(home: string, stub: { port: number; token: string }, folders: string[], pid = process.pid): string {
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid, port: stub.port, token: stub.token, folders, startedAt: new Date().toISOString(), version: 'test' }), { mode: 0o600 });
  return file;
}

export interface HookRun {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}

export const HOOK_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'hooks', 'explainit-hook.js');

export function runHook(args: string[], stdin: string | Buffer, env: Record<string, string | undefined>, scriptPath = HOOK_SCRIPT): Promise<HookRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [scriptPath, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('close', (code) => resolve({ stdout, stderr, code, ms: Date.now() - started }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}
