import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { applyEdit, applyEdits, buildClaudeWrites, buildPatchWrites, proposalSize, type ProposalIo } from '../../../src/gate/pure/proposals';

function io(files: Record<string, string>): ProposalIo {
  return {
    readFile: (p) => (p in files ? files[p] : null),
    resolve: (raw) => (path.isAbsolute(raw) ? raw : path.join('/ws', raw)),
  };
}

suite('gate/pure/proposals: applyEdit', () => {
  test('replaces a unique old_string', () => {
    assert.deepEqual(applyEdit('a = 1\nb = 2\n', { old_string: 'b = 2', new_string: 'b = 3' }), { ok: true, after: 'a = 1\nb = 3\n' });
  });
  test('not found -> error marker', () => {
    const r = applyEdit('a = 1\n', { old_string: 'zzz', new_string: 'y' });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /not found/);
  });
  test('non-unique without replace_all -> error', () => {
    const r = applyEdit('x\nx\n', { old_string: 'x', new_string: 'y' });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /appears 2 times/);
  });
  test('replace_all replaces every occurrence', () => {
    assert.deepEqual(applyEdit('x\nx\nx\n', { old_string: 'x', new_string: 'y', replace_all: true }), { ok: true, after: 'y\ny\ny\n' });
  });
  test('special replacement patterns in new_string are literal', () => {
    assert.deepEqual(applyEdit('a\n', { old_string: 'a', new_string: '$& $1' }), { ok: true, after: '$& $1\n' });
  });
  test('empty old_string only works on an empty file', () => {
    assert.deepEqual(applyEdit('', { old_string: '', new_string: 'new' }), { ok: true, after: 'new' });
    assert.equal(applyEdit('x', { old_string: '', new_string: 'new' }).ok, false);
  });
  test('CRLF file with LF old_string: matched on normalised text and CRLF restored', () => {
    const r = applyEdit('a\r\nb\r\nc\r\n', { old_string: 'a\nb', new_string: 'A\nB' });
    assert.deepEqual(r, { ok: true, after: 'A\r\nB\r\nc\r\n' });
  });
});

suite('gate/pure/proposals: applyEdits (MultiEdit)', () => {
  test('applies sequentially', () => {
    const r = applyEdits('a\nb\n', [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'b', new_string: 'c', replace_all: true },
    ]);
    assert.deepEqual(r, { ok: true, after: 'c\nc\n' });
  });
  test('reports which edit failed', () => {
    const r = applyEdits('a\n', [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'zzz', new_string: 'c' },
    ]);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /edit 2 of 2/);
  });
});

suite('gate/pure/proposals: buildClaudeWrites', () => {
  test('Write on a new file -> create with before null', () => {
    const r = buildClaudeWrites('Write', { file_path: 'src/new.py', content: 'x = 1\n' }, io({}));
    assert.deepEqual(r, { ok: true, writes: [{ kind: 'create', path: path.join('/ws', 'src/new.py'), before: null, after: 'x = 1\n' }] });
  });
  test('Write on an existing file -> modify', () => {
    const p = path.join('/ws', 'a.py');
    const r = buildClaudeWrites('Write', { file_path: p, content: 'new\n' }, io({ [p]: 'old\n' }));
    assert.deepEqual(r, { ok: true, writes: [{ kind: 'modify', path: p, before: 'old\n', after: 'new\n' }] });
  });
  test('Edit applies old_string -> new_string', () => {
    const p = path.join('/ws', 'a.py');
    const r = buildClaudeWrites('Edit', { file_path: p, old_string: 'old', new_string: 'new' }, io({ [p]: 'old\n' }));
    assert.deepEqual(r, { ok: true, writes: [{ kind: 'modify', path: p, before: 'old\n', after: 'new\n' }] });
  });
  test('Edit with old_string not found -> not-found marker (tool fails itself)', () => {
    const p = path.join('/ws', 'a.py');
    const r = buildClaudeWrites('Edit', { file_path: p, old_string: 'nope', new_string: 'new' }, io({ [p]: 'old\n' }));
    assert.equal(r.ok, false);
    assert.equal((r as { kind: string }).kind, 'not-found');
  });
  test('Edit on a missing file -> not-found', () => {
    const r = buildClaudeWrites('Edit', { file_path: '/ws/missing.py', old_string: 'a', new_string: 'b' }, io({}));
    assert.equal(r.ok, false);
  });
  test('MultiEdit sequential', () => {
    const p = path.join('/ws', 'a.py');
    const r = buildClaudeWrites('MultiEdit', { file_path: p, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c' }] }, io({ [p]: 'a\n' }));
    assert.deepEqual(r, { ok: true, writes: [{ kind: 'modify', path: p, before: 'a\n', after: 'c\n' }] });
  });
  test('unsupported tool -> invalid', () => {
    assert.equal(buildClaudeWrites('Nope', { file_path: 'x' }, io({})).ok, false);
  });
});

suite('gate/pure/proposals: buildPatchWrites', () => {
  const p = (rel: string): string => path.join('/ws', rel);
  test('add, update, delete and move become one write each', () => {
    const files = { [p('u.py')]: 'def f():\n    pass\n', [p('d.py')]: 'gone\n', [p('m.py')]: 'a\n' };
    const patch = [
      '*** Begin Patch',
      '*** Add File: n.py',
      '+print(1)',
      '*** Update File: u.py',
      '@@ def f():',
      '-    pass',
      '+    return 1',
      '*** Delete File: d.py',
      '*** Update File: m.py',
      '*** Move to: m2.py',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n');
    const r = buildPatchWrites({ command: ['apply_patch', patch] }, io(files));
    assert.equal(r.ok, true);
    const writes = (r as { writes: unknown[] }).writes;
    assert.deepEqual(writes, [
      { kind: 'create', path: p('n.py'), before: null, after: 'print(1)\n' },
      { kind: 'modify', path: p('u.py'), before: 'def f():\n    pass\n', after: 'def f():\n    return 1\n' },
      { kind: 'delete', path: p('d.py'), before: 'gone\n', after: null },
      { kind: 'move', path: p('m.py'), newPath: p('m2.py'), before: 'a\n', after: 'b\n' },
    ]);
  });
  test('CRLF files keep CRLF after an update', () => {
    const files = { [p('w.py')]: 'a\r\nb\r\n' };
    const r = buildPatchWrites({ patch: '*** Begin Patch\n*** Update File: w.py\n@@\n-a\n+A\n*** End Patch' }, io(files));
    assert.deepEqual(r, { ok: true, writes: [{ kind: 'modify', path: p('w.py'), before: 'a\r\nb\r\n', after: 'A\r\nb\r\n' }] });
  });
  test('updating a missing file -> not-found', () => {
    const r = buildPatchWrites({ patch: '*** Begin Patch\n*** Update File: nope.py\n@@\n-a\n+b\n*** End Patch' }, io({}));
    assert.equal(r.ok, false);
    assert.equal((r as { kind: string }).kind, 'not-found');
  });
  test('malformed patch -> invalid', () => {
    const r = buildPatchWrites({ patch: '*** Begin Patch\nwhat\n*** End Patch' }, io({}));
    assert.equal(r.ok, false);
    assert.equal((r as { kind: string }).kind, 'invalid');
  });
  test('no patch text -> invalid', () => {
    assert.equal(buildPatchWrites({ command: 'ls' }, io({})).ok, false);
  });
  test('proposalSize sums the larger side of every write in utf-8 bytes', () => {
    assert.equal(proposalSize([{ kind: 'create', path: 'x', before: null, after: 'héllo' }, { kind: 'delete', path: 'y', before: 'zz', after: null }]), 8);
    assert.equal(proposalSize([{ kind: 'modify', path: 'x', before: 'long before', after: 'a' }]), 11);
  });
});
