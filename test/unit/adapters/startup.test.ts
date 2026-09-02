import * as assert from 'node:assert';
import type { IntegrityReport } from '../../../src/core/interfaces';
import { createLogger } from '../../../src/core/log';
import { verifyAndRearmAtStartup } from '../../../src/adapters/startup';

const ok: IntegrityReport = { ok: true, checks: [{ name: 'Claude Code hook', ok: true, detail: 'fine' }] };
const bad: IntegrityReport = { ok: false, checks: [{ name: 'Claude Code hook script', ok: false, fixable: true, detail: 'The hook script was changed.' }] };

function fakeAdapters(first: IntegrityReport | Error, afterRearm: IntegrityReport | Error = ok) {
  const calls = { verify: 0, rearm: 0 };
  return {
    calls,
    adapters: {
      verifyIntegrity: async () => {
        calls.verify++;
        if (first instanceof Error) throw first;
        return first;
      },
      rearm: async () => {
        calls.rearm++;
        if (afterRearm instanceof Error) throw afterRearm;
        return afterRearm;
      },
    },
  };
}

function capturingLogger() {
  const lines: string[] = [];
  return { lines, logger: createLogger([{ write: (l) => lines.push(l) }], 'test', 'debug') };
}

suite('adapters/startup verifyAndRearmAtStartup', () => {
  test('healthy install: verify once, never rearm', async () => {
    const f = fakeAdapters(ok);
    const { logger, lines } = capturingLogger();
    const r = await verifyAndRearmAtStartup(f.adapters, logger);
    assert.deepStrictEqual(r, ok);
    assert.strictEqual(f.calls.verify, 1);
    assert.strictEqual(f.calls.rearm, 0);
    assert.ok(lines.some((l) => /verified/.test(l)));
  });

  test('tampered install: rearm exactly once and return the after-report, logging before and after', async () => {
    const f = fakeAdapters(bad, ok);
    const { logger, lines } = capturingLogger();
    const r = await verifyAndRearmAtStartup(f.adapters, logger);
    assert.deepStrictEqual(r, ok);
    assert.strictEqual(f.calls.verify, 1);
    assert.strictEqual(f.calls.rearm, 1);
    assert.ok(lines.some((l) => /re-arming/.test(l) && /hook script was changed/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /re-armed/.test(l)), lines.join('\n'));
  });

  test('problems that rearm cannot fix are reported, not hidden', async () => {
    const stillBad: IntegrityReport = { ok: false, checks: [{ name: 'Codex hook trust', ok: false, fixable: false, detail: 'Not trusted yet.' }] };
    const f = fakeAdapters(bad, stillBad);
    const { logger, lines } = capturingLogger();
    const r = await verifyAndRearmAtStartup(f.adapters, logger);
    assert.deepStrictEqual(r, stillBad);
    assert.strictEqual(f.calls.rearm, 1);
    assert.ok(lines.some((l) => /remain/.test(l) && /Not trusted yet/.test(l)));
  });

  test('never throws: a crashing verify yields one failing check, a crashing rearm yields the before-report', async () => {
    const { logger } = capturingLogger();
    const crashVerify = fakeAdapters(new Error('disk on fire'));
    const r1 = await verifyAndRearmAtStartup(crashVerify.adapters, logger);
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.checks.length, 1);
    assert.match(r1.checks[0].detail ?? '', /disk on fire/);
    assert.strictEqual(crashVerify.calls.rearm, 0);
    const crashRearm = fakeAdapters(bad, new Error('no permission'));
    const r2 = await verifyAndRearmAtStartup(crashRearm.adapters, logger);
    assert.deepStrictEqual(r2, bad);
    assert.strictEqual(crashRearm.calls.rearm, 1);
  });
});
