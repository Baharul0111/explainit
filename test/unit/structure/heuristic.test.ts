import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findBraceBlockEnd, findIndentBlockEnd, heuristicFunctions } from '../../../src/structure/pure/heuristic';
import { buildFunctionMap } from '../../../src/structure/pure/normalize';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const fixture = (rel: string): string => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'workspace', rel), 'utf8');
const summary = (text: string, languageId?: string) => heuristicFunctions(text, languageId).map((f) => [f.name, f.range.startLine, f.range.endLine]);

suite('structure/pure/heuristic', () => {
  test('COBOL paragraph names at column 8 followed by indented statements', () => {
    assert.deepEqual(summary(fixture('legacy/report.cob'), 'cobol'), [
      ['MAIN-PARA', 3, 6],
      ['READ-INPUT', 7, 8],
      ['PRINT-TOTAL', 9, 10],
    ]);
  });

  test('COBOL is recognised from the text even without a language id', () => {
    assert.deepEqual(summary(fixture('legacy/report.cob')).map((f) => f[0]), ['MAIN-PARA', 'READ-INPUT', 'PRINT-TOTAL']);
  });

  test('shell functions in both styles', () => {
    const sh = ['#!/bin/sh', 'greet() {', '  echo "hi $1"', '}', '', 'function bye {', '  echo bye', '}', 'greet world', 'bye'].join('\n');
    assert.deepEqual(summary(sh, 'shellscript'), [
      ['greet', 1, 3],
      ['bye', 5, 7],
    ]);
  });

  test('shell function with the brace on the next line', () => {
    const sh = ['setup()', '{', '  mkdir -p build', '}', 'setup'].join('\n');
    assert.deepEqual(summary(sh), [['setup', 0, 3]]);
  });

  test('python: indentation blocks, class qualifiers, constructor kind, docstrings ignored', () => {
    const raws = heuristicFunctions(fixture('src/app.py'), 'python');
    assert.deepEqual(
      raws.map((f) => [f.name, f.kind, f.range.startLine, f.range.endLine]),
      [
        ['load_config', 'function', 5, 10],
        ['greet', 'function', 13, 17],
        ['Server.__init__', 'constructor', 21, 23],
        ['Server.start', 'method', 25, 27],
        ['Server.stop', 'method', 29, 30],
        ['main', 'function', 33, 37],
      ],
    );
  });

  test('a docstring that mentions def is not a definition', () => {
    const py = ['def real():', '    """', '    def fake():', '        pass', '    """', '    return 1', ''].join('\n');
    assert.deepEqual(summary(py, 'python'), [['real', 0, 5]]);
  });

  test('javascript: function keyword, assigned function expressions, brace matching with strings', () => {
    assert.deepEqual(summary(fixture('src/legacy.js'), 'javascript'), [
      ['clamp', 1, 5],
      ['debounce', 7, 13],
    ]);
    const tricky = ['function a() {', '  const s = "}";', "  const t = '{';", '  // }', '  return `{`;', '}', 'function b() {}'].join('\n');
    assert.deepEqual(summary(tricky), [
      ['a', 0, 5],
      ['b', 6, 6],
    ]);
  });

  test('C-style definitions need an opening brace on the line or the next line; calls and control flow are skipped', () => {
    const c = [
      '#include <stdio.h>',
      'int max_int(int a, int b) {',
      '    if (a > b) {',
      '        return a;',
      '    }',
      '    return b;',
      '}',
      'static void print_line(const char *text)',
      '{',
      '    printf("%s\\n", text);',
      '}',
      'int declared_only(int x);',
      'int main(void) {',
      '    while (1) {',
      '        print_line("x");',
      '    }',
      '    return max_int(1, 2);',
      '}',
    ].join('\n');
    assert.deepEqual(summary(c, 'c'), [
      ['max_int', 1, 6],
      ['print_line', 7, 10],
      ['main', 12, 17],
    ]);
  });

  test('C++/Java: methods are qualified by their class, constructors are detected', () => {
    const java = fixture('pkg/Calculator.java');
    const raws = heuristicFunctions(java, 'java');
    assert.deepEqual(
      raws.map((f) => [f.name, f.kind, f.range.startLine, f.range.endLine]),
      [
        ['Calculator.add', 'method', 3, 5],
        ['Calculator.reset', 'method', 7, 9],
        ['Calculator.getTotal', 'method', 11, 13],
        ['Calculator.square', 'method', 15, 17],
      ],
    );
    const cpp = ['class Rect {', 'public:', '    Rect(double w, double h) : w_(w), h_(h) {}', '    double area() const { return w_ * h_; }', '};', 'int Rect::count() { return 0; }'].join('\n');
    assert.deepEqual(
      heuristicFunctions(cpp, 'cpp').map((f) => [f.name, f.kind]),
      [
        ['Rect.Rect', 'constructor'],
        ['Rect.area', 'method'],
        ['Rect.count', 'function'],
      ],
    );
  });

  test('go, rust, ruby, perl, pascal-ish keywords', () => {
    const go = ['func Reverse(s string) string {', '\treturn s', '}', 'func (c *Counter) Add(w string) {', '}'].join('\n');
    assert.deepEqual(summary(go, 'go'), [
      ['Reverse', 0, 2],
      ['Add', 3, 4],
    ]);
    const rust = ['pub fn add(a: i32, b: i32) -> i32 {', '    a + b', '}', 'impl Stack {', '    pub fn new() -> Self {', '        Stack {}', '    }', '}'].join('\n');
    assert.deepEqual(summary(rust, 'rust'), [
      ['add', 0, 2],
      ['Stack.new', 4, 6],
    ]);
    const ruby = ['def greet(name)', '  puts name', 'end', '', 'class Dog', '  def bark', '    puts "woof"', '  end', 'end'].join('\n');
    assert.deepEqual(summary(ruby, 'ruby'), [
      ['greet', 0, 2],
      ['Dog.bark', 5, 7],
    ]);
    const perl = ['sub hello {', '  print "hi";', '}', 'hello();'].join('\n');
    assert.deepEqual(summary(perl, 'perl'), [['hello', 0, 2]]);
    const pascal = ['procedure Show;', 'begin', '  WriteLn(1);', 'end;', 'begin', 'end.'].join('\n');
    assert.deepEqual(summary(pascal, 'pascal'), [['Show', 0, 3]]);
  });

  test('nested definitions are qualified with the outer definition', () => {
    const py = ['def outer():', '    def inner():', '        pass', '    return inner', ''].join('\n');
    assert.deepEqual(summary(py, 'python'), [
      ['outer', 0, 3],
      ['outer.inner', 1, 2],
    ]);
  });

  test('comment lines and blank files produce nothing', () => {
    assert.deepEqual(summary(''), []);
    assert.deepEqual(summary('// function nothing() {}\n# def x():\n'), []);
    assert.deepEqual(summary('Just some prose.\nWith a second line.'), []);
  });

  test('prose lines that happen to start with a keyword are not definitions', () => {
    const prose = [
      'function names should be short and clear.',
      'def is a keyword in Python.',
      'sub headings go below the title',
      'method chaining makes this easier to read',
      'fn pointers are covered in chapter 3',
      'proc macros are advanced',
    ].join('\n');
    assert.deepEqual(summary(prose, 'markdown'), []);
    assert.deepEqual(summary(prose, 'plaintext'), []);
    // ... while real definitions in the same styles still are.
    const code = ['def greet', '  puts 1', 'end', 'def foo do', '  :ok', 'end', 'procedure Show;', 'begin', 'end;', 'proc foo*(x: int) =', '  x'].join('\n');
    assert.deepEqual(
      summary(code).map((f) => f[0]),
      ['greet', 'foo', 'Show', 'foo'],
    );
  });

  test('a one-megabyte single line and a 100,000-line file are outlined quickly', () => {
    const minified = 'var a=function(b){return b+1};' + 'x.y(function(){return 1});'.repeat(40000) + 'function z(){}';
    let started = Date.now();
    const one = heuristicFunctions(minified, 'javascript');
    assert.ok(Date.now() - started < 1000, 'single long line');
    assert.deepEqual(one.map((f) => f.name), ['a']);
    const chunk = ['def f{i}(x):', '    if x > 0:', '        return x', '    return -x', ''];
    const big = Array.from({ length: 20000 }, (_, i) => chunk.join('\n').replace('{i}', String(i))).join('\n');
    started = Date.now();
    const raws = heuristicFunctions(big, 'python');
    const map = buildFunctionMap(big, 'python', 'f', 'heuristic', raws);
    assert.ok(Date.now() - started < 3000, `100k lines took ${Date.now() - started}ms`);
    assert.equal(map.functions.length, 20000);
  });

  test('calls with callback arguments are not definitions', () => {
    const js = ["describe('thing', () => {", "  it('works', function () {", '    expect(1).toBe(1);', '  });', '});', 'function real() {}'].join('\n');
    assert.deepEqual(summary(js, 'javascript'), [['real', 5, 5]]);
  });

  test('a definition that never closes its brace falls back to indentation', () => {
    const js = ['function broken() {', '  return 1;', '', 'const x = 2;'].join('\n');
    assert.deepEqual(summary(js), [['broken', 0, 1]]);
  });

  suite('block helpers', () => {
    test('findBraceBlockEnd', () => {
      assert.equal(findBraceBlockEnd(['f() {', ' {', ' }', '}', 'g'], 0), 3);
      assert.equal(findBraceBlockEnd(['f()', '{', '}'], 0), 2);
      assert.equal(findBraceBlockEnd(['f()', '', 'x', '{', '}'], 0), -1);
      assert.equal(findBraceBlockEnd(['f() {', 'never'], 0), -1);
    });
    test('findIndentBlockEnd', () => {
      assert.equal(findIndentBlockEnd(['def f():', '  a', '', '  b', '', 'c'], 0, 0), 3);
      assert.equal(findIndentBlockEnd(['def f(): return 1', 'x'], 0, 0), 0);
      assert.equal(findIndentBlockEnd(['def f', '  a', 'end', 'x'], 0, 0), 2);
    });
  });

  test('maps a 3,000-line file in under a second', () => {
    const chunk = ['def f{i}(x):', '    if x > 0:', '        return x', '    return -x', ''];
    const text = Array.from({ length: 600 }, (_, i) => chunk.join('\n').replace('{i}', String(i))).join('\n');
    assert.ok(text.split('\n').length >= 3000);
    const started = Date.now();
    const map = buildFunctionMap(text, 'python', 'f', 'heuristic', heuristicFunctions(text, 'python'));
    const elapsed = Date.now() - started;
    assert.equal(map.functions.length, 600);
    assert.ok(elapsed < 1000, `took ${elapsed}ms`);
  });
});
