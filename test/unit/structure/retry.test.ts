import * as assert from 'node:assert/strict';
import { CancelSource } from '../../../src/core/cancel';
import { READINESS_CAP_MS, READINESS_DELAYS_MS, withReadinessRetry } from '../../../src/structure/pure/retry';

/** Fake clock: sleeping advances time instantly; attempts can cost time too. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

suite('structure/pure/retry', () => {
  test('schedule is 100, 200, 400, 800, 1600 ms with a 5 s cap', () => {
    assert.deepEqual([...READINESS_DELAYS_MS], [100, 200, 400, 800, 1600]);
    assert.equal(READINESS_CAP_MS, 5000);
    assert.ok(READINESS_DELAYS_MS.reduce((a, b) => a + b, 0) < READINESS_CAP_MS);
  });

  test('returns immediately when the first answer is ready', async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await withReadinessRetry(
      async () => {
        calls++;
        return [1];
      },
      { isReady: (r) => r.length > 0, shouldRetry: true, now: clock.now, sleep: clock.sleep },
    );
    assert.equal(calls, 1);
    assert.equal(res.attempts, 1);
    assert.equal(res.gaveUp, false);
    assert.deepEqual(clock.sleeps, []);
  });

  test('walks the whole schedule when the provider never answers, then gives up', async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await withReadinessRetry(
      async () => {
        calls++;
        clock.advance(10);
        return undefined as number[] | undefined;
      },
      { isReady: (r) => !!r && r.length > 0, shouldRetry: true, now: clock.now, sleep: clock.sleep },
    );
    assert.equal(calls, 6);
    assert.equal(res.attempts, 6);
    assert.equal(res.gaveUp, true);
    assert.deepEqual(clock.sleeps, [100, 200, 400, 800, 1600]);
    assert.ok(res.elapsedMs <= READINESS_CAP_MS, `elapsed ${res.elapsedMs}`);
  });

  test('stops when the next wait would exceed the cap', async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await withReadinessRetry(
      async () => {
        calls++;
        return undefined;
      },
      { isReady: (r) => r !== undefined, shouldRetry: true, capMs: 1000, now: clock.now, sleep: clock.sleep },
    );
    // 100 + 200 + 400 = 700; the 800 ms wait would pass 1000 ms.
    assert.deepEqual(clock.sleeps, [100, 200, 400]);
    assert.equal(calls, 4);
    assert.ok(res.elapsedMs <= 1000);
  });

  test('slow attempts count against the cap', async () => {
    const clock = fakeClock();
    const res = await withReadinessRetry(
      async () => {
        clock.advance(2400);
        return undefined;
      },
      { isReady: (r) => r !== undefined, shouldRetry: true, now: clock.now, sleep: clock.sleep },
    );
    // 2400 + 100 + 2400 = 4900; the next 200 ms wait would pass 5000.
    assert.deepEqual(clock.sleeps, [100]);
    assert.equal(res.attempts, 2);
    assert.ok(res.elapsedMs <= READINESS_CAP_MS);
  });

  test('passes the remaining budget to each attempt', async () => {
    const clock = fakeClock();
    const budgets: number[] = [];
    await withReadinessRetry(
      async (remaining) => {
        budgets.push(remaining);
        return undefined;
      },
      { isReady: (r) => r !== undefined, shouldRetry: true, capMs: 1000, now: clock.now, sleep: clock.sleep },
    );
    assert.deepEqual(budgets, [1000, 900, 700, 300]);
  });

  test('single attempt when shouldRetry is false', async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await withReadinessRetry(
      async () => {
        calls++;
        return undefined;
      },
      { isReady: (r) => r !== undefined, shouldRetry: false, now: clock.now, sleep: clock.sleep },
    );
    assert.equal(calls, 1);
    assert.equal(res.gaveUp, true);
    assert.deepEqual(clock.sleeps, []);
  });

  test('a ready answer on a later attempt ends the loop', async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await withReadinessRetry(
      async () => {
        calls++;
        return calls === 3 ? ['ok'] : [];
      },
      { isReady: (r) => r.length > 0, shouldRetry: true, now: clock.now, sleep: clock.sleep },
    );
    assert.equal(res.attempts, 3);
    assert.deepEqual(res.result, ['ok']);
    assert.equal(res.gaveUp, false);
    assert.deepEqual(clock.sleeps, [100, 200]);
  });

  test('cancellation stops the retries', async () => {
    const clock = fakeClock();
    const src = new CancelSource();
    let calls = 0;
    const res = await withReadinessRetry(
      async () => {
        calls++;
        if (calls === 2) src.cancel();
        return undefined;
      },
      { isReady: (r) => r !== undefined, shouldRetry: true, now: clock.now, sleep: clock.sleep, token: src.token },
    );
    assert.equal(calls, 2);
    assert.equal(res.gaveUp, true);
  });
});
