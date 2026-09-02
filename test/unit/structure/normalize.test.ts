import * as assert from 'node:assert/strict';
import { contentHashOf } from '../../../src/core/hash';
import {
  buildFunctionMap,
  cleanName,
  detectEol,
  emptyFunctionMap,
  expandToFullLines,
  functionText,
  isNonTrivialText,
  qualify,
  sliceLines,
  splitLines,
  textHashOf,
  type RawFunction,
} from '../../../src/structure/pure/normalize';

suite('structure/pure/normalize', () => {
  suite('splitLines / detectEol', () => {
    test('splits LF, CRLF and lone CR the same way', () => {
      assert.deepEqual(splitLines('a\nb\nc'), ['a', 'b', 'c']);
      assert.deepEqual(splitLines('a\r\nb\r\nc'), ['a', 'b', 'c']);
      assert.deepEqual(splitLines('a\rb\rc'), ['a', 'b', 'c']);
      assert.deepEqual(splitLines(''), ['']);
    });
    test('detects the line ending', () => {
      assert.equal(detectEol('a\nb'), '\n');
      assert.equal(detectEol('a\r\nb'), '\r\n');
      assert.equal(detectEol('no breaks'), '\n');
    });
  });

  suite('expandToFullLines', () => {
    test('keeps the start and end lines of a character range', () => {
      assert.deepEqual(expandToFullLines({ start: { line: 3, character: 7 }, end: { line: 9, character: 1 } }), { startLine: 3, endLine: 9 });
    });
    test('a range ending at column 0 of a later line stops on the previous line', () => {
      assert.deepEqual(expandToFullLines({ start: { line: 3, character: 0 }, end: { line: 10, character: 0 } }), { startLine: 3, endLine: 9 });
    });
    test('a single-line range ending at column 0 stays on its line', () => {
      assert.deepEqual(expandToFullLines({ start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }), { startLine: 4, endLine: 4 });
    });
    test('accepts line ranges and clamps into the document', () => {
      assert.deepEqual(expandToFullLines({ startLine: 2, endLine: 50 }, 10), { startLine: 2, endLine: 9 });
      assert.deepEqual(expandToFullLines({ startLine: -3, endLine: 1 }), { startLine: 0, endLine: 1 });
      assert.deepEqual(expandToFullLines({ startLine: 5, endLine: 2 }), { startLine: 5, endLine: 5 });
    });
  });

  suite('sliceLines / functionText', () => {
    const text = 'line0\nline1\nline2\nline3\n';
    test('returns the full lines joined with the text line ending', () => {
      assert.equal(sliceLines(text, { startLine: 1, endLine: 2 }), 'line1\nline2');
      const crlf = text.replace(/\n/g, '\r\n');
      assert.equal(sliceLines(crlf, { startLine: 1, endLine: 2 }), 'line1\r\nline2');
    });
    test('clamps out-of-range ends (the trailing empty line counts, as in VS Code)', () => {
      assert.equal(sliceLines(text, { startLine: 3, endLine: 99 }), 'line3\n');
      assert.equal(sliceLines('a\nb', { startLine: 1, endLine: 99 }), 'b');
    });
    test('functionText uses the record range', () => {
      assert.equal(functionText(text, { range: { startLine: 0, endLine: 1 } }), 'line0\nline1');
    });
  });

  suite('buildFunctionMap', () => {
    const text = ['def a():', '    pass', '', 'def a():', '    return 1', 'class C:', '    def m(self):', '        def inner():', '            pass', '        return inner'].join('\n');
    const raws: RawFunction[] = [
      { name: 'C.m.inner', kind: 'function', range: { startLine: 7, endLine: 8 } },
      { name: 'a', kind: 'function', range: { startLine: 3, endLine: 4 } },
      { name: 'a', kind: 'function', range: { startLine: 0, endLine: 1 } },
      { name: 'C.m', kind: 'method', range: { startLine: 6, endLine: 9 } },
    ];

    test('orders by position, outer before inner, and assigns 1-based ordinals to duplicate names', () => {
      const map = buildFunctionMap(text, 'python', 'file:///x.py', 'tree-sitter', raws);
      assert.deepEqual(
        map.functions.map((f) => f.id),
        ['a#1', 'a#2', 'C.m#1', 'C.m.inner#1'],
      );
      assert.equal(map.source, 'tree-sitter');
      assert.equal(map.languageId, 'python');
      assert.equal(map.fileUri, 'file:///x.py');
      assert.ok(map.functions.every((f) => f.languageId === 'python' && f.source === 'tree-sitter'));
      assert.equal(map.textHash, textHashOf(text));
    });

    test('hashes the full-line text of each function', () => {
      const map = buildFunctionMap(text, 'python', 'file:///x.py', 'symbols', raws);
      const a2 = map.functions.find((f) => f.id === 'a#2')!;
      assert.equal(a2.contentHash, contentHashOf('def a():\n    return 1'));
    });

    test('hashes and ranges are identical for CRLF and LF versions of the same file', () => {
      const lf = buildFunctionMap(text, 'python', 'file:///x.py', 'symbols', raws);
      const crlf = buildFunctionMap(text.replace(/\n/g, '\r\n'), 'python', 'file:///x.py', 'symbols', raws);
      assert.equal(lf.textHash, crlf.textHash);
      assert.deepEqual(
        lf.functions.map((f) => [f.id, f.contentHash, f.range]),
        crlf.functions.map((f) => [f.id, f.contentHash, f.range]),
      );
    });

    test('drops invalid ranges, duplicates and clamps overruns', () => {
      const map = buildFunctionMap(text, 'python', 'f', 'heuristic', [
        { name: 'x', kind: 'function', range: { startLine: 0, endLine: 1 } },
        { name: 'x', kind: 'function', range: { startLine: 0, endLine: 1 } },
        { name: 'beyond', kind: 'function', range: { startLine: 200, endLine: 300 } },
        { name: 'nan', kind: 'function', range: { startLine: NaN, endLine: 2 } },
        { name: 'long', kind: 'function', range: { startLine: 8, endLine: 500 } },
      ]);
      assert.deepEqual(
        map.functions.map((f) => [f.id, f.range.startLine, f.range.endLine]),
        [
          ['x#1', 0, 1],
          ['long#1', 8, 9],
        ],
      );
    });

    test('empty names become "anonymous" and # is not allowed inside names', () => {
      const map = buildFunctionMap('a\nb', 'x', 'f', 'ai', [
        { name: '  ', kind: 'function', range: { startLine: 0, endLine: 0 } },
        { name: 'we#ird', kind: 'function', range: { startLine: 1, endLine: 1 } },
      ]);
      assert.deepEqual(
        map.functions.map((f) => f.id),
        ['anonymous#1', 'we_ird#1'],
      );
    });

    test('emptyFunctionMap has no functions and the text hash', () => {
      const map = emptyFunctionMap('hello', 'plaintext', 'f');
      assert.equal(map.functions.length, 0);
      assert.equal(map.source, 'none');
      assert.equal(map.textHash, textHashOf('hello'));
    });
  });

  suite('small helpers', () => {
    test('cleanName and qualify', () => {
      assert.equal(cleanName(' a  b '), 'a b');
      assert.equal(cleanName(''), 'anonymous');
      assert.equal(qualify(undefined, 'f'), 'f');
      assert.equal(qualify('', 'f'), 'f');
      assert.equal(qualify('C', 'f'), 'C.f');
    });
    test('isNonTrivialText needs two non-blank lines and some length', () => {
      assert.equal(isNonTrivialText(''), false);
      assert.equal(isNonTrivialText('x = 1'), false);
      assert.equal(isNonTrivialText('a single long line of code without any breaks'), false);
      assert.equal(isNonTrivialText('def f():\n    return 1\n'), true);
    });
  });
});
