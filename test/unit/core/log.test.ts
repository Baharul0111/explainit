import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger, FileSink, redact } from '../../../src/core/log';

suite('core/log', () => {
  test('redact hides bearer tokens and token fields', () => {
    const tok = 'a'.repeat(64);
    assert.ok(!redact(`Authorization: Bearer ${tok}`).includes(tok));
    assert.ok(!redact(`{"token":"${tok}"}`).includes(tok));
    assert.strictEqual(redact('plain text'), 'plain text');
  });
  test('levels and scopes', () => {
    const lines: string[] = [];
    const log = createLogger([{ write: (l) => lines.push(l) }], 'root', 'info');
    log.debug('hidden');
    log.info('shown', { a: 1 });
    const child = log.child('gate');
    child.warn('w');
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].includes('[info] [root] shown {"a":1}'));
    assert.ok(lines[1].includes('[warn] [root:gate] w'));
    log.setLevel('error');
    child.warn('gone');
    assert.strictEqual(lines.length, 2);
  });
  test('file sink writes and rotates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-log-'));
    const file = path.join(dir, 'x.log');
    const sink = new FileSink(file, 200);
    for (let i = 0; i < 50; i++) sink.write('line ' + i + ' ' + 'x'.repeat(20));
    sink.dispose();
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(file + '.1'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('logging never throws when a sink throws', () => {
    const log = createLogger([{ write: () => { throw new Error('boom'); } }]);
    assert.doesNotThrow(() => log.error('x', new Error('e')));
  });
});
