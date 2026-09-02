import * as assert from 'node:assert/strict';
import { applyUpdateChunks, extractPatchText, parsePatch, patchPaths, seekSequence, type PatchHunk } from '../../../src/gate/pure/applyPatch';

const wrap = (body: string): string => `*** Begin Patch\n${body}\n*** End Patch`;

function update(hunks: PatchHunk[], i = 0): Extract<PatchHunk, { kind: 'update' }> {
  const h = hunks[i];
  assert.equal(h.kind, 'update');
  return h as Extract<PatchHunk, { kind: 'update' }>;
}

suite('gate/pure/applyPatch: parsePatch', () => {
  test('rejects a patch without the begin marker', () => {
    const r = parsePatch('bad');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /Begin Patch/);
  });

  test('rejects a patch without the end marker', () => {
    const r = parsePatch('*** Begin Patch\n*** Add File: a\n+x');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /End Patch/);
  });

  test('an empty patch has no hunks', () => {
    const r = parsePatch('*** Begin Patch\n*** End Patch');
    assert.deepEqual(r, { ok: true, hunks: [] });
  });

  test('parses add, delete and update+move hunks (parser.rs fixture)', () => {
    const r = parsePatch(
      [
        '*** Begin Patch',
        '*** Add File: path/add.py',
        '+abc',
        '+def',
        '*** Delete File: path/delete.py',
        '*** Update File: path/update.py',
        '*** Move to: path/update2.py',
        '@@ def f():',
        '-    pass',
        '+    return 123',
        '*** End Patch',
      ].join('\n'),
    );
    assert.equal(r.ok, true);
    const hunks = (r as { hunks: PatchHunk[] }).hunks;
    assert.deepEqual(hunks[0], { kind: 'add', path: 'path/add.py', contents: 'abc\ndef\n' });
    assert.deepEqual(hunks[1], { kind: 'delete', path: 'path/delete.py' });
    const u = update(hunks, 2);
    assert.equal(u.path, 'path/update.py');
    assert.equal(u.moveTo, 'path/update2.py');
    assert.deepEqual(u.chunks, [{ changeContext: 'def f():', oldLines: ['    pass'], newLines: ['    return 123'], isEndOfFile: false }]);
    assert.deepEqual(patchPaths(hunks), ['path/add.py', 'path/delete.py', 'path/update.py', 'path/update2.py']);
  });

  test('an update hunk with no chunks is an error', () => {
    const r = parsePatch('*** Begin Patch\n*** Update File: test.py\n*** End Patch');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /is empty/);
  });

  test('add lines must start with +', () => {
    const r = parsePatch(wrap('*** Add File: a.txt\nnope'));
    assert.equal(r.ok, false);
  });

  test('context, removed, added and blank lines land in the right chunk lists', () => {
    const r = parsePatch(wrap('*** Update File: f.py\n@@\n ctx\n\n-old\n+new\n*** End of File'));
    const u = update((r as { hunks: PatchHunk[] }).hunks);
    assert.deepEqual(u.chunks, [{ oldLines: ['ctx', '', 'old'], newLines: ['ctx', '', 'new'], isEndOfFile: true }]);
  });

  test('multiple @@ chunks are kept in order', () => {
    const r = parsePatch(wrap('*** Update File: f.py\n@@ a\n-1\n+one\n@@ b\n-2\n+two'));
    const u = update((r as { hunks: PatchHunk[] }).hunks);
    assert.equal(u.chunks.length, 2);
    assert.equal(u.chunks[0].changeContext, 'a');
    assert.equal(u.chunks[1].changeContext, 'b');
  });

  test('after *** End of File only a new @@ chunk may follow', () => {
    const r = parsePatch(wrap('*** Update File: f.py\n@@\n-1\n+one\n*** End of File\n-2'));
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /@@ context marker/);
  });

  test('a stray line in an update hunk is an error', () => {
    const r = parsePatch(wrap('*** Update File: f.py\n@@\n-1\n+one\n?? what'));
    assert.equal(r.ok, false);
  });

  test('CRLF patches are accepted', () => {
    const r = parsePatch('*** Begin Patch\r\n*** Add File: a.txt\r\n+hi\r\n*** End Patch\r\n');
    assert.deepEqual(r, { ok: true, hunks: [{ kind: 'add', path: 'a.txt', contents: 'hi\n' }] });
  });
});

suite('gate/pure/applyPatch: extractPatchText', () => {
  const patch = '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch';
  test('from {patch} and {input}', () => {
    assert.equal(extractPatchText({ patch }), patch);
    assert.equal(extractPatchText({ input: patch }), patch);
  });
  test('from an argv array and a heredoc shell string', () => {
    assert.equal(extractPatchText({ command: ['apply_patch', patch] }), patch);
    assert.equal(extractPatchText({ command: `apply_patch <<'EOF'\n${patch}\nEOF\n` }), patch);
  });
  test('undefined when no patch text is present', () => {
    assert.equal(extractPatchText({ command: 'ls -la' }), undefined);
  });
});

suite('gate/pure/applyPatch: seekSequence', () => {
  test('exact, rstrip and trim matches (seek_sequence.rs tests)', () => {
    assert.equal(seekSequence(['foo', 'bar', 'baz'], ['bar', 'baz'], 0, false), 1);
    assert.equal(seekSequence(['foo   ', 'bar\t\t'], ['foo', 'bar'], 0, false), 0);
    assert.equal(seekSequence(['    foo   ', '   bar\t'], ['foo', 'bar'], 0, false), 0);
  });
  test('pattern longer than input -> undefined; empty pattern -> start', () => {
    assert.equal(seekSequence(['just one line'], ['too', 'many', 'lines'], 0, false), undefined);
    assert.equal(seekSequence(['a'], [], 3, false), 3);
  });
  test('unicode dashes and quotes match their ascii forms', () => {
    assert.equal(seekSequence(['x – y', '‘q’'], ['x - y', "'q'"], 0, false), 0);
  });
  test('eof searches from the end first', () => {
    assert.equal(seekSequence(['a', 'b', 'a', 'b'], ['a', 'b'], 0, true), 2);
  });
  test('search begins at start', () => {
    assert.equal(seekSequence(['a', 'b', 'a', 'b'], ['a'], 1, false), 2);
  });
});

suite('gate/pure/applyPatch: applyUpdateChunks', () => {
  const parseUpdate = (body: string): PatchChunkList => update((parsePatch(wrap(body)) as { hunks: PatchHunk[] }).hunks).chunks;
  type PatchChunkList = ReturnType<typeof update>['chunks'];

  test('replaces a block located by context', () => {
    const chunks = parseUpdate('*** Update File: f.py\n@@ def f():\n-    pass\n+    return 123');
    const r = applyUpdateChunks('import os\n\ndef f():\n    pass\n\ndef g():\n    pass\n', chunks);
    assert.deepEqual(r, { ok: true, after: 'import os\n\ndef f():\n    return 123\n\ndef g():\n    pass\n' });
  });

  test('multiple chunks apply sequentially with advancing indices (interleaved changes)', () => {
    const original = 'line1\nline2\nline3\nline4\nline5\nline6\n';
    const chunks = parseUpdate('*** Update File: f\n@@\n line1\n-line2\n+LINE2\n@@\n line4\n-line5\n+LINE5\n-line6\n+LINE6');
    const r = applyUpdateChunks(original, chunks);
    assert.deepEqual(r, { ok: true, after: 'line1\nLINE2\nline3\nline4\nLINE5\nLINE6\n' });
  });

  test('a pure addition chunk appends at the end of the file', () => {
    const chunks = parseUpdate('*** Update File: f\n@@\n+new last');
    const r = applyUpdateChunks('a\nb\n', chunks);
    assert.deepEqual(r, { ok: true, after: 'a\nb\nnew last\n' });
  });

  test('pure addition followed by a removal', () => {
    const chunks = parseUpdate('*** Update File: f\n@@\n+top\n@@\n-b');
    const r = applyUpdateChunks('a\nb\nc\n', chunks);
    assert.deepEqual(r, { ok: true, after: 'a\nc\ntop\n' });
  });

  test('*** End of File anchors the match at the end', () => {
    const chunks = parseUpdate('*** Update File: f\n@@\n-x\n+y\n*** End of File');
    const r = applyUpdateChunks('x\nmid\nx\n', chunks);
    assert.deepEqual(r, { ok: true, after: 'x\nmid\ny\n' });
  });

  test('fuzzy matching ignores indentation and trailing whitespace', () => {
    const chunks = parseUpdate('*** Update File: f\n@@\n-foo\n+bar');
    const r = applyUpdateChunks('    foo   \nrest\n', chunks);
    assert.deepEqual(r, { ok: true, after: 'bar\nrest\n' });
  });

  test('unicode dash in the file still matches an ascii patch line (test_update_line_with_unicode_dash)', () => {
    const chunks = parseUpdate('*** Update File: f\n@@\n-import foo - bar\n+import foo');
    const r = applyUpdateChunks('import foo – bar\nx\n', chunks);
    assert.deepEqual(r, { ok: true, after: 'import foo\nx\n' });
  });

  test('a trailing empty old line is retried without it', () => {
    // wrap() leaves a blank line before '*** End Patch', which the parser keeps as an empty
    // context line: the classic "final newline" sentinel that is not present in the file's lines.
    const chunks = parseUpdate('*** Update File: f\n@@\n-last\n+LAST\n');
    assert.deepEqual(chunks[0].oldLines, ['last', '']);
    const r = applyUpdateChunks('first\nlast\n', chunks);
    assert.deepEqual(r, { ok: true, after: 'first\nLAST\n' });
  });

  test('missing context is an error', () => {
    const chunks = parseUpdate('*** Update File: f\n@@ def nope():\n-a\n+b');
    const r = applyUpdateChunks('a\n', chunks, 'f');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /Failed to find context 'def nope\(\):' in f/);
  });

  test('missing old lines is an error', () => {
    const chunks = parseUpdate('*** Update File: f\n@@\n-zzz\n+b');
    const r = applyUpdateChunks('a\n', chunks, 'f');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /Failed to find expected lines in f/);
  });

  test('result always ends with a newline, even for an empty original', () => {
    const chunks = parseUpdate('*** Update File: f\n@@\n+only');
    assert.deepEqual(applyUpdateChunks('', chunks), { ok: true, after: 'only\n' });
  });
});
