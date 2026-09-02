import * as assert from 'node:assert';
import { fileStamp, formatProblems, formatTable, pct, summarize, toChannelScore, type ProblemResult } from './pure/report';

function result(over: Partial<ProblemResult>): ProblemResult {
  return { taskId: 'HumanEval/0', entryPoint: 'has_close_elements', explainMs: 1200, styleOk: true, styleProblems: [], resynthCode: 'def f():\n    pass\n', resynthMs: 3400, passed: true, testMs: 250, ...over };
}

const HASH = 'f'.repeat(64);

suite('eval/pure/report', () => {
  test('summarize computes the scores and failure counts', () => {
    const results = [
      result({}),
      result({ taskId: 'HumanEval/1', entryPoint: 'b', passed: false, testError: 'AssertionError' }),
      result({ taskId: 'HumanEval/2', entryPoint: 'c', styleOk: false, styleProblems: ['The summary does not end with a period.'] }),
      result({ taskId: 'HumanEval/3', entryPoint: 'd', explainError: 'Claude Code is not signed in', passed: false, styleOk: false }),
      result({ taskId: 'HumanEval/4', entryPoint: 'e', resynthError: 'no code', passed: false }),
    ];
    const s = summarize('claude', HASH, '2026-09-02T08:00:00.000Z', results, 12345, 'claude path 1ms');
    assert.strictEqual(s.n, 5);
    assert.strictEqual(s.passAt1, 2 / 5);
    assert.strictEqual(s.style, 3 / 5);
    assert.strictEqual(s.explainFailures, 1);
    assert.strictEqual(s.resynthFailures, 1);
    assert.deepStrictEqual(toChannelScore(s), { passAt1: 2 / 5, style: 3 / 5, n: 5, ranAt: '2026-09-02T08:00:00.000Z' });
  });

  test('summarize with no results gives zero scores, not NaN', () => {
    const s = summarize('fake', HASH, '2026-09-02T08:00:00.000Z', [], 0);
    assert.strictEqual(s.passAt1, 0);
    assert.strictEqual(s.style, 0);
    assert.ok(formatTable(s).includes('(no problems were run)'));
  });

  test('formatTable has a header, one row per problem, and the score line', () => {
    const s = summarize('codex', HASH, '2026-09-02T08:00:00.000Z', [result({}), result({ taskId: 'HumanEval/13', entryPoint: 'greatest_common_divisor', passed: false, testError: 'boom', resynthMs: 15000 })], 20000);
    const text = formatTable(s);
    const lines = text.split('\n');
    assert.ok(/^task\s+function\s+explain\s+style\s+resynth\s+tests\s+time$/.test(lines[0]), lines[0]);
    assert.ok(/^-+(\s+-+)+$/.test(lines[1]));
    assert.ok(/^HumanEval\/0\s+has_close_elements\s+ok\s+ok\s+ok\s+pass\s+[\d.]+s?m?s$/.test(lines[2]), lines[2]);
    assert.ok(/^HumanEval\/13\s+greatest_common_divisor\s+ok\s+ok\s+ok\s+FAIL\s+16\.[\d]s$/.test(lines[3]), lines[3]);
    assert.ok(text.includes('channel: codex   n: 2   pass@1: 50.0%   style: 100.0%   total: 20.0s'));
    assert.ok(text.includes(`prompt hash: ${'f'.repeat(12)}…`));
    assert.ok(!text.includes('errors:'));
    // Every row has the same width (columns line up).
    const widths = new Set(lines.slice(0, 4).map((l) => l.length));
    assert.strictEqual(widths.size, 1, `row widths differ: ${[...widths].join(',')}`);
  });

  test('formatTable marks errors and truncates long names', () => {
    const s = summarize('claude', HASH, '2026-09-02T08:00:00.000Z', [result({ entryPoint: 'a_very_long_function_name_that_keeps_going', explainError: 'x', resynthCode: undefined, passed: false, styleOk: false })], 5);
    const text = formatTable(s);
    assert.ok(text.includes('a_very_long_function_name…'));
    assert.ok(/error\s+no\s+-\s+FAIL/.test(text));
    assert.ok(text.includes('errors: 1 explain, 0 resynth'));
  });

  test('formatProblems lists only the problems that had something to say', () => {
    const s = summarize('claude', HASH, '2026-09-02T08:00:00.000Z', [
      result({}),
      result({ taskId: 'HumanEval/1', entryPoint: 'b', passed: false, testError: 'AssertionError at line 3' }),
      result({ taskId: 'HumanEval/2', entryPoint: 'c', styleOk: false, styleProblems: ['Uses banned jargon: parse.'] }),
    ], 1);
    const text = formatProblems(s);
    assert.ok(!text.includes('HumanEval/0'));
    assert.ok(text.includes('HumanEval/1 (b)\n  tests: AssertionError at line 3'));
    assert.ok(text.includes('HumanEval/2 (c)\n  style: Uses banned jargon: parse.'));
    assert.strictEqual(formatProblems(summarize('claude', HASH, 'x', [result({})], 1)), '');
  });

  test('pct and fileStamp', () => {
    assert.strictEqual(pct(0.91666), '91.7%');
    assert.strictEqual(pct(1), '100.0%');
    const stamp = fileStamp(new Date('2026-09-02T08:30:15.123Z'));
    assert.strictEqual(stamp, '2026-09-02T08-30-15Z');
    assert.ok(!/[:*?"<>|]/.test(stamp), 'must be a valid Windows file name');
  });
});
