import * as assert from 'node:assert';
import { chunk, createBackfillRecord, describeEstimate, doneFunctionCount, formatTokens, isComplete, markFileDone, parseBackfillRecord, remainingFiles, serializeBackfillRecord, statusFromRecords, totalFunctionCount } from '../../../src/twin/pure/backfillState';

suite('twin/pure/backfillState', () => {
  const files = [
    { path: '/w/a.py', functions: 3 },
    { path: '/w/b.py', functions: 0 },
    { path: '/w/c.py', functions: 25 },
  ];
  const estimate = { functions: 28, files: 3, requests: 3, inputTokens: 4000, outputTokens: 3360, channel: 'claude' as const };

  test('create, mark done, remaining, counts', () => {
    const r0 = createBackfillRecord('/w', files, estimate, new Date('2026-01-02T03:04:05Z'));
    assert.strictEqual(r0.startedAt, '2026-01-02T03:04:05.000Z');
    assert.deepStrictEqual(remainingFiles(r0).map((f) => f.path), ['/w/a.py', '/w/b.py', '/w/c.py']);
    assert.strictEqual(totalFunctionCount(r0), 28);
    assert.strictEqual(doneFunctionCount(r0), 0);
    const r1 = markFileDone(r0, '/w/c.py', new Date('2026-01-02T03:05:00Z'));
    assert.deepStrictEqual(r0.done, [], 'immutable');
    assert.deepStrictEqual(r1.done, ['/w/c.py']);
    assert.strictEqual(r1.updatedAt, '2026-01-02T03:05:00.000Z');
    assert.strictEqual(doneFunctionCount(r1), 25);
    assert.strictEqual(markFileDone(r1, '/w/c.py'), r1, 'idempotent');
    assert.ok(!isComplete(r1));
    const r3 = markFileDone(markFileDone(r1, '/w/a.py'), '/w/b.py');
    assert.ok(isComplete(r3));
    assert.deepStrictEqual(remainingFiles(r3), []);
  });

  test('serialize/parse round trip and strict validation', () => {
    const r = markFileDone(createBackfillRecord('/w', files, estimate), '/w/a.py');
    const parsed = parseBackfillRecord(serializeBackfillRecord(r));
    assert.deepStrictEqual(parsed, r);
    assert.strictEqual(parseBackfillRecord('nope'), undefined);
    assert.strictEqual(parseBackfillRecord('{"version":2}'), undefined);
    assert.strictEqual(parseBackfillRecord('{"version":1,"folder":"/w","files":[{"path":1}],"done":[]}'), undefined);
    assert.strictEqual(parseBackfillRecord('{"version":1,"folder":"/w","files":[],"done":[3]}'), undefined);
    const minimal = parseBackfillRecord('{"version":1,"folder":"/w","files":[],"done":[]}');
    assert.ok(minimal);
    assert.strictEqual(minimal!.estimate, undefined);
    assert.ok(isComplete(minimal!));
  });

  test('chunk respects the cap (<= 20 per request)', () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    const c = chunk(items, 20);
    assert.deepStrictEqual(c.map((x) => x.length), [20, 20, 5]);
    assert.deepStrictEqual(chunk([], 20), []);
    assert.deepStrictEqual(chunk([1, 2], 0).map((x) => x.length), [1, 1], 'size below 1 is treated as 1');
    assert.deepStrictEqual(chunk([1, 2, 3], 2.9).map((x) => x.length), [2, 1]);
  });

  test('status projection across folders', () => {
    const a = markFileDone(createBackfillRecord('/a', files, estimate), '/w/a.py');
    const b = createBackfillRecord('/b', [{ path: '/b/x.go', functions: 2 }]);
    const s = statusFromRecords('running', [a, b], { currentFile: '/w/b.py' });
    assert.deepStrictEqual(s, { state: 'running', totalFiles: 4, doneFiles: 1, totalFunctions: 30, doneFunctions: 3, currentFile: '/w/b.py', estimate });
    assert.deepStrictEqual(statusFromRecords('idle', []), { state: 'idle', totalFiles: 0, doneFiles: 0, totalFunctions: 0, doneFunctions: 0 });
    assert.strictEqual(statusFromRecords('error', [], { error: 'boom' }).error, 'boom');
  });

  test('estimate wording', () => {
    assert.strictEqual(describeEstimate(estimate), '28 functions in 3 files, about 3 requests and roughly 7k tokens, using Claude Code.');
    assert.strictEqual(describeEstimate({ ...estimate, functions: 1, files: 1, requests: 1, inputTokens: 100, outputTokens: 120, channel: 'copilot' }), '1 function in 1 file, about 1 request and roughly 220 tokens, using Copilot.');
    assert.strictEqual(describeEstimate({ ...estimate, channel: 'none' }).endsWith('using no assistant.'), true);
    assert.strictEqual(formatTokens(2_500_000), '2.5M');
    assert.strictEqual(formatTokens(999), '999');
  });
});
