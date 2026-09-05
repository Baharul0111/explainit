import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProjectConsent } from '../../../src/core/projectConsent';
import { createStateStore } from '../../../src/core/state';

suite('core/projectConsent (ask once per project)', () => {
  let dir: string;
  let folderA: string;
  let folderB: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-project-consent-'));
    folderA = path.join(dir, 'a');
    folderB = path.join(dir, 'b');
    fs.mkdirSync(folderA);
    fs.mkdirSync(folderB);
  });
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a project starts unknown, remembers the answer, and other projects are unaffected', async () => {
    const store = createStateStore(path.join(dir, 'state.json'));
    const consent = createProjectConsent(store);
    assert.strictEqual(consent.status(folderA), 'unknown');
    await consent.set(folderA, 'denied');
    assert.strictEqual(consent.status(folderA), 'denied');
    assert.strictEqual(consent.status(folderB), 'unknown');
    await consent.set(folderB, 'allowed');
    assert.strictEqual(consent.status(folderB), 'allowed');
    // A fresh store over the same file sees the same decisions (they survive restarts).
    const again = createProjectConsent(createStateStore(path.join(dir, 'state.json')));
    assert.strictEqual(again.status(folderA), 'denied');
    assert.strictEqual(again.status(folderB), 'allowed');
  });

  test('clear() forgets a decision and listeners hear every change', async () => {
    const consent = createProjectConsent(createStateStore(path.join(dir, 'state.json')));
    const seen: string[] = [];
    const sub = consent.onDidChange((e) => seen.push(`${path.basename(e.folder)}:${e.decision}`));
    await consent.set(folderA, 'allowed');
    await consent.clear(folderA);
    sub.dispose();
    await consent.set(folderA, 'denied');
    assert.deepStrictEqual(seen, ['a:allowed', 'a:unknown']);
    assert.strictEqual(consent.status(folderA), 'denied');
  });

  test('folderFor finds the workspace folder that holds a file, with trailing separators and nesting', () => {
    const consent = createProjectConsent(createStateStore(path.join(dir, 'state.json')));
    const folders = [folderA + path.sep, folderB];
    assert.strictEqual(consent.folderFor(path.join(folderA, 'src', 'app.py'), folders), fs.realpathSync.native(folderA).replace(/^([a-zA-Z]):/, (_m, d: string) => d.toLowerCase() + ':'));
    assert.strictEqual(consent.folderFor(path.join(dir, 'elsewhere.py'), folders), undefined);
  });
});
