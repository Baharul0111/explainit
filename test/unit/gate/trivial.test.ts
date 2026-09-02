import * as assert from 'node:assert/strict';
import { isTrivialChange, stripForTrivial } from '../../../src/gate/pure/trivial';

suite('gate/pure/trivial', () => {
  test('whitespace-only change is trivial in any language', () => {
    assert.equal(isTrivialChange('a=1\n', 'a = 1\n\n', 'plaintext'), true);
    assert.equal(isTrivialChange('x\ty\n', 'x y\n', 'cobol'), true);
  });
  test('comment-only change is trivial for // and /* */ languages', () => {
    assert.equal(isTrivialChange('const a = 1; // one\n', 'const a = 1; // uno\n', 'typescript'), true);
    assert.equal(isTrivialChange('/* old */ int x;\n', 'int x; /* new\nmultiline */\n', 'c'), true);
  });
  test('python # comments and docstrings are trivial', () => {
    assert.equal(isTrivialChange('def f():\n    """doc"""\n    return 1  # a\n', 'def f():\n    return 1\n', 'python'), true);
  });
  test('sql/lua -- comments, lisp ; comments, html comments', () => {
    assert.equal(isTrivialChange('SELECT 1 -- a\n', 'SELECT 1 -- b\n', 'sql'), true);
    assert.equal(isTrivialChange('(+ 1 2) ; a\n', '(+ 1 2) ; b\n', 'clojure'), true);
    assert.equal(isTrivialChange('<div><!-- a --></div>', '<div></div>', 'html'), true);
  });
  test('comment markers inside strings are code, not comments', () => {
    assert.equal(isTrivialChange('const u = "http://a";\n', 'const u = "http://b";\n', 'typescript'), false);
    assert.equal(isTrivialChange("s = '# not a comment'\n", "s = '# changed'\n", 'python'), false);
  });
  test('# is not a comment in C (preprocessor), so a changed include is not trivial', () => {
    assert.equal(isTrivialChange('#include <a.h>\n', '#include <b.h>\n', 'c'), false);
  });
  test('unknown language strips only whitespace', () => {
    assert.equal(stripForTrivial('a // b\n', 'brainfuck'), 'a//b');
    assert.equal(isTrivialChange('a // b\n', 'a // c\n', 'brainfuck'), false);
  });
  test('real code changes are never trivial', () => {
    assert.equal(isTrivialChange('return a + b;', 'return a - b;', 'javascript'), false);
    assert.equal(isTrivialChange('', 'def f():\n  pass\n', 'python'), false);
  });
  test('removing a comment-only block is trivial', () => {
    assert.equal(isTrivialChange('# note\n', '', 'python'), true);
  });
});
