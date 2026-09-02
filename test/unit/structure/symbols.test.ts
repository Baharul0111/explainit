import * as assert from 'node:assert/strict';
import { containerLabel, looksLikeFunctionValue, SymbolKindNum, symbolsToRaw, type SymbolLike } from '../../../src/structure/pure/symbols';

const r = (startLine: number, endLine: number, endChar = 1) => ({ start: { line: startLine, character: 0 }, end: { line: endLine, character: endChar } });

suite('structure/pure/symbols', () => {
  suite('looksLikeFunctionValue', () => {
    test('accepts arrow and function expressions assigned to a name', () => {
      assert.equal(looksLikeFunctionValue('export const add = (a: number, b: number): number => a + b;'), true);
      assert.equal(looksLikeFunctionValue('const debounce = function (fn, wait) {'), true);
      assert.equal(looksLikeFunctionValue('const f = async (x) => {'), true);
      assert.equal(looksLikeFunctionValue('const g = x => x * 2;'), true);
      assert.equal(looksLikeFunctionValue('const h = async function* () {'), true);
      assert.equal(looksLikeFunctionValue('const id = <T,>(x: T) => x;'), true);
      assert.equal(looksLikeFunctionValue('handler = (e) => {'), true);
    });
    test('rejects plain values and calls with callbacks', () => {
      assert.equal(looksLikeFunctionValue('const total = 42;'), false);
      assert.equal(looksLikeFunctionValue('const list = items.map(x => x * 2);'), false);
      assert.equal(looksLikeFunctionValue('const users = new Map<number, User>();'), false);
      assert.equal(looksLikeFunctionValue('let name = "function";'), false);
      assert.equal(looksLikeFunctionValue('if (a === b) {'), false);
    });
    test('a parenthesised expression that merely contains an arrow or function is not a function value', () => {
      assert.equal(looksLikeFunctionValue('const y = (a + b) * items.map(x => x);'), false);
      assert.equal(looksLikeFunctionValue('const y = (cb || function () {})();'), false);
      assert.equal(looksLikeFunctionValue('const y = (first ?? second).then(v => v);'), false);
    });
    test('typed and multi-line parameter lists still count', () => {
      assert.equal(looksLikeFunctionValue('const y = <T>(a: T): T => a;'), true);
      assert.equal(looksLikeFunctionValue('const y = async <T,>(a: T): Promise<T> => a;'), true);
      assert.equal(looksLikeFunctionValue('const y = (\n  a: number,\n  b: number,\n): number => a + b;'), true);
      assert.equal(looksLikeFunctionValue(undefined as unknown as string), false);
    });
    test('symbolsToRaw looks at up to twelve lines of a variable declaration', () => {
      const params = Array.from({ length: 8 }, (_, i) => `  p${i}: number,`);
      const text = ['export const wide = (', ...params, '): number => 1;', 'const after = 2;'].join('\n');
      const last = params.length + 1;
      const tree: SymbolLike[] = [
        { name: 'wide', kind: SymbolKindNum.Variable, range: r(0, last, 15), children: [] },
        { name: 'after', kind: SymbolKindNum.Variable, range: r(last + 1, last + 1, 16), children: [] },
      ];
      assert.deepEqual(
        symbolsToRaw(tree, { text }).map((f) => [f.name, f.range.startLine, f.range.endLine]),
        [['wide', 0, last]],
      );
    });
  });

  suite('containerLabel', () => {
    test('strips rust-analyzer impl labels down to the type and leaves other names alone', () => {
      assert.equal(containerLabel('impl Stack'), 'Stack');
      assert.equal(containerLabel('impl<T> Stack<T>'), 'Stack');
      assert.equal(containerLabel('impl Display for Stack'), 'Stack');
      assert.equal(containerLabel('impl<T: Clone> From<T> for Wrapper<T>'), 'Wrapper');
      assert.equal(containerLabel('Stack'), 'Stack');
      assert.equal(containerLabel('implementation'), 'implementation');
    });
    test('an impl block qualifies its methods with the type only', () => {
      const tree: SymbolLike[] = [
        {
          name: 'impl Stack',
          kind: SymbolKindNum.Object,
          range: r(0, 4),
          children: [
            { name: 'new', kind: SymbolKindNum.Method, range: r(1, 1, 30), children: [] },
            { name: 'push', kind: SymbolKindNum.Method, range: r(2, 3), children: [] },
          ],
        },
      ];
      const raws = symbolsToRaw(tree, { text: 'impl Stack {\n    fn new() -> Self { Stack {} }\n    fn push(&mut self) {\n    }\n}\n' });
      assert.deepEqual(raws.map((f) => [f.name, f.kind]), [
        ['Stack.new', 'method'],
        ['Stack.push', 'method'],
      ]);
    });
  });

  suite('symbolsToRaw with a DocumentSymbol tree (TypeScript provider shape)', () => {
    const text = [
      'export function slugify(input: string): string {', // 0
      '  return input;', // 1
      '}', // 2
      '', // 3
      'export const add = (a: number, b: number): number => a + b;', // 4
      'const total = 42;', // 5
      'export class UserStore {', // 6
      '  private users = new Map<number, User>();', // 7
      '  constructor() {}', // 8
      '  add(user: User): void {', // 9
      '    items.forEach(function () {});', // 10
      '  }', // 11
      '}', // 12
      'function outer() {', // 13
      '  function inner() {}', // 14
      '}', // 15
    ].join('\n');

    const tree: SymbolLike[] = [
      { name: 'slugify', kind: SymbolKindNum.Function, range: r(0, 2), children: [] },
      { name: 'add', kind: SymbolKindNum.Variable, range: r(4, 4, 60), children: [] },
      { name: 'total', kind: SymbolKindNum.Variable, range: r(5, 5, 17), children: [] },
      {
        name: 'UserStore',
        kind: SymbolKindNum.Class,
        range: r(6, 12),
        children: [
          { name: 'users', kind: SymbolKindNum.Property, range: r(7, 7, 40), children: [] },
          { name: 'constructor', kind: SymbolKindNum.Constructor, range: r(8, 8, 18), children: [] },
          {
            name: 'add',
            kind: SymbolKindNum.Method,
            range: r(9, 11),
            children: [{ name: '<function>', kind: SymbolKindNum.Function, range: r(10, 10, 30), children: [] }],
          },
        ],
      },
      {
        name: 'outer',
        kind: SymbolKindNum.Function,
        range: r(13, 15),
        children: [{ name: 'inner', kind: SymbolKindNum.Function, range: r(14, 14, 22), children: [] }],
      },
    ];

    test('emits functions, methods, constructors and function-valued variables with qualified names', () => {
      const raws = symbolsToRaw(tree, { text });
      assert.deepEqual(
        raws.map((f) => [f.name, f.kind, f.range.startLine, f.range.endLine]),
        [
          ['slugify', 'function', 0, 2],
          ['add', 'function', 4, 4],
          ['UserStore.constructor', 'constructor', 8, 8],
          ['UserStore.add', 'method', 9, 11],
          ['outer', 'function', 13, 15],
          ['outer.inner', 'function', 14, 14],
        ],
      );
    });

    test('ignores plain variables, properties and anonymous <function> placeholders', () => {
      const names = symbolsToRaw(tree, { text }).map((f) => f.name);
      assert.ok(!names.includes('total'));
      assert.ok(!names.includes('UserStore.users'));
      assert.ok(!names.some((n) => n.includes('<function>')));
    });

    test('a range ending at column 0 of the next line stops on the previous line', () => {
      const raws = symbolsToRaw([{ name: 'f', kind: SymbolKindNum.Function, range: r(0, 3, 0), children: [] }], { text });
      assert.deepEqual(raws[0].range, { startLine: 0, endLine: 2 });
    });

    test('a Function kind reported by a Variable-style provider for an arrow const is kept once', () => {
      const raws = symbolsToRaw([{ name: 'add', kind: SymbolKindNum.Function, range: r(4, 4, 60), children: [] }], { text });
      assert.deepEqual(raws.map((f) => f.name), ['add']);
    });

    test('an arrow property inside a class is a method', () => {
      const cls: SymbolLike[] = [
        {
          name: 'Comp',
          kind: SymbolKindNum.Class,
          range: r(0, 2),
          children: [{ name: 'onClick', kind: SymbolKindNum.Property, range: r(1, 1, 30), children: [] }],
        },
      ];
      const raws = symbolsToRaw(cls, { text: 'class Comp {\n  onClick = () => {};\n}' });
      assert.deepEqual(raws.map((f) => [f.name, f.kind]), [['Comp.onClick', 'method']]);
    });

    test('python-style __init__ is a constructor', () => {
      const py: SymbolLike[] = [
        {
          name: 'Server',
          kind: SymbolKindNum.Class,
          range: r(0, 3),
          children: [{ name: '__init__', kind: SymbolKindNum.Method, range: r(1, 2), children: [] }],
        },
      ];
      const raws = symbolsToRaw(py, { text: 'class Server:\n    def __init__(self):\n        pass\n' });
      assert.deepEqual(raws.map((f) => [f.name, f.kind]), [['Server.__init__', 'constructor']]);
    });
  });

  suite('symbolsToRaw with a flat SymbolInformation list', () => {
    test('uses containerName as the qualifier and location.range for lines', () => {
      const flat: SymbolLike[] = [
        { name: 'Calculator', kind: SymbolKindNum.Class, location: { range: r(0, 10) }, containerName: '' },
        { name: 'add', kind: SymbolKindNum.Method, location: { range: r(2, 4) }, containerName: 'Calculator' },
        { name: 'helper', kind: SymbolKindNum.Function, location: { range: r(6, 8) }, containerName: '' },
      ];
      const raws = symbolsToRaw(flat, { text: 'x\n'.repeat(11) });
      assert.deepEqual(
        raws.map((f) => [f.name, f.kind, f.range.startLine, f.range.endLine]),
        [
          ['Calculator.add', 'method', 2, 4],
          ['helper', 'function', 6, 8],
        ],
      );
    });
  });

  test('handles empty input and symbols without ranges', () => {
    assert.deepEqual(symbolsToRaw([], { text: '' }), []);
    assert.deepEqual(symbolsToRaw([{ name: 'x', kind: SymbolKindNum.Function }], { text: 'x' }), []);
  });

  test('malformed provider output is skipped, never thrown on', () => {
    const good = { name: 'ok', kind: SymbolKindNum.Function, range: r(1, 1), children: [null, 5, 'text'] } as unknown as SymbolLike;
    const bad = [
      null,
      undefined,
      'text',
      42,
      { name: undefined, kind: SymbolKindNum.Function, range: r(0, 0) },
      { name: 'noStart', kind: SymbolKindNum.Function, range: { start: null, end: { line: 0, character: 1 } } },
      { name: 'textLine', kind: SymbolKindNum.Function, range: { start: { line: 'a', character: 0 }, end: { line: 0, character: 1 } } },
      { name: 'nanLine', kind: SymbolKindNum.Function, range: { start: { line: NaN, character: 0 }, end: { line: 0, character: 1 } } },
      { name: 'stringKind', kind: 'Function', range: r(0, 0) },
      { name: 12345, kind: SymbolKindNum.Function, range: r(0, 0) },
      good,
    ] as unknown as SymbolLike[];
    const raws = symbolsToRaw(bad, { text: 'a\nb\nc' });
    assert.deepEqual(
      raws.map((f) => [f.name, f.range.startLine, f.range.endLine]),
      [
        ['12345', 0, 0],
        ['ok', 1, 1],
      ],
    );
    assert.deepEqual(symbolsToRaw(null as unknown as SymbolLike[], { text: 'a' }), []);
    assert.deepEqual(symbolsToRaw({} as unknown as SymbolLike[], { text: 'a' }), []);
  });
});
