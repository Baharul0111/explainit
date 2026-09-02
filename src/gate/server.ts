/**
 * Loopback HTTP endpoint for the hook script (REQ-013, CONTRACTS "Gate HTTP protocol").
 * 127.0.0.1 only, random port, per-session bearer token, 8 MB body cap, JSON only.
 */
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Disposable, GateSessionInfo, HookEnvelope } from '../core/interfaces';
import type { HookDecision } from '../core/types';
import type { Logger } from '../core/log';
import { randomToken, randomId } from '../core/hash';
import { HOME_LAYOUT } from '../core/paths';
import { IngressValidationError } from './controller';
import { purgeDeadSessions, removeSessionFile, writeSessionFile } from './pure/sessionFile';

export const BODY_LIMIT = 8 * 1024 * 1024;
export const LONG_POLL_MS = 25_000;
/** How long POST /v1/hook waits for a fast-path answer before switching to 202 + long-poll. */
export const FAST_PATH_MS = 1_500;
/** Finished decisions are kept this long for late polls. */
const DONE_TTL_MS = 10 * 60_000;

interface Pending {
  promise: Promise<HookDecision>;
  decision?: HookDecision;
  error?: Error;
  createdAt: number;
  doneAt?: number;
  waiters: Set<() => void>;
}

export interface ServerDeps {
  logger: Logger;
  version: string;
  folders: () => string[];
  paused: () => boolean;
  handle: (envelope: HookEnvelope, requestId: string) => Promise<HookDecision>;
  disposables: Disposable[];
  sessionsDir?: () => string;
  /** Test seams: shorten the long-poll and fast-path windows. */
  longPollMs?: number;
  fastPathMs?: number;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string; drop?: boolean }> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) {
      req.resume();
      resolve({ ok: false, status: 413, error: `The request body is larger than ${limit / 1024 / 1024} MB.` });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        // Stop buffering; the caller answers 413 first and then drops the connection.
        req.pause();
        resolve({ ok: false, status: 413, error: `The request body is larger than ${limit / 1024 / 1024} MB.`, drop: true });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      resolve({ ok: false, status: 400, error: `The request body could not be read: ${e.message}` });
    });
  });
}

export class GateHttpServer {
  private server: http.Server | undefined;
  private token = '';
  private _info: GateSessionInfo | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly log: Logger;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly deps: ServerDeps) {
    this.log = deps.logger.child('gate:http');
    deps.disposables.push({ dispose: () => void this.stop() });
  }

  get info(): GateSessionInfo | undefined {
    return this._info;
  }

  private sessionsDir(): string {
    return this.deps.sessionsDir ? this.deps.sessionsDir() : HOME_LAYOUT.sessions();
  }

  async start(): Promise<GateSessionInfo> {
    if (this._info) return this._info;
    const dir = this.sessionsDir();
    const removed = purgeDeadSessions(dir);
    if (removed.length) this.log.info(`removed ${removed.length} stale session file(s)`);
    this.token = randomToken();
    const server = http.createServer((req, res) => void this.onRequest(req, res));
    server.keepAliveTimeout = 30_000;
    server.headersTimeout = 35_000;
    server.requestTimeout = 60_000;
    server.on('error', (e) => this.log.error('http server error', e));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const port = (server.address() as AddressInfo).port;
    this._info = {
      pid: process.pid,
      port,
      token: this.token,
      folders: this.deps.folders(),
      startedAt: new Date().toISOString(),
      version: this.deps.version,
    };
    writeSessionFile(dir, this._info);
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
    this.log.info(`listening on 127.0.0.1:${port} (pid ${process.pid})`);
    return this._info;
  }

  /** Keep the session file's folder list current (workspace folders can change). */
  refreshFolders(): void {
    if (!this._info) return;
    this._info = { ...this._info, folders: this.deps.folders() };
    try {
      writeSessionFile(this.sessionsDir(), this._info);
    } catch (e) {
      this.log.warn('could not rewrite the session file', e);
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    if (this._info) removeSessionFile(this.sessionsDir(), this._info.pid);
    this._info = undefined;
    for (const p of this.pending.values()) for (const w of p.waiters) w();
    this.pending.clear();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      this.log.info('stopped');
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.doneAt && now - p.doneAt > DONE_TTL_MS) this.pending.delete(id);
  }

  private authorized(req: http.IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+([A-Za-z0-9]+)\s*$/.exec(h);
    if (!m || !this.token) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        send(res, 200, { ok: true, version: this.deps.version, paused: this.deps.paused(), pid: process.pid });
        return;
      }
      if (!this.authorized(req)) {
        send(res, 401, { error: 'Missing or wrong ExplainIT session token. Restart the assistant so its hook re-reads the session file.' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/hook') {
        await this.onHook(req, res);
        return;
      }
      const m = /^\/v1\/decision\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        await this.onDecision(m[1], res);
        return;
      }
      send(res, 404, { error: 'Unknown route.' });
    } catch (e) {
      this.log.error('request failed', e);
      if (!res.headersSent) send(res, 500, { error: `ExplainIT could not handle the request: ${(e as Error).message}` });
    }
  }

  private async onHook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req, BODY_LIMIT);
    if (!body.ok) {
      if (body.drop) res.once('finish', () => req.destroy());
      send(res, body.status, { error: body.error });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      send(res, 400, { error: 'The request body is not valid JSON.' });
      return;
    }
    const requestId = randomId('req-');
    const entry: Pending = { promise: undefined as unknown as Promise<HookDecision>, createdAt: Date.now(), waiters: new Set() };
    entry.promise = this.deps.handle(parsed as HookEnvelope, requestId).then(
      (d) => {
        entry.decision = d;
        entry.doneAt = Date.now();
        for (const w of entry.waiters) w();
        return d;
      },
      (e: Error) => {
        entry.error = e;
        entry.doneAt = Date.now();
        for (const w of entry.waiters) w();
        throw e;
      },
    );
    entry.promise.catch(() => undefined);
    this.pending.set(requestId, entry);

    // Fast path: most calls (none / protected / memory hits) resolve in milliseconds.
    await this.waitFor(entry, this.deps.fastPathMs ?? FAST_PATH_MS);
    if (entry.error) {
      this.pending.delete(requestId);
      const status = entry.error instanceof IngressValidationError ? 400 : 500;
      send(res, status, { error: entry.error.message });
      return;
    }
    if (entry.decision) {
      send(res, 200, { decision: entry.decision });
      return;
    }
    send(res, 202, { requestId });
  }

  private async onDecision(id: string, res: http.ServerResponse): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) {
      send(res, 404, { error: 'Unknown request id (it may have expired). Send the hook event again.' });
      return;
    }
    if (!entry.decision && !entry.error) await this.waitFor(entry, this.deps.longPollMs ?? LONG_POLL_MS);
    if (entry.error) {
      send(res, 500, { error: entry.error.message });
      return;
    }
    if (entry.decision) {
      send(res, 200, { status: 'done', decision: entry.decision });
      return;
    }
    send(res, 200, { status: 'pending', heartbeat: new Date().toISOString() });
  }

  private waitFor(entry: Pending, ms: number): Promise<void> {
    if (entry.decision || entry.error) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        entry.waiters.delete(done);
        resolve();
      }, ms);
      const done = (): void => {
        clearTimeout(timer);
        entry.waiters.delete(done);
        resolve();
      };
      entry.waiters.add(done);
    });
  }

  /** For tests: number of requests still being decided. */
  get inFlight(): number {
    let n = 0;
    for (const p of this.pending.values()) if (!p.doneAt) n++;
    return n;
  }
}
