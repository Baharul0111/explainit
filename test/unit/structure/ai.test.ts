import * as assert from 'node:assert/strict';
import type { AiSegment } from '../../../src/core/interfaces';
import { aiSegmentsToRaw } from '../../../src/structure/pure/ai';

suite('structure/pure/ai', () => {
  test('converts valid segments, clamps ranges and infers kind from a dotted name', () => {
    const segments: AiSegment[] = [
      { name: 'load', startLine: 0, endLine: 4 },
      { name: 'Server.start', startLine: 6, endLine: 40 },
    ];
    assert.deepEqual(aiSegmentsToRaw(segments, 10), [
      { name: 'load', kind: 'function', range: { startLine: 0, endLine: 4 } },
      { name: 'Server.start', kind: 'method', range: { startLine: 6, endLine: 9 } },
    ]);
  });

  test('drops nonsense from the model: empty names, non-numeric or inverted ranges, lines past the end', () => {
    const bad = [
      { name: '', startLine: 0, endLine: 1 },
      { name: 'x', startLine: 'a' as unknown as number, endLine: 1 },
      { name: 'y', startLine: 5, endLine: 2 },
      { name: 'z', startLine: 50, endLine: 60 },
      null as unknown as AiSegment,
      'text' as unknown as AiSegment,
    ];
    assert.deepEqual(aiSegmentsToRaw(bad, 10), []);
    assert.deepEqual(aiSegmentsToRaw(undefined, 10), []);
    assert.deepEqual(aiSegmentsToRaw([{ name: 'a', startLine: 0, endLine: 0 }], 0), []);
  });

  test('trims, collapses and caps names (model output is untrusted)', () => {
    const raws = aiSegmentsToRaw([{ name: '  spaced   name  ' + 'x'.repeat(300), startLine: 1.7, endLine: 3.2 }], 10);
    assert.equal(raws.length, 1);
    assert.ok(raws[0].name.startsWith('spaced name '));
    assert.ok(raws[0].name.length <= 120);
    assert.deepEqual(raws[0].range, { startLine: 1, endLine: 3 });
  });
});
