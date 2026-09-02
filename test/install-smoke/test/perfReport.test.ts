import * as assert from 'node:assert/strict';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const perf = require(path.join(REPO_ROOT, 'scripts', 'perf-report.js')) as {
  parsePerf(text: string): { name: string; ms: number }[];
  summarise(entries: { name: string; ms: number }[]): { name: string; count: number; min: number; max: number; avg: number; p95: number }[];
  applyBudgets(rows: ReturnType<typeof perf.summarise>, budgets: Record<string, number>): (ReturnType<typeof perf.summarise>[number] & { budget?: number; over: boolean })[];
  render(rows: ReturnType<typeof perf.applyBudgets>): string;
  percentile(sorted: number[], p: number): number;
  loadBudgets(file: string): Record<string, number>;
  parseCliArgs(argv: string[]): { files: string[]; budgets: Record<string, number>; enforce: boolean; json: boolean; help: boolean };
  readInput(files: string[]): string;
  main(argv: string[]): number;
  DEFAULT_BUDGETS: Record<string, number>;
};
import * as fs from 'node:fs';
import * as os from 'node:os';

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

  test('bad budgets files and missing input files are plain-English errors, never stack traces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-perf-'));
    try {
      const budgets = path.join(dir, 'b.json');
      fs.writeFileSync(budgets, JSON.stringify({ 'gate panel': 250 }));
      assert.deepEqual(perf.loadBudgets(budgets), { 'gate panel': 250 });
      assert.deepEqual(perf.parseCliArgs(['--budgets', budgets, 'a.log', '--enforce']).budgets, { 'gate panel': 250 });
      assert.deepEqual(perf.parseCliArgs([`--budgets=${budgets}`]).budgets, { 'gate panel': 250 });
      fs.writeFileSync(budgets, '{oops');
      assert.throws(() => perf.loadBudgets(budgets), /not valid JSON/);
      fs.writeFileSync(budgets, '[1]');
      assert.throws(() => perf.loadBudgets(budgets), /must be an object/);
      fs.writeFileSync(budgets, JSON.stringify({ x: 'fast' }));
      assert.throws(() => perf.loadBudgets(budgets), /budget for "x" .* positive number/);
      fs.writeFileSync(budgets, JSON.stringify({ x: -1 }));
      assert.throws(() => perf.loadBudgets(budgets), /positive number/);
      assert.throws(() => perf.loadBudgets(path.join(dir, 'missing.json')), /cannot read the budgets file/);
      assert.throws(() => perf.parseCliArgs(['--budgets']), /--budgets needs a JSON file/);
      assert.throws(() => perf.parseCliArgs(['--wat']), /Unknown argument/);
      assert.throws(() => perf.readInput([path.join(dir, 'nope.log')]), /cannot read .*nope\.log/);
      const log = path.join(dir, 'it.log');
      fs.writeFileSync(log, '[perf] gate panel: 900 ms\n');
      assert.equal(perf.readInput([log]), '[perf] gate panel: 900 ms\n');
      // main: exit 2 on unreadable input, 1 with --enforce over budget, 0 otherwise.
      const silence = console.error;
      const quiet = console.log;
      console.error = () => {};
      console.log = () => {};
      try {
        assert.equal(perf.main([path.join(dir, 'nope.log')]), 2);
        assert.equal(perf.main([log, '--enforce']), 1);
        assert.equal(perf.main([log]), 0);
        assert.equal(perf.main(['--help']), 0);
      } finally {
        console.error = silence;
        console.log = quiet;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
