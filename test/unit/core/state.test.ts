import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createStateStore } from '../../../src/core/state';

suite('core/state', () => {
  test('fresh, update, corrupt file tolerated, serialised updates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-state-'));
    const file = path.join(dir, 'state.json');
    const store = createStateStore(file);
    assert.deepStrictEqual(store.read(), { version: 1 });
    await Promise.all([
      store.update((s) => { s.consentGranted = true; }),
      store.update((s) => { s.onboardingDone = true; }),
      store.update((s) => { s.adapters = { claude: { scriptHash: 'x' } }; }),
    ]);
    const s = store.read();
    assert.strictEqual(s.consentGranted, true);
    assert.strictEqual(s.onboardingDone, true);
    assert.strictEqual(s.adapters?.claude?.scriptHash, 'x');
    fs.writeFileSync(file, '{not json');
    assert.deepStrictEqual(store.read(), { version: 1 });
    await store.update((st) => { st.channelPin = 'claude'; });
    assert.strictEqual(store.read().channelPin, 'claude');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
