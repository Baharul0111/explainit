/**
 * Loopback health probe for the gate (`GET http://127.0.0.1:<port>/v1/health`, no auth).
 * Only ever talks to 127.0.0.1. One attempt with a hard timeout; the caller decides about retries.
 */
import * as http from 'node:http';
import type { HealthProbeResult } from './doctorChecks';
import { jitter, sleep } from '../../core/cancel';

export function probeHealth(port: number, timeoutMs = 2000): Promise<HealthProbeResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: HealthProbeResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          if (chunks.reduce((n, b) => n + b.length, 0) < 64 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return finish({ ok: false, error: `HTTP ${res.statusCode}` });
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish({ ok: body?.ok === true, version: body?.version, paused: body?.paused === true, pid: typeof body?.pid === 'number' ? body.pid : undefined, error: body?.ok === true ? undefined : 'health answered ok=false' });
          } catch {
            finish({ ok: false, error: 'health answered with something that is not JSON' });
          }
        });
        res.on('error', (e) => finish({ ok: false, error: e.message }));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`no answer within ${timeoutMs} ms`));
    });
    req.on('error', (e) => finish({ ok: false, error: e.message }));
    req.end();
  });
}

/**
 * The doctor's variant: one attempt plus a single jittered retry when the first attempt fails
 * (a gate busy with a large review can miss one loopback connection without being broken).
 */
export async function probeHealthWithRetry(port: number, timeoutMs = 2000, retryBaseMs = 300, probe: (port: number, timeoutMs: number) => Promise<HealthProbeResult> = probeHealth): Promise<HealthProbeResult> {
  const first = await probe(port, timeoutMs);
  if (first.ok) return first;
  await sleep(jitter(retryBaseMs));
  const second = await probe(port, timeoutMs);
  return second.ok ? second : { ...second, error: second.error ?? first.error };
}
