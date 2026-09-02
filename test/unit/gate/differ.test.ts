import * as assert from 'node:assert/strict';
import type { FunctionHunk, FunctionMap, FunctionRecord } from '../../../src/core/types';
import { computeHunks, reconstruct } from '../../../src/gate/pure/differ';
import { regexFunctionMap } from './fakes';

/** Build a map from explicit (name, start, end) triples (0-based inclusive lines). */
function mapOf(text: string, fns: [string, number, number, FunctionRecord['kind']?][]): FunctionMap {
  const seen = new Map<string, number>();
  return {
    fileUri: 'file:///x.ts',
    languageId: 'typescript',
    source: 'symbols',
    textHash: 'h',
    functions: fns.map(([name, s, e, kind]) => {
      const n = seen.get(name) ?? 0;
      seen.set(name, n + 1);
      return { id: `${name}#${n}`, name, kind: kind ?? 'function', range: { startLine: s, endLine: e }, contentHash: 'c', languageId: 'typescript', source: 'symbols' };
    }),
  };
}

const UTIL_BEFORE = `export interface User {
  id: number;
  name: string;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export const add = (a: number, b: number): number => a + b;

export class UserStore {
  private users = new Map<number, User>();

  add(user: User): void {
    this.users.set(user.id, user);
  }

  find(id: number): User | undefined {
    return this.users.get(id);
  }
}

export async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(\`Request failed: \${res.status}\`);
  }
  return res.json();
}
`;
// Ranges match the fixture file test/fixtures/workspace/src/util.ts.
const UTIL_BEFORE_MAP = (): FunctionMap =>
  mapOf(UTIL_BEFORE, [
    ['slugify', 5, 11],
    ['add', 13, 13],
    ['UserStore', 15, 25, 'class'],
    ['UserStore.add', 18, 20, 'method'],
    ['UserStore.find', 22, 24, 'method'],
    ['fetchJson', 27, 33],
  ]);

const all = (hunks: FunctionHunk[], v: 'accept' | 'reject'): Record<string, 'accept' | 'reject'> => Object.fromEntries(hunks.map((h) => [h.id, v]));

function assertExact(before: string, after: string, hunks: FunctionHunk[]): void {
  assert.equal(reconstruct(after, hunks, all(hunks, 'reject')), before, 'all rejected must give the before text');
  assert.equal(reconstruct(after, hunks, all(hunks, 'accept')), after, 'all accepted must give the after text');
  // Every single-hunk rejection must also be a well-formed text (no thrown errors, ends with newline).
  for (const h of hunks) {
    const one = reconstruct(after, hunks, { ...all(hunks, 'accept'), [h.id]: 'reject' });
    assert.ok(one === '' || one.endsWith('\n'));
  }
}

suite('gate/pure/differ: computeHunks on util.ts', () => {
  test('modified function -> one function hunk with full before/after text', () => {
    const after = UTIL_BEFORE.replace("    .replace(/^-|-$/g, '');", "    .replace(/^-+|-+$/g, '');");
    const hunks = computeHunks('/ws/util.ts', UTIL_BEFORE, after, UTIL_BEFORE_MAP(), UTIL_BEFORE_MAP(), { languageId: 'typescript' });
    assert.equal(hunks.length, 1);
    const h = hunks[0];
    assert.equal(h.kind, 'function');
    assert.equal(h.functionName, 'slugify');
    assert.equal(h.changeType, 'modified');
    assert.equal(h.trivial, false);
    assert.deepEqual(h.afterRange, { startLine: 5, endLine: 11 });
    assert.ok(h.beforeText.startsWith('export function slugify'));
    assert.ok(h.afterText.includes('-+$'));
    assertExact(UTIL_BEFORE, after, hunks);
  });

  test('added function -> added hunk; removed function -> removed hunk with an insertion point', () => {
    const added = UTIL_BEFORE + '\nexport function twice(n: number): number {\n  return n * 2;\n}\n';
    const afterMap = mapOf(added, [...UTIL_BEFORE_MAP().functions.map((f) => [f.name, f.range.startLine, f.range.endLine, f.kind] as [string, number, number, FunctionRecord['kind']]), ['twice', 35, 37]]);
    const hunks = computeHunks('/ws/util.ts', UTIL_BEFORE, added, UTIL_BEFORE_MAP(), afterMap, { languageId: 'typescript' });
    assert.deepEqual(hunks.map((h) => [h.kind, h.functionName, h.changeType]), [
      ['trivial', undefined, 'added'],
      ['function', 'twice', 'added'],
    ]);
    assert.equal(hunks[0].afterText, '\n', 'the blank separator line is a whitespace-only (trivial) block');
    assertExact(UTIL_BEFORE, added, hunks);

    // Reverse direction: the function is removed.
    const back = computeHunks('/ws/util.ts', added, UTIL_BEFORE, afterMap, UTIL_BEFORE_MAP(), { languageId: 'typescript' });
    assert.deepEqual(back.map((h) => [h.kind, h.functionName, h.changeType]), [
      ['trivial', undefined, 'removed'],
      ['function', 'twice', 'removed'],
    ]);
    const removed = back[1];
    assert.equal(removed.afterText, '');
    assert.equal(removed.afterRange!.endLine, removed.afterRange!.startLine - 1);
    assertExact(added, UTIL_BEFORE, back);
  });

  test('top-level import change -> other hunk', () => {
    const after = "import { z } from 'zod';\n" + UTIL_BEFORE;
    const shifted = mapOf(after, UTIL_BEFORE_MAP().functions.map((f) => [f.name, f.range.startLine + 1, f.range.endLine + 1, f.kind]));
    const hunks = computeHunks('/ws/util.ts', UTIL_BEFORE, after, UTIL_BEFORE_MAP(), shifted, { languageId: 'typescript' });
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].kind, 'other');
    assert.equal(hunks[0].changeType, 'added');
    assert.equal(hunks[0].afterText, "import { z } from 'zod';\n");
    assert.deepEqual(hunks[0].afterRange, { startLine: 0, endLine: 0 });
    assertExact(UTIL_BEFORE, after, hunks);
  });

  test('whitespace-only change inside a function -> trivial', () => {
    const after = UTIL_BEFORE.replace('  return res.json();', '  return  res.json();');
    const hunks = computeHunks('/ws/util.ts', UTIL_BEFORE, after, UTIL_BEFORE_MAP(), UTIL_BEFORE_MAP(), { languageId: 'typescript' });
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].kind, 'trivial');
    assert.equal(hunks[0].trivial, true);
    assert.equal(hunks[0].functionName, 'fetchJson');
    assertExact(UTIL_BEFORE, after, hunks);
  });

  test('a changed method inside a class is attributed to the method, not the class', () => {
    const after = UTIL_BEFORE.replace('    return this.users.get(id);', '    return this.users.get(id) ?? undefined;');
    const hunks = computeHunks('/ws/util.ts', UTIL_BEFORE, after, UTIL_BEFORE_MAP(), UTIL_BEFORE_MAP(), { languageId: 'typescript' });
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].functionName, 'UserStore.find');
    assertExact(UTIL_BEFORE, after, hunks);
  });

  test('a class field change is an other hunk hinted with the class name', () => {
    const after = UTIL_BEFORE.replace('  private users = new Map<number, User>();', '  private users = new Map<number, User>();\n  private count = 0;');
    const afterMap = mapOf(after, [
      ['slugify', 5, 11],
      ['add', 13, 13],
      ['UserStore', 15, 26, 'class'],
      ['UserStore.add', 19, 21, 'method'],
      ['UserStore.find', 23, 25, 'method'],
      ['fetchJson', 28, 34],
    ]);
    const hunks = computeHunks('/ws/util.ts', UTIL_BEFORE, after, UTIL_BEFORE_MAP(), afterMap, { languageId: 'typescript' });
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].kind, 'other');
    assert.equal(hunks[0].functionName, 'UserStore');
    assertExact(UTIL_BEFORE, after, hunks);
  });

  test('several changes at once: import + modified + added + removed, exact reconstruction of every subset', () => {
    const after =
      "import { z } from 'zod';\n" +
      UTIL_BEFORE.replace('export const add = (a: number, b: number): number => a + b;\n', '')
        .replace('    .trim()\n', '')
        .replace('export async function fetchJson', 'export function mul(a: number, b: number): number {\n  return a * b;\n}\n\nexport async function fetchJson');
    const bm = UTIL_BEFORE_MAP();
    const am = regexFunctionMap(after, 'typescript', 'x');
    // regexFunctionMap does not know classes; add the class methods by hand for a realistic map.
    const hunks = computeHunks('/ws/util.ts', UTIL_BEFORE, after, bm, am, { languageId: 'typescript' });
    const names = hunks.map((h) => `${h.kind}:${h.functionName ?? ''}:${h.changeType}`);
    assert.ok(names.includes('other::added'), names.join());
    assert.ok(names.includes('function:slugify:modified'), names.join());
    assert.ok(names.includes('function:add:removed'), names.join());
    assert.ok(names.includes('function:mul:added'), names.join());
    assertExact(UTIL_BEFORE, after, hunks);
    // Mixed: accept the import and mul, reject the rest -> a valid text containing both.
    const verdicts = all(hunks, 'reject');
    for (const h of hunks) if (h.functionName === 'mul' || h.kind === 'other') verdicts[h.id] = 'accept';
    const mixed = reconstruct(after, hunks, verdicts);
    assert.ok(mixed.startsWith("import { z } from 'zod';\n"));
    assert.ok(mixed.includes('export function mul'));
    assert.ok(mixed.includes('export const add ='));
    assert.ok(mixed.includes('    .trim()\n'));
  });
});

suite('gate/pure/differ: edge cases', () => {
  test('no maps -> every changed block is an other hunk, still exact', () => {
    const before = 'a\nb\nc\nd\n';
    const after = 'a\nB\nc\nd\ne\n';
    const hunks = computeHunks('/x', before, after, undefined, undefined, { languageId: 'plaintext' });
    assert.deepEqual(hunks.map((h) => [h.kind, h.changeType, h.beforeText, h.afterText]), [
      ['other', 'modified', 'b\n', 'B\n'],
      ['other', 'added', '', 'e\n'],
    ]);
    assertExact(before, after, hunks);
  });

  test('identical text -> no hunks; create and delete -> added/removed', () => {
    assert.deepEqual(computeHunks('/x', 'same\n', 'same\n', undefined, undefined, { languageId: 'plaintext' }), []);
    const created = computeHunks('/x.py', null, 'def f():\n    pass\n', undefined, regexFunctionMap('def f():\n    pass\n', 'python', 'x'), { languageId: 'python' });
    assert.deepEqual(created.map((h) => [h.kind, h.functionName, h.changeType]), [['function', 'f', 'added']]);
    assertExact('', 'def f():\n    pass\n', created);
    const deleted = computeHunks('/x.py', 'def f():\n    pass\n', null, regexFunctionMap('def f():\n    pass\n', 'python', 'x'), undefined, { languageId: 'python' });
    assert.deepEqual(deleted.map((h) => [h.kind, h.functionName, h.changeType]), [['function', 'f', 'removed']]);
    assert.equal(reconstruct('', deleted, all(deleted, 'reject')), 'def f():\n    pass\n');
  });

  test('CRLF input is handled on LF text', () => {
    const before = 'def f():\r\n    return 1\r\n';
    const after = 'def f():\r\n    return 2\r\n';
    const hunks = computeHunks('/x.py', before, after, regexFunctionMap(before, 'python', 'x'), regexFunctionMap(after, 'python', 'x'), { languageId: 'python' });
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].beforeText, 'def f():\n    return 1\n');
    assert.equal(reconstruct(after, hunks, all(hunks, 'reject')), 'def f():\n    return 1\n');
  });

  test('two removed functions in a row keep their order when both are rejected', () => {
    const before = 'def a():\n    pass\n\ndef b():\n    pass\n\ndef c():\n    pass\n';
    const after = 'def c():\n    pass\n';
    const hunks = computeHunks('/x.py', before, after, regexFunctionMap(before, 'python', 'x'), regexFunctionMap(after, 'python', 'x'), { languageId: 'python' });
    assert.deepEqual(hunks.filter((h) => h.kind === 'function').map((h) => `${h.functionName}:${h.changeType}`), ['a:removed', 'b:removed']);
    assert.ok(hunks.filter((h) => h.kind !== 'function').every((h) => h.functionName === undefined), 'insertion points carry no misleading hint');
    assertExact(before, after, hunks);
  });

  test('ids are stable and unique per (path, function, after text)', () => {
    const before = 'x\n';
    const after = 'y\nx\ny\n';
    const h1 = computeHunks('/x', before, after, undefined, undefined, { languageId: 'plaintext' });
    const h2 = computeHunks('/x', before, after, undefined, undefined, { languageId: 'plaintext' });
    assert.deepEqual(h1.map((h) => h.id), h2.map((h) => h.id));
    assert.equal(new Set(h1.map((h) => h.id)).size, h1.length);
    assert.notEqual(computeHunks('/other', before, after, undefined, undefined, { languageId: 'plaintext' })[0].id, h1[0].id);
  });

  test('hunks without an afterRange are ignored by reconstruct', () => {
    const hunks: FunctionHunk[] = [{ id: 'm', kind: 'other', functionName: 'rename', changeType: 'modified', beforeText: '', afterText: '', trivial: false }];
    assert.equal(reconstruct('a\n', hunks, { m: 'reject' }), 'a\n');
  });
});
