import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CancelSource } from '../../../src/core/cancel';
import { createConsoleLogger } from '../../../src/core/log';
import { buildFunctionMap } from '../../../src/structure/pure/normalize';
import { GRAMMAR_BY_LANGUAGE, resolveWasmDir, TreeSitterService } from '../../../src/structure/pure/treeSitter';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const fixture = (rel: string): string => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'workspace', rel), 'utf8');

suite('structure/pure/treeSitter', function () {
  this.timeout(30000);
  const wasmDir = resolveWasmDir(ROOT);
  let service: TreeSitterService;

  suiteSetup(() => {
    assert.ok(wasmDir, 'wasm directory should resolve from dist/wasm or node_modules');
    service = new TreeSitterService({ wasmDir: wasmDir!, logger: createConsoleLogger('warn') });
  });
  suiteTeardown(() => service.dispose());

  const outline = async (rel: string, languageId: string) => {
    const text = fixture(rel);
    const parsed = await service.parseFunctions(text, languageId);
    assert.ok(parsed, `tree-sitter should parse ${rel}`);
    assert.equal(parsed!.hasError, false, `${rel} should parse without syntax errors`);
    const map = buildFunctionMap(text, languageId, `file:///${rel}`, 'tree-sitter', parsed!.functions);
    return map.functions.map((f) => [f.name, f.kind, f.range.startLine, f.range.endLine] as const);
  };

  test('resolveWasmDir prefers dist/wasm and falls back to the npm package', () => {
    assert.ok(wasmDir!.endsWith(path.join('dist', 'wasm')) || wasmDir!.includes(path.join('@vscode', 'tree-sitter-wasm')));
    assert.ok(fs.existsSync(path.join(wasmDir!, 'tree-sitter.wasm')));
    // Even when the extension path is wrong, the npm package resolvable from this module still serves (dev/test only).
    const fallback = resolveWasmDir(path.join(ROOT, 'does-not-exist'));
    assert.ok(fallback === undefined || fs.existsSync(path.join(fallback, 'tree-sitter.wasm')));
  });

  test('languages() lists every mapped language whose grammar file exists', async () => {
    const langs = service.languages();
    for (const id of Object.keys(GRAMMAR_BY_LANGUAGE)) assert.ok(langs.includes(id), `${id} missing`);
    assert.ok(service.supports('python'));
    assert.ok(!service.supports('cobol'));
    assert.equal(await service.parseFunctions('x', 'cobol'), undefined);
  });

  test('python: app.py', async () => {
    assert.deepEqual(await outline('src/app.py', 'python'), [
      ['load_config', 'function', 5, 10],
      ['greet', 'function', 13, 17],
      ['Server.__init__', 'constructor', 21, 23],
      ['Server.start', 'method', 25, 27],
      ['Server.stop', 'method', 29, 30],
      ['main', 'function', 33, 37],
    ]);
  });

  test('typescript: util.ts (const arrow included, class methods qualified)', async () => {
    assert.deepEqual(await outline('src/util.ts', 'typescript'), [
      ['slugify', 'function', 5, 11],
      ['add', 'function', 13, 13],
      ['UserStore.add', 'method', 18, 20],
      ['UserStore.find', 'method', 22, 24],
      ['fetchJson', 'function', 27, 33],
    ]);
  });

  test('typescriptreact uses the tsx grammar and gives the same outline for util.ts', async () => {
    assert.deepEqual(
      (await outline('src/util.ts', 'typescriptreact')).map((f) => f[0]),
      ['slugify', 'add', 'UserStore.add', 'UserStore.find', 'fetchJson'],
    );
  });

  test('javascript: legacy.js (function expression assigned to const)', async () => {
    assert.deepEqual(await outline('src/legacy.js', 'javascript'), [
      ['clamp', 'function', 1, 5],
      ['debounce', 'function', 7, 13],
    ]);
  });

  test('go: main.go (methods qualified with the receiver type)', async () => {
    assert.deepEqual(await outline('pkg/main.go', 'go'), [
      ['Reverse', 'function', 8, 14],
      ['Counter.Add', 'method', 20, 25],
      ['main', 'function', 27, 29],
    ]);
  });

  test('rust: lib.rs (impl qualifies, new is the constructor)', async () => {
    assert.deepEqual(await outline('pkg/lib.rs', 'rust'), [
      ['add', 'function', 1, 3],
      ['Stack.new', 'constructor', 10, 12],
      ['Stack.push', 'method', 14, 16],
      ['Stack.pop', 'method', 18, 20],
    ]);
  });

  test('java: Calculator.java', async () => {
    assert.deepEqual(await outline('pkg/Calculator.java', 'java'), [
      ['Calculator.add', 'method', 3, 5],
      ['Calculator.reset', 'method', 7, 9],
      ['Calculator.getTotal', 'method', 11, 13],
      ['Calculator.square', 'method', 15, 17],
    ]);
  });

  test('c: math.c through the C++ grammar', async () => {
    assert.deepEqual(await outline('pkg/math.c', 'c'), [
      ['max_int', 'function', 3, 5],
      ['print_line', 'function', 7, 9],
      ['main', 'function', 11, 14],
    ]);
  });

  test('cpp: shapes.cpp (namespace and class qualifiers, constructor)', async () => {
    assert.deepEqual(await outline('pkg/shapes.cpp', 'cpp'), [
      ['shapes.circleArea', 'function', 4, 6],
      ['shapes.Rect.Rect', 'constructor', 10, 10],
      ['shapes.Rect.area', 'method', 11, 11],
    ]);
  });

  test('javascript/typescript edge cases: pairs, class fields, default export, nesting, generators, out-of-class C++', async () => {
    const ts = [
      'const obj = { run: function () {}, go: () => 1, async fetchIt() {} };',
      'class A { handle = () => {}; constructor(x) {} static make() { return new A(); } }',
      'export default function () {}',
      'function outer() { function inner() {} const cb = async (x) => x; items.map(x => x); }',
      'module.exports.thing = function () {};',
      'const Foo = class { m() {} };',
      'function* gen() {}',
      'export const Comp = () => <div onClick={() => 1} />;',
    ].join('\n');
    const parsed = await service.parseFunctions(ts, 'typescriptreact');
    assert.ok(parsed);
    const names = parsed!.functions.map((f) => `${f.name}:${f.kind}`).sort();
    assert.deepEqual(
      names,
      [
        'A.constructor:constructor',
        'A.handle:method',
        'A.make:method',
        'Comp:function',
        'Foo.m:method',
        'default:function',
        'gen:function',
        'module.exports.thing:function',
        'obj.fetchIt:method',
        'obj.go:function',
        'obj.run:function',
        'outer.cb:function',
        'outer.inner:function',
        'outer:function',
      ].sort(),
    );
    const cpp = ['class Rect { public: ~Rect() {} bool operator==(const Rect& o) const { return true; } };', 'int Rect::count() { return 0; }', 'template <typename T>', 'T twice(T v) { return v * 2; }'].join('\n');
    const cppParsed = await service.parseFunctions(cpp, 'cpp');
    assert.deepEqual(
      cppParsed!.functions.map((f) => [f.name, f.range.startLine, f.range.endLine]),
      [
        ['Rect.~Rect', 0, 0],
        ['Rect.operator==', 0, 0],
        ['Rect.count', 1, 1],
        ['twice', 2, 3],
      ],
    );
  });

  test('python decorators are part of the function range', async () => {
    const py = ['@decorator', 'def deco(x):', '    return x', 'class A:', '    @staticmethod', '    def s():', '        pass'].join('\n');
    const parsed = await service.parseFunctions(py, 'python');
    assert.deepEqual(
      parsed!.functions.map((f) => [f.name, f.range.startLine, f.range.endLine]),
      [
        ['deco', 0, 2],
        ['A.s', 4, 6],
      ],
    );
  });

  test('CRLF text gives the same lines and hashes as LF text', async () => {
    // Normalise first: a Windows checkout may already hold CRLF, and doubling it would skew line numbers.
    const lf = fixture('src/app.py').replace(/\r\n?/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = buildFunctionMap(lf, 'python', 'f', 'tree-sitter', (await service.parseFunctions(lf, 'python'))!.functions);
    const b = buildFunctionMap(crlf, 'python', 'f', 'tree-sitter', (await service.parseFunctions(crlf, 'python'))!.functions);
    assert.deepEqual(
      a.functions.map((f) => [f.id, f.range, f.contentHash]),
      b.functions.map((f) => [f.id, f.range, f.contentHash]),
    );
  });

  test('syntax errors are reported but functions are still found', async () => {
    const parsed = await service.parseFunctions('def ok():\n    return 1\ndef broken(:\n', 'python');
    assert.ok(parsed);
    assert.equal(parsed!.hasError, true);
    assert.ok(parsed!.functions.some((f) => f.name === 'ok'));
  });

  test('a cancelled token abandons the parse', async () => {
    const src = new CancelSource();
    src.cancel();
    assert.equal(await service.parseFunctions(fixture('src/app.py'), 'python', src.token), undefined);
  });

  test('maps a 3,000-line file in under a second once the grammar is loaded', async () => {
    const chunk = ['def f{i}(x):', '    if x > 0:', '        return x', '    return -x', ''];
    const text = Array.from({ length: 600 }, (_, i) => chunk.join('\n').replace('{i}', String(i))).join('\n');
    await service.parseFunctions('def warm(): pass', 'python');
    const started = Date.now();
    const parsed = await service.parseFunctions(text, 'python');
    const map = buildFunctionMap(text, 'python', 'f', 'tree-sitter', parsed!.functions);
    const elapsed = Date.now() - started;
    assert.equal(map.functions.length, 600);
    assert.ok(elapsed < 1000, `took ${elapsed}ms`);
  });

  test('a runtime that throws while parsing is reported as unavailable, not thrown, and is retried fresh next time', async () => {
    let parsers = 0;
    let parses = 0;
    const fake = {
      Parser: class {
        static init(): Promise<void> {
          return Promise.resolve();
        }
        constructor() {
          parsers++;
        }
        reset(): void {}
        setLanguage(): void {}
        parse(): never {
          parses++;
          throw new Error('wasm aborted (out of memory)');
        }
        delete(): void {}
      },
      Language: { load: async () => ({}) },
    };
    const throwing = new TreeSitterService({ wasmDir: wasmDir!, loadModule: () => fake as never });
    assert.equal(await throwing.parseFunctions('def f(): pass\nx = 1', 'python'), undefined);
    assert.equal(await throwing.parseFunctions('def g(): pass\nx = 1', 'python'), undefined);
    assert.equal(parses, 2);
    assert.equal(parsers, 2, 'a parser that threw is discarded and a fresh one is created for the next call');
    throwing.dispose();
  });

  test('texts over the size cap are skipped (so the host never freezes) and the caller can fall back', async () => {
    const capped = new TreeSitterService({ wasmDir: wasmDir!, maxTextChars: 100 });
    const small = 'def f():\n    return 1\n';
    assert.ok((await capped.parseFunctions(small, 'python'))!.functions.length === 1);
    assert.equal(await capped.parseFunctions(small.repeat(10), 'python'), undefined);
    assert.equal(await capped.parseFunctions(undefined as unknown as string, 'python'), undefined);
    capped.dispose();
  });

  test('a broken runtime load is reported as unavailable, not thrown', async () => {
    const broken = new TreeSitterService({
      wasmDir: wasmDir!,
      loadModule: () => {
        throw new Error('no wasm here');
      },
    });
    assert.equal(await broken.parseFunctions('def f(): pass', 'python'), undefined);
    broken.dispose();
  });
});
