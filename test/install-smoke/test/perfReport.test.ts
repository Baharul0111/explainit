import * as assert from 'node:assert/strict';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const perf = require(path.join(REPO_ROOT, 'scripts', 'perf-report.js')) as {
  parsePerf(text: string): { name: string; ms: number; source: 'perf' | 'mocha' }[];
  summarise(entries: { name: string; ms: number; source?: 'perf' | 'mocha' }[]): { name: string; count: number; min: number; max: number; avg: number; p95: number; source: 'perf' | 'mocha' }[];
  applyBudgets(rows: ReturnType<typeof perf.summarise>, budgets: Record<string, number>): (ReturnType<typeof perf.summarise>[number] & { budget?: number; over: boolean })[];
  render(rows: ReturnType<typeof perf.applyBudgets>): string;
  percentile(sorted: number[], p: number): number;
  loadBudgets(file: string): Record<string, number>;
  parseCliArgs(argv: string[]): { files: string[]; budgets: Record<string, number>; enforce: boolean; json: boolean; help: boolean };
  readInput(files: string[]): string;
  enforcement(rows: ReturnType<typeof perf.applyBudgets>): { code: number; message: string };
  main(argv: string[]): number;
  DEFAULT_BUDGETS: Record<string, number>;
  NO_TIMING_MESSAGE: string;
};
import * as fs from 'node:fs';
import * as os from 'node:os';

/** Run main() with console output captured. */
function runMain(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  try {
    return { code: perf.main(argv), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

suite('scripts/perf-report', () => {
  test('parsePerf recognises [perf], PERF and mocha markers, tags their source, and ignores the rest', () => {
    const text = [
      '[perf] twin open (cache hit): 42 ms',
      '[perf] first explanation = 1234.5ms',
      'PERF gate-panel 310ms',
      '  \x1b[32m✓\x1b[0m opens the twin beside the code (812ms)',
      '  ✓ fast test',
      'random line with 99 ms in it',
    ].join('\n');
    assert.deepEqual(perf.parsePerf(text), [
      { name: 'twin open (cache hit)', ms: 42, source: 'perf' },
      { name: 'first explanation', ms: 1234.5, source: 'perf' },
      { name: 'gate-panel', ms: 310, source: 'perf' },
      { name: 'opens the twin beside the code', ms: 812, source: 'mocha' },
    ]);
    assert.deepEqual(perf.parsePerf(''), []);
  });

  test('parsePerf reads what the integration tests really print (mocha spec reporter with colours, CRLF, nested indentation)', () => {
    const text = [
      '  twin engine (integration)',
      '    \x1b[32m  ✓\x1b[0m\x1b[90m naming: stem form, full-filename form on collision, inverse lookup\x1b[0m',
      '    \x1b[32m  ✓\x1b[0m\x1b[90m performance: a cached twin opens through the fast path in under 300 ms without a model call\x1b[0m\x1b[31m (812ms)\x1b[0m',
      '    ✓ performance: the provisional twin with "(explaining...)" is written within 1 s of opening (2431ms)',
      '  12 passing (1m)',
    ].join('\r\n');
    const got = perf.parsePerf(text);
    assert.deepEqual(got, [
      { name: 'performance: a cached twin opens through the fast path in under 300 ms without a model call', ms: 812, source: 'mocha' },
      { name: 'performance: the provisional twin with "(explaining...)" is written within 1 s of opening', ms: 2431, source: 'mocha' },
    ]);
    // Whole-test durations are informational: a 812 ms cached-twin TEST is not a 300 ms budget breach.
    const rows = perf.applyBudgets(perf.summarise(got), perf.DEFAULT_BUDGETS);
    assert.ok(rows.every((r) => r.budget === undefined && r.over === false), JSON.stringify(rows));
    assert.equal(perf.enforcement(rows).code, 0);
    assert.equal(perf.enforcement(rows).message, perf.NO_TIMING_MESSAGE);
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
      { name: 'a', count: 1, min: 300, max: 300, avg: 300, p95: 300, source: 'perf' },
      { name: 'b', count: 3, min: 10, max: 30, avg: 20, p95: 30, source: 'perf' },
    ]);
    // A name seen as an explicit line and as a mocha marker is budgeted.
    const mixed = perf.summarise([
      { name: 'x', ms: 1, source: 'mocha' },
      { name: 'x', ms: 2, source: 'perf' },
      { name: 'y', ms: 3, source: 'mocha' },
    ]);
    assert.deepEqual(mixed.map((r) => [r.name, r.source]), [
      ['x', 'perf'],
      ['y', 'mocha'],
    ]);
  });

  test('applyBudgets matches by substring and flags p95 over budget (explicit lines only)', () => {
    const rows = perf.applyBudgets(
      perf.summarise([
        { name: 'Twin open (cache hit) app.py', ms: 250 },
        { name: 'Twin open (cache hit) app.py', ms: 900 },
        { name: 'first explanation streamed', ms: 3000 },
        { name: 'unbudgeted', ms: 1 },
        { name: 'gate panel shown', ms: 9000, source: 'mocha' },
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
    assert.equal(byName['gate panel shown'].budget, undefined, 'a mocha duration is never budgeted');
    assert.equal(byName['gate panel shown'].over, false);
  });

  test('the documented budgets are the defaults: cached twin 300 ms, provisional twin 1 s, gate panel 500 ms', () => {
    assert.equal(perf.DEFAULT_BUDGETS['cached twin'], 300);
    assert.equal(perf.DEFAULT_BUDGETS['provisional twin'], 1000);
    assert.equal(perf.DEFAULT_BUDGETS['gate panel'], 500);
    const rows = perf.applyBudgets(
      perf.summarise(
        perf.parsePerf(['[perf] cached twin open: 120 ms', '[perf] cached twin open: 310 ms', '[perf] provisional twin written: 640 ms', '[perf] gate panel shown: 480 ms', '[perf] review panel first paint: 900 ms'].join('\n')),
      ),
      perf.DEFAULT_BUDGETS,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(byName['cached twin open'].budget, 300);
    assert.equal(byName['cached twin open'].over, true, 'p95 of [120, 310] is 310');
    assert.equal(byName['provisional twin written'].budget, 1000);
    assert.equal(byName['provisional twin written'].over, false);
    assert.equal(byName['gate panel shown'].budget, 500);
    assert.equal(byName['gate panel shown'].over, false);
    assert.equal(byName['review panel first paint'].budget, 500);
    assert.equal(byName['review panel first paint'].over, true);
    const v = perf.enforcement(rows);
    assert.equal(v.code, 1);
    assert.match(v.message, /FAIL - 2 budget\(s\) exceeded: cached twin open p95 310 ms > 300 ms; review panel first paint p95 900 ms > 500 ms/);
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
      assert.equal(runMain([path.join(dir, 'nope.log')]).code, 2);
      const over = runMain([log, '--enforce']);
      assert.equal(over.code, 1);
      assert.match(over.err, /FAIL - 1 budget\(s\) exceeded: gate panel p95 900 ms > 500 ms/);
      assert.equal(runMain([log]).code, 0);
      assert.equal(runMain(['--help']).code, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--enforce on output without [perf] lines is a no-op that says so and exits 0 (mocha durations alone never fail the build)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-perf-'));
    try {
      const log = path.join(dir, 'integration.log');
      fs.writeFileSync(log, '  twin engine (integration)\n    ✓ performance: a cached twin opens through the fast path in under 300 ms without a model call (812ms)\n    ✓ gate panel opens (700ms)\n  2 passing (3s)\n');
      const r = runMain([log, '--enforce']);
      assert.equal(r.code, 0);
      assert.match(r.out, /nothing to enforce/);
      assert.match(r.out, /cached twin < 300 ms, provisional twin < 1 s, gate panel < 500 ms/);
      assert.match(r.out, /mocha test duration, not budgeted/);
      assert.equal(r.err, '');
      // Completely empty output is a no-op too.
      fs.writeFileSync(log, '');
      const empty = runMain([log, '--enforce']);
      assert.equal(empty.code, 0);
      assert.match(empty.out, /no timing lines found/);
      assert.match(empty.out, /nothing to enforce/);
      // One explicit line within budget: OK, exit 0, no no-op message.
      fs.writeFileSync(log, '[perf] gate panel: 120 ms\n');
      const ok = runMain([log, '--enforce']);
      assert.equal(ok.code, 0);
      assert.match(ok.out, /OK - 1 budgeted timing\(s\) within budget/);
      assert.doesNotMatch(ok.out, /nothing to enforce/);
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
    const mochaOnly = perf.render(perf.applyBudgets(perf.summarise([{ name: 'gate panel test', ms: 100, source: 'mocha' }]), perf.DEFAULT_BUDGETS));
    assert.match(mochaOnly, /no budgeted \[perf\] lines \(mocha durations are informational\)/);
    assert.doesNotMatch(mochaOnly, /OVER/);
  });
});
