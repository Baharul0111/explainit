import * as assert from 'node:assert/strict';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const perf = require(path.join(REPO_ROOT, 'scripts', 'perf-report.js')) as {
  parsePerf(text: string): { name: string; ms: number }[];
  summarise(entries: { name: string; ms: number }[]): { name: string; count: number; min: number; max: number; avg: number; p95: number }[];
  applyBudgets(rows: ReturnType<typeof perf.summarise>, budgets: Record<string, number>): (ReturnType<typeof perf.summarise>[number] & { budget?: number; over: boolean })[];
  render(rows: ReturnType<typeof perf.applyBudgets>): string;
  percentile(sorted: number[], p: number): number;
  DEFAULT_BUDGETS: Record<string, number>;
};

suite('scripts/perf-report', () => {
  test('parsePerf recognises [perf], PERF and mocha markers and ignores the rest', () => {
    const text = [
      '[perf] twin open (cache hit): 42 ms',
      '[perf] first explanation = 1234.5ms',
      'PERF gate-panel 310ms',
      '  [32m✓[0m opens the twin beside the code (812ms)',
      '  ✓ fast test',
      'random line with 99 ms in it',
    ].join('\n');
    assert.deepEqual(perf.parsePerf(text), [
      { name: 'twin open (cache hit)', ms: 42 },
      { name: 'first explanation', ms: 1234.5 },
      { name: 'gate-panel', ms: 310 },
      { name: 'opens the twin beside the code', ms: 812 },
    ]);
    assert.deepEqual(perf.parsePerf(''), []);
  });

  test('percentile and summarise', () => {
    assert.equal(perf.percentile([], 95), 0);
    assert.equal(perf.percentile([5], 95), 5);
    assert.equal(perf.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
    assert.equal(perf.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
    const rows = perf.summarise([
      { name: 'b', ms: 10 },
      { name: 'a', ms: 300 },
      { name: 'b', ms: 30 },
      { name: 'b', ms: 20 },
      { name: 'c', ms: Number.NaN },
    ]);
    assert.deepEqual(rows, [
      { name: 'a', count: 1, min: 300, max: 300, avg: 300, p95: 300 },
      { name: 'b', count: 3, min: 10, max: 30, avg: 20, p95: 30 },
    ]);
  });

  test('applyBudgets matches by substring and flags p95 over budget', () => {
    const rows = perf.applyBudgets(
      perf.summarise([
        { name: 'Twin open (cache hit) app.py', ms: 250 },
        { name: 'Twin open (cache hit) app.py', ms: 900 },
        { name: 'first explanation streamed', ms: 3000 },
        { name: 'unbudgeted', ms: 1 },
      ]),
      perf.DEFAULT_BUDGETS,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(byName['Twin open (cache hit) app.py'].budget, 300);
    assert.equal(byName['Twin open (cache hit) app.py'].over, true);
    assert.equal(byName['first explanation streamed'].budget, 8000);
    assert.equal(byName['first explanation streamed'].over, false);
    assert.equal(byName['unbudgeted'].budget, undefined);
    assert.equal(byName['unbudgeted'].over, false);
  });

  test('render prints a table, budgets, and a clear empty state', () => {
    assert.match(perf.render([]), /no timing lines found/);
    const text = perf.render(perf.applyBudgets(perf.summarise([{ name: 'gate panel', ms: 700 }, { name: 'twin open (cache hit)', ms: 100 }]), perf.DEFAULT_BUDGETS));
    assert.match(text, /gate panel/);
    assert.match(text, /700 ms.*500 ms {2}OVER/);
    assert.match(text, /100 ms.*300 ms {2}ok/);
    assert.match(text, /1 budget\(s\) exceeded: gate panel/);
    const fine = perf.render(perf.applyBudgets(perf.summarise([{ name: 'gate panel', ms: 100 }]), perf.DEFAULT_BUDGETS));
    assert.match(fine, /all budgets met/);
  });
});
