import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeHealth, probeHealthWithRetry } from '../../../src/ux/pure/health';

/** A tiny loopback server whose handler the test swaps per case. */
function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

suite('ux/pure/health', () => {
  test('a healthy gate answers ok with version/paused/pid', async () => {
    const s = await serve((req, res) => {
      assert.equal(req.url, '/v1/health');
      assert.equal(req.method, 'GET');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.1.0', paused: false, pid: 77 }));
    });
    try {
      const r = await probeHealth(s.port, 2000);
      assert.deepEqual(r, { ok: true, version: '0.1.0', paused: false, pid: 77, error: undefined });
    } finally {
      await s.close();
    }
  });

  test('a closed port fails fast with a plain reason (no hang)', async () => {
    const s = await serve((_req, res) => res.end());
    await s.close();
    const started = Date.now();
    const r = await probeHealth(s.port, 2000);
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.length > 0);
    assert.ok(Date.now() - started < 2000);
  });

  test('a server that never answers is cut off by the timeout', async () => {
    const s = await serve(() => {
      /* never respond */
    });
    try {
      const started = Date.now();
      const r = await probeHealth(s.port, 200);
      assert.equal(r.ok, false);
      assert.ok(/no answer within 200 ms/.test(r.error ?? ''), r.error);
      assert.ok(Date.now() - started < 1500);
    } finally {
      await s.close();
    }
  });

  test('non-JSON, non-200 and ok=false bodies are all reported as not ok', async () => {
    let mode = 'garbage';
    const s = await serve((_req, res) => {
      if (mode === 'garbage') {
        res.end('<html>');
      } else if (mode === '500') {
        res.writeHead(500);
        res.end('{}');
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: false }));
      }
    });
    try {
      assert.ok((await probeHealth(s.port, 1000)).error?.includes('not JSON'));
      mode = '500';
      assert.equal((await probeHealth(s.port, 1000)).error, 'HTTP 500');
      mode = 'false';
      assert.equal((await probeHealth(s.port, 1000)).error, 'health answered ok=false');
    } finally {
      await s.close();
    }
  });

  test('a huge body is capped instead of buffered whole', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(200 * 1024, 0x20).toString() + '{"ok":true}');
    });
    try {
      const r = await probeHealth(s.port, 2000);
      assert.equal(r.ok, false, 'truncated body is not valid JSON and must not be trusted');
    } finally {
      await s.close();
    }
  });

  test('probeHealthWithRetry retries exactly once with a jittered delay', async () => {
    const seen: number[] = [];
    const flaky = async (): Promise<{ ok: boolean; error?: string }> => {
      seen.push(Date.now());
      return seen.length === 1 ? { ok: false, error: 'ECONNRESET' } : { ok: true, pid: 1 } as any;
    };
    const r = await probeHealthWithRetry(1, 100, 40, flaky);
    assert.equal(r.ok, true);
    assert.equal(seen.length, 2);
    assert.ok(seen[1] - seen[0] >= 15, 'the retry waits a jittered delay');
    const dead = async () => ({ ok: false, error: 'ECONNREFUSED' });
    const calls = { n: 0 };
    const r2 = await probeHealthWithRetry(1, 100, 10, async () => { calls.n++; return dead(); });
    assert.equal(r2.ok, false);
    assert.equal(calls.n, 2, 'never more than one retry');
    assert.equal(r2.error, 'ECONNREFUSED');
    const okFirst = await probeHealthWithRetry(1, 100, 10, async () => { calls.n++; return { ok: true }; });
    assert.equal(okFirst.ok, true);
    assert.equal(calls.n, 3, 'a healthy first answer needs no retry');
  });
});
