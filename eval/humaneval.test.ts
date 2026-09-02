import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EVAL_PATHS } from './paths';
import { NO_NETWORK_PRELUDE, buildTestProgram, extractPythonCode, functionTextForExplain, parseSubset, pickSpread, preambleForContext, splitPrompt, type HumanEvalProblem } from './pure/humaneval';

const SAMPLE: HumanEvalProblem = {
  task_id: 'HumanEval/0',
  entry_point: 'has_close_elements',
  prompt: 'from typing import List\n\n\ndef has_close_elements(numbers: List[float], threshold: float) -> bool:\n    """ Check if any two numbers are closer than threshold.\n    >>> has_close_elements([1.0, 2.0, 3.0], 0.5)\n    False\n    """\n',
  canonical_solution: '    for idx, elem in enumerate(numbers):\n        for idx2, elem2 in enumerate(numbers):\n            if idx != idx2:\n                if abs(elem - elem2) < threshold:\n                    return True\n\n    return False\n',
  test: '\n\ndef check(candidate):\n    assert candidate([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.3) == True\n    assert candidate([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.05) == False\n',
};

suite('eval/pure/humaneval: subset file', () => {
  test('the shipped subset has 12 well-formed, distinct problems', () => {
    const subset = parseSubset(fs.readFileSync(EVAL_PATHS.subset(), 'utf8'));
    assert.strictEqual(subset.problems.length, 12);
    assert.strictEqual(new Set(subset.problems.map((p) => p.task_id)).size, 12);
    assert.strictEqual(subset.license, 'MIT');
    for (const p of subset.problems) {
      assert.ok(p.task_id.startsWith('HumanEval/'));
      assert.ok(p.prompt.includes(`def ${p.entry_point}(`), `${p.task_id} prompt defines its entry point`);
      assert.ok(p.test.includes('def check(candidate)'), `${p.task_id} has a check function`);
      // The split must work for every shipped problem, and the explain text must not leak the docstring.
      const s = splitPrompt(p.prompt, p.entry_point);
      assert.ok(s.signature.startsWith(`def ${p.entry_point}(`));
      assert.ok(s.signature.trimEnd().endsWith(':'));
      assert.ok(s.docstring.length > 0, `${p.task_id} has a docstring`);
      const text = functionTextForExplain(p);
      assert.ok(!text.includes('"""') && !text.includes(">>>"), `${p.task_id} explain text has no docstring`);
      assert.ok(text.includes(p.canonical_solution.trim().split('\n')[0].trim()));
    }
    assert.ok(fs.existsSync(path.join(EVAL_PATHS.dir(), 'LICENSE-humaneval.txt')), 'MIT notice ships beside the data');
  });

  test('parseSubset accepts a bare array and rejects bad shapes with plain messages', () => {
    assert.strictEqual(parseSubset(JSON.stringify([SAMPLE])).problems.length, 1);
    assert.throws(() => parseSubset('not json'), /not valid JSON/);
    assert.throws(() => parseSubset('{}'), /no "problems" array/);
    assert.throws(() => parseSubset(JSON.stringify({ problems: [{ task_id: 'x' }] })), /missing "prompt"/);
  });
});

suite('eval/pure/humaneval: splitting and building', () => {
  test('splitPrompt separates preamble, signature and docstring', () => {
    const s = splitPrompt(SAMPLE.prompt, SAMPLE.entry_point);
    assert.strictEqual(s.preamble, 'from typing import List\n\n\n');
    assert.strictEqual(s.signature, 'def has_close_elements(numbers: List[float], threshold: float) -> bool:');
    assert.ok(s.docstring.startsWith('    """') && s.docstring.trimEnd().endsWith('"""'));
    assert.strictEqual(s.rest, '');
  });

  test('splitPrompt handles helpers, CRLF, multi-line signatures and no docstring', () => {
    const prompt = 'import math\r\n\r\ndef helper(x):\r\n    return x\r\n\r\ndef target(a,\r\n           b):\r\n    pass\r\n';
    const s = splitPrompt(prompt, 'target');
    assert.ok(s.preamble.includes('def helper(x):'));
    assert.strictEqual(s.signature, 'def target(a,\n           b):');
    assert.strictEqual(s.docstring, '');
    assert.strictEqual(s.rest, '    pass\n');
    assert.throws(() => splitPrompt(prompt, 'missing'), /does not define "missing"/);
    assert.throws(() => splitPrompt('def broken(', 'broken'), /end of the signature/);
  });

  test('splitPrompt picks the target, not a helper whose name contains it', () => {
    const prompt = 'def flip_case_helper(s: str) -> str:\n    return s\n\n\ndef helper_flip_case(s):\n    return s\n\n\ndef flip_case(string: str) -> str:\n    """ Flip. """\n';
    const s = splitPrompt(prompt, 'flip_case');
    assert.strictEqual(s.signature, 'def flip_case(string: str) -> str:');
    assert.ok(s.preamble.includes('def flip_case_helper') && s.preamble.includes('def helper_flip_case'));
    // Regex metacharacters in an entry point never reach the pattern unescaped.
    assert.throws(() => splitPrompt(prompt, 'flip.case'), /does not define "flip\.case"/);
  });

  test('splitPrompt with no preamble and a signature carrying a trailing comment', () => {
    const s = splitPrompt('def f(a):  # colon: inside a comment\n    """doc"""\n', 'f');
    assert.strictEqual(s.preamble, '');
    assert.strictEqual(s.signature, 'def f(a):  # colon: inside a comment');
    assert.strictEqual(s.docstring.trim(), '"""doc"""');
  });

  test('functionTextForExplain is signature + canonical body only', () => {
    const text = functionTextForExplain(SAMPLE);
    assert.ok(text.startsWith('def has_close_elements(numbers: List[float], threshold: float) -> bool:\n    for idx, elem'));
    assert.ok(text.endsWith('    return False\n'));
    assert.ok(!text.includes('Check if any two numbers'));
    assert.strictEqual(preambleForContext(SAMPLE), 'from typing import List');
  });

  test('extractPythonCode prefers the fenced block that defines the function', () => {
    const reply = 'Sure!\n```python\nprint(1)\n```\nAnd the real one:\n```py\nimport math\n\ndef has_close_elements(numbers, threshold):\n    return False\n```\nDone.';
    assert.strictEqual(extractPythonCode(reply, 'has_close_elements'), 'import math\n\ndef has_close_elements(numbers, threshold):\n    return False\n');
    // First fence when none defines it.
    assert.strictEqual(extractPythonCode('```\nx = 1\n```', 'f'), 'x = 1\n');
    // Bare code after prose.
    assert.strictEqual(extractPythonCode('Here you go:\nfrom typing import List\ndef f(a):\n    return a\n', 'f'), 'from typing import List\ndef f(a):\n    return a\n');
    assert.strictEqual(extractPythonCode('def f(a):\n    return a', 'f'), 'def f(a):\n    return a\n');
    // CRLF replies, a python3 tag, and an unclosed fence.
    assert.strictEqual(extractPythonCode('```python3\r\ndef f(a):\r\n    return a\r\n```\r\n', 'f'), 'def f(a):\n    return a\n');
    assert.strictEqual(extractPythonCode('```python\ndef f(a):\n    return a\n', 'f'), 'def f(a):\n    return a\n', 'an unclosed fence still yields the code after it');
    // A huge reply (a 2 MB fence) is handled quickly.
    const big = '```python\ndef f(a):\n' + '    a = a + 1\n'.repeat(150_000) + '    return a\n```';
    const t0 = Date.now();
    assert.ok(extractPythonCode(big, 'f').startsWith('def f(a):\n'));
    assert.ok(Date.now() - t0 < 5_000, 'extraction stays fast on a huge reply');
    // Nothing code-like.
    assert.strictEqual(extractPythonCode('I cannot do that.', 'f'), '');
    assert.strictEqual(extractPythonCode('', 'f'), '');
    assert.strictEqual(extractPythonCode(undefined as never, 'f'), '');
  });

  test('buildTestProgram layers prelude, prompt, code, test and check()', () => {
    const code = 'def has_close_elements(numbers, threshold):\n    return True\n';
    const prog = buildTestProgram(SAMPLE, code);
    const iPrelude = prog.indexOf(NO_NETWORK_PRELUDE.trim());
    const iPrompt = prog.indexOf('from typing import List');
    const iCode = prog.indexOf('    return True');
    const iTest = prog.indexOf('def check(candidate)');
    const iCheck = prog.indexOf('check(has_close_elements)');
    assert.ok(iPrelude >= 0 && iPrelude < iPrompt && iPrompt < iCode && iCode < iTest && iTest < iCheck, `order wrong: ${[iPrelude, iPrompt, iCode, iTest, iCheck]}`);
    assert.ok(prog.endsWith("print('EXPLAINIT_EVAL_PASS')\n"));
    assert.ok(!prog.includes('\r'));
  });

  test('pickSpread is deterministic and spread across the list', () => {
    const items = Array.from({ length: 164 }, (_, i) => i);
    assert.deepStrictEqual(pickSpread(items, 12), [0, 13, 27, 41, 54, 68, 82, 95, 109, 123, 136, 150]);
    assert.deepStrictEqual(pickSpread(items, 0), []);
    assert.deepStrictEqual(pickSpread([1, 2], 5), [1, 2]);
    assert.deepStrictEqual(pickSpread([], 3), []);
  });
});
