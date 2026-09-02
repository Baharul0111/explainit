import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createFileCache } from '../../../src/generation/pure/cache';
import type { Explanation } from '../../../src/core/types';
import { rmDir, tmpDir } from './helpers';

const exp = (id: string): Explanation => ({ functionId: id, name: id, summary: `It does ${id}.`, steps: ['It starts the work.', 'It finishes the work.'], modelChannel: 'claude', createdAt: '2026-01-01T00:00:00.000Z', contentHash: id });

suite('generation/pure/cache', () => {
  let dir: string;
  setup(() => {
    dir = tmpDir();
  });
  teardown(() => rmDir(dir));

  test('set/get/has/size and a debounced flush that persists to disk', async () => {
    const file = path.join(dir, 'nested', 'cache.json');
    const cache = createFileCache(file, { debounceMs: 20 });
    assert.equal(cache.size(), 0);
    cache.set('h1', exp('a'));
    assert.ok(cache.has('h1'));
    assert.equal(cache.get('h1')?.summary, 'It does a.');
    assert.equal(cache.get('missing'), undefined);
    assert.ok(!fs.existsSync(file), 'not written synchronously');
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(fs.existsSync(file), 'written after the debounce');
    const again = createFileCache(file);
    assert.equal(again.size(), 1);
    assert.equal(again.get('h1')?.name, 'a');
  });

  test('flush() is awaitable and writes immediately', async () => {
    const file = path.join(dir, 'cache.json');
    const cache = createFileCache(file, { debounceMs: 10_000 });
    cache.set('h1', exp('a'));
    await cache.flush();
    assert.ok(fs.existsSync(file));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.entries.h1.name, 'a');
    await cache.flush(); // nothing dirty: no-op, no throw
  });

  test('LRU cap evicts the least recently used entry', async () => {
    const cache = createFileCache(path.join(dir, 'cache.json'), { maxEntries: 3, debounceMs: 10_000 });
    cache.set('a', exp('a'));
    cache.set('b', exp('b'));
    cache.set('c', exp('c'));
    cache.get('a'); // touch: a is now most recent
    cache.set('d', exp('d')); // evicts b
    assert.deepEqual(['a', 'b', 'c', 'd'].map((k) => cache.has(k)), [true, false, true, true]);
    assert.equal(cache.size(), 3);
  });

  test('tolerates a corrupt or oddly shaped file and starts empty', () => {
    const warnings: string[] = [];
    const file = path.join(dir, 'cache.json');
    fs.writeFileSync(file, '{ this is not json');
    const cache = createFileCache(file, { onWarning: (m) => warnings.push(m) });
    assert.equal(cache.size(), 0);
    assert.equal(warnings.length, 1);
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: { ok: exp('ok'), bad: { summary: 1 }, worse: 'x' } }));
    const cache2 = createFileCache(file);
    assert.equal(cache2.size(), 1);
    assert.ok(cache2.has('ok'));
    fs.writeFileSync(file, JSON.stringify([1, 2, 3]));
    assert.equal(createFileCache(file, { onWarning: (m) => warnings.push(m) }).size(), 0);
  });

  test('ignores junk writes and loads lazily', () => {
    const file = path.join(dir, 'cache.json');
    const cache = createFileCache(file);
    cache.set('', exp('a'));
    cache.set('x', { summary: 'no steps' } as unknown as Explanation);
    assert.equal(cache.size(), 0);
  });

  test('a file above the cap is trimmed on load', () => {
    const file = path.join(dir, 'cache.json');
    const entries: Record<string, Explanation> = {};
    for (let i = 0; i < 10; i++) entries[`h${i}`] = exp(`e${i}`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries }));
    const cache = createFileCache(file, { maxEntries: 4 });
    assert.equal(cache.size(), 4);
    assert.ok(cache.has('h9') && !cache.has('h0'));
  });
});
