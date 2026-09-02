import * as assert from 'node:assert';
import type { FunctionMap, FunctionRecord } from '../../../src/core/types';
import { contentHashOf } from '../../../src/core/hash';
import { diffFunctionMaps, functionText, lensTitle, shouldWatchPath } from '../../../src/adapters/pure/copilotDiff';

function mapFor(text: string, fns: { name: string; start: number; end: number }[]): FunctionMap {
  const lines = text.split('\n');
  const functions: FunctionRecord[] = fns.map((f, i) => ({
    id: `${f.name}#${i}`,
    name: f.name,
    kind: 'function',
    range: { startLine: f.start, endLine: f.end },
    contentHash: contentHashOf(lines.slice(f.start, f.end + 1).join('\n')),
    languageId: 'python',
    source: 'tree-sitter',
  }));
  return { fileUri: 'file:///x.py', languageId: 'python', functions, source: 'tree-sitter', textHash: contentHashOf(text) };
}

const BEFORE = ['def a():', '    return 1', '', 'def b():', '    return 2', ''].join('\n');
const AFTER = ['def a():', '    return 1', '', 'def b():', '    return 22', '', 'def c():', '    return 3', ''].join('\n');

suite('adapters/pure/copilotDiff', () => {
  test('functionText extracts full lines and clamps ranges', () => {
    assert.strictEqual(functionText(BEFORE, { range: { startLine: 3, endLine: 4 } }), 'def b():\n    return 2');
    assert.strictEqual(functionText('a\r\nb', { range: { startLine: 0, endLine: 5 } }), 'a\nb');
    assert.strictEqual(functionText('a', { range: { startLine: 3, endLine: 2 } }), '');
  });

  test('diffFunctionMaps reports modified and added functions with current lines', () => {
    const before = mapFor(BEFORE, [{ name: 'a', start: 0, end: 1 }, { name: 'b', start: 3, end: 4 }]);
    const after = mapFor(AFTER, [{ name: 'a', start: 0, end: 1 }, { name: 'b', start: 3, end: 4 }, { name: 'c', start: 6, end: 7 }]);
    const changes = diffFunctionMaps(before, BEFORE, after, AFTER);
    assert.deepStrictEqual(changes.map((c) => [c.name, c.changeType, c.line]), [['b', 'modified', 3], ['c', 'added', 6]]);
    assert.strictEqual(changes[0].beforeText, 'def b():\n    return 2');
    assert.strictEqual(changes[0].afterText, 'def b():\n    return 22');
    assert.strictEqual(changes[1].beforeText, '');
  });

  test('diffFunctionMaps reports removed functions last, without a line', () => {
    const before = mapFor(AFTER, [{ name: 'a', start: 0, end: 1 }, { name: 'b', start: 3, end: 4 }, { name: 'c', start: 6, end: 7 }]);
    const after = mapFor(BEFORE, [{ name: 'a', start: 0, end: 1 }, { name: 'b', start: 3, end: 4 }]);
    const changes = diffFunctionMaps(before, AFTER, after, BEFORE);
    assert.deepStrictEqual(changes.map((c) => [c.name, c.changeType, c.line]), [['b', 'modified', 3], ['c', 'removed', undefined]]);
  });

  test('moved but unchanged functions are not changes', () => {
    const moved = ['def b():', '    return 2', '', 'def a():', '    return 1', ''].join('\n');
    const before = mapFor(BEFORE, [{ name: 'a', start: 0, end: 1 }, { name: 'b', start: 3, end: 4 }]);
    const after = mapFor(moved, [{ name: 'b', start: 0, end: 1 }, { name: 'a', start: 3, end: 4 }]);
    assert.deepStrictEqual(diffFunctionMaps(before, BEFORE, after, moved), []);
  });

  test('duplicate names are paired by order', () => {
    const t1 = ['def f():', '    return 1', '', 'def f():', '    return 2', ''].join('\n');
    const t2 = ['def f():', '    return 1', '', 'def f():', '    return 3', ''].join('\n');
    const before = mapFor(t1, [{ name: 'f', start: 0, end: 1 }, { name: 'f', start: 3, end: 4 }]);
    const after = mapFor(t2, [{ name: 'f', start: 0, end: 1 }, { name: 'f', start: 3, end: 4 }]);
    const changes = diffFunctionMaps(before, t1, after, t2);
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].line, 3);
  });

  test('lensTitle covers pending, streaming, done, error and truncation', () => {
    assert.strictEqual(lensTitle({ name: 'greet', changeType: 'modified', status: 'pending' }), 'ExplainIT: what changed — greet (modified) · explaining…');
    assert.strictEqual(lensTitle({ name: 'greet', changeType: 'added', status: 'streaming', summary: 'It now says\n hi' }), 'ExplainIT: what changed — It now says hi…');
    assert.strictEqual(lensTitle({ name: 'greet', changeType: 'modified', status: 'done', summary: 'It returns Hi.' }), 'ExplainIT: what changed — It returns Hi.');
    assert.strictEqual(lensTitle({ name: 'greet', changeType: 'modified', status: 'done', summary: '' }), 'ExplainIT: what changed — greet (modified)');
    assert.strictEqual(lensTitle({ name: 'greet', changeType: 'removed', status: 'error', error: 'no assistant' }), 'ExplainIT: what changed — greet (removed) · no assistant');
    const long = lensTitle({ name: 'x', changeType: 'modified', status: 'done', summary: 'a'.repeat(200) });
    assert.ok(long.length <= 'ExplainIT: what changed — '.length + 90);
    assert.ok(long.endsWith('…'));
  });

  test('shouldWatchPath skips twins and build folders', () => {
    const isTwin = (p: string): boolean => p.endsWith('_explain.txt');
    assert.ok(shouldWatchPath('/w/src/app.py', isTwin));
    assert.ok(!shouldWatchPath('/w/src/app_explain.txt', isTwin));
    assert.ok(!shouldWatchPath('/w/node_modules/x/index.js', isTwin));
    assert.ok(!shouldWatchPath('C:\\w\\.git\\config', isTwin));
  });
});
