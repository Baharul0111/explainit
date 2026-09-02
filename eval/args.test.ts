import * as assert from 'node:assert';
import { DEFAULTS, USAGE, parseArgs } from './pure/args';

suite('eval/pure/args', () => {
  test('defaults', () => {
    assert.deepStrictEqual(parseArgs([]).args, DEFAULTS);
  });

  test('the documented invocation', () => {
    const r = parseArgs(['--channel', 'claude', '--n', '12', '--update-baseline']);
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.args!.channel, 'claude');
    assert.strictEqual(r.args!.n, 12);
    assert.strictEqual(r.args!.updateBaseline, true);
  });

  test('--key=value form, --only, --parallel, --timeout, --verbose, --help', () => {
    const r = parseArgs(['--channel=codex', '--n=3', '--only', 'flip', '--parallel=1', '--timeout', '300', '-v', '-h']);
    assert.strictEqual(r.error, undefined);
    assert.deepStrictEqual(r.args, { channel: 'codex', n: 3, updateBaseline: false, parallel: 1, timeoutSeconds: 300, verbose: true, help: true, only: 'flip' });
  });

  test('bad values give plain-English errors', () => {
    assert.match(parseArgs(['--channel', 'gpt']).error!, /--channel must be one of claude, codex, copilot, fake/);
    assert.match(parseArgs(['--channel']).error!, /--channel must be one of/);
    assert.match(parseArgs(['--n', 'many']).error!, /--n must be a whole number between 1 and 1000/);
    assert.match(parseArgs(['--n', '0']).error!, /--n must be/);
    assert.match(parseArgs(['--n']).error!, /--n needs a value/);
    assert.match(parseArgs(['--parallel', '99']).error!, /--parallel must be/);
    assert.match(parseArgs(['--timeout', '1']).error!, /--timeout must be/);
    assert.match(parseArgs(['--only']).error!, /--only needs a value/);
    assert.match(parseArgs(['--bogus']).error!, /Unknown option "--bogus"/);
    assert.match(parseArgs(['stray']).error!, /Unknown option "stray"/);
  });

  test('usage text mentions every option', () => {
    for (const opt of ['--channel', '--n', '--update-baseline', '--parallel', '--timeout', '--only', '--verbose']) assert.ok(USAGE.includes(opt), opt);
  });
});
