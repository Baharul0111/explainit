import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createStateStore } from '../../../src/core/state';
import { createConsentStore } from '../../../src/generation/pure/consent';
import { rmDir, tmpDir } from './helpers';

suite('generation/pure/consent', () => {
  let dir: string;
  setup(() => {
    dir = tmpDir();
  });
  teardown(() => rmDir(dir));

  test('defaults to not granted; setGranted persists to state.json', async () => {
    const file = path.join(dir, 'state.json');
    const state = createStateStore(file);
    const consent = createConsentStore(state);
    assert.equal(consent.granted(), false);
    await consent.setGranted(true);
    assert.equal(consent.granted(), true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.consentGranted, true);
    assert.match(onDisk.consentAt, /^\d{4}-/);
    await consent.setGranted(false);
    assert.equal(consent.granted(), false);
    assert.equal(createConsentStore(createStateStore(file)).granted(), false);
  });

  test('a corrupt state file reads as not granted', () => {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{ nope');
    assert.equal(createConsentStore(createStateStore(file)).granted(), false);
  });
});
