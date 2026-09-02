import * as assert from 'node:assert';
import { CancelSource, jitter, sleep, withTimeout } from '../../../src/core/cancel';
import { landedRecently, recordLanding } from '../../../src/core/landing';

suite('core/cancel + landing', () => {
  test('withTimeout rejects on timeout and resolves in time', async () => {
    await assert.rejects(withTimeout(sleep(200), 20, 'slow'), /timed out/);
    assert.strictEqual(await withTimeout(Promise.resolve(5), 100, 'fast'), 5);
  });
  test('cancel token rejects', async () => {
    const src = new CancelSource();
    const p = withTimeout(sleep(500), 1000, 'op', src.token);
    src.cancel();
    await assert.rejects(p, /cancelled/);
    assert.ok(src.token.isCancellationRequested);
  });
  test('jitter within bounds', () => {
    for (let i = 0; i < 50; i++) {
      const j = jitter(100);
      assert.ok(j >= 50 && j <= 150);
    }
  });
  test('landing registry', async () => {
    recordLanding('/a/b.py');
    assert.ok(landedRecently('/a/b.py', 1000));
    assert.ok(!landedRecently('/a/other.py', 1000));
    await sleep(15);
    assert.ok(!landedRecently('/a/b.py', 10));
  });
});
