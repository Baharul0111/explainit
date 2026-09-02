/**
 * The sandboxed Python runner. Skips (does not fail) when no Python 3 is installed, so the unit
 * suite still passes on a bare CI box; the eval itself reports the missing interpreter clearly.
 */
import * as assert from 'node:assert';
import { buildTestProgram, type HumanEvalProblem } from './pure/humaneval';
import { findPython, pythonMissingMessage, runPythonProgram, stderrTail } from './python';

const PROBLEM: HumanEvalProblem = {
  task_id: 'HumanEval/13',
  entry_point: 'greatest_common_divisor',
  prompt: '\n\ndef greatest_common_divisor(a: int, b: int) -> int:\n    """ Return a greatest common divisor of two integers a and b\n    """\n',
  canonical_solution: '    while b:\n        a, b = b, a % b\n    return a\n',
  test: '\n\ndef check(candidate):\n    assert candidate(3, 7) == 1\n    assert candidate(10, 15) == 5\n    assert candidate(49, 14) == 7\n',
};

suite('eval/python', function () {
  this.timeout(60_000);
  let available = false;

  suiteSetup(async () => {
    available = !!(await findPython());
  });

  test('a correct solution passes', async function () {
    if (!available) return this.skip();
    const r = await runPythonProgram(buildTestProgram(PROBLEM, 'def greatest_common_divisor(a, b):\n    while b:\n        a, b = b, a % b\n    return a\n'));
    assert.strictEqual(r.passed, true, r.stderr);
    assert.ok(r.stdout.includes('EXPLAINIT_EVAL_PASS'));
    assert.strictEqual(r.timedOut, false);
  });

  test('a wrong solution fails with the assertion in stderr', async function () {
    if (!available) return this.skip();
    const r = await runPythonProgram(buildTestProgram(PROBLEM, 'def greatest_common_divisor(a, b):\n    return 1\n'));
    assert.strictEqual(r.passed, false);
    assert.ok(/AssertionError/.test(r.stderr), r.stderr);
    assert.ok(!r.stdout.includes('EXPLAINIT_EVAL_PASS'));
  });

  test('a syntax error fails without crashing the runner', async function () {
    if (!available) return this.skip();
    const r = await runPythonProgram(buildTestProgram(PROBLEM, 'def greatest_common_divisor(a, b)\n    return 1\n'));
    assert.strictEqual(r.passed, false);
    assert.ok(/SyntaxError/.test(r.stderr));
  });

  test('an endless loop is stopped by the timeout', async function () {
    if (!available) return this.skip();
    const r = await runPythonProgram(buildTestProgram(PROBLEM, 'def greatest_common_divisor(a, b):\n    while True:\n        pass\n'), { timeoutMs: 1500 });
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.timedOut, true);
    assert.ok(/stopped after/.test(r.stderr));
  });

  test('network access is blocked inside the program', async function () {
    if (!available) return this.skip();
    const code = 'def greatest_common_divisor(a, b):\n    import socket\n    socket.socket()\n    return 1\n';
    const r = await runPythonProgram(buildTestProgram(PROBLEM, code));
    assert.strictEqual(r.passed, false);
    assert.ok(/network access is disabled/.test(r.stderr), r.stderr);
  });

  test('a program that floods stdout and stderr is capped, not buffered without limit', async function () {
    if (!available) return this.skip();
    const code = "def greatest_common_divisor(a, b):\n    import sys\n    for _ in range(2000):\n        sys.stdout.write('x' * 1000 + '\\n')\n        sys.stderr.write('y' * 1000 + '\\n')\n    return 1\n";
    const r = await runPythonProgram(buildTestProgram(PROBLEM, code));
    assert.strictEqual(r.passed, false);
    assert.ok(r.stdout.length <= 2 * 64 * 1024, `stdout was ${r.stdout.length} chars`);
    assert.ok(r.stderr.length <= 2 * 64 * 1024, `stderr was ${r.stderr.length} chars`);
    assert.ok(!r.stdout.includes('EXPLAINIT_EVAL_PASS'));
  });

  test('several programs can run at the same time without sharing a temp folder', async function () {
    if (!available) return this.skip();
    const good = 'def greatest_common_divisor(a, b):\n    while b:\n        a, b = b, a % b\n    return a\n';
    const bad = 'def greatest_common_divisor(a, b):\n    return 1\n';
    const runs = await Promise.all([good, bad, good, bad].map((c) => runPythonProgram(buildTestProgram(PROBLEM, c))));
    assert.deepStrictEqual(runs.map((r) => r.passed), [true, false, true, false]);
  });

  test('a missing interpreter is reported in plain English', async () => {
    const r = await runPythonProgram('print(1)', { python: { path: 'explainit-no-such-python-xyz', version: '3' } });
    assert.strictEqual(r.passed, false);
    assert.ok(/was not found/.test(r.stderr), r.stderr);
    assert.ok(pythonMissingMessage().includes('Install Python 3'));
  });

  test('stderrTail keeps the end', () => {
    assert.strictEqual(stderrTail('  short\r\n'), 'short');
    const long = 'x'.repeat(500) + 'END';
    const t = stderrTail(long, 50);
    assert.ok(t.startsWith('…') && t.endsWith('END') && t.length === 51);
  });
});
