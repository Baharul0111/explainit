import * as assert from 'node:assert/strict';
import * as sinon from 'sinon';
import {
  applyAllFixes,
  checkAssistants,
  checkChannels,
  checkCodexTrust,
  checkConsent,
  checkDiskSpace,
  checkGateHealth,
  checkGateListening,
  checkGitExclude,
  checkHookIntegrity,
  checkHookWiring,
  checkInstructions,
  checkJournal,
  checkRestore,
  checkSessionFile,
  checkWatchdog,
  runDoctorChecks,
  shortFolder,
  type DoctorDeps,
} from '../../../src/ux/pure/doctorChecks';
import type { DoctorReport } from '../../../src/core/interfaces';

const FOLDER = '/ws/project';

function healthyDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  const fixes = {
    runOnboarding: sinon.stub().resolves(),
    installHook: sinon.stub().resolves(),
    rearm: sinon.stub().resolves(),
    addGitExclude: sinon.stub().resolves(),
    updateInstructions: sinon.stub().resolves(),
    resumeCheckpoint: sinon.stub().resolves(),
    resetWatchdog: sinon.stub().resolves(),
  };
  return {
    consentGranted: () => true,
    detect: async () => [
      { agent: 'claude', present: true, ready: true, location: '/ext/anthropic.claude-code/resources/native-binary/claude' },
      { agent: 'codex', present: true, ready: true, location: '/usr/local/bin/codex' },
      { agent: 'copilot', present: false },
    ],
    channels: async () => [
      { channel: 'copilot', available: false, reason: 'Copilot not installed' },
      { channel: 'claude', available: true },
      { channel: 'codex', available: true },
    ],
    gateInfo: () => ({ pid: 4242, port: 51000, token: 'x', folders: [FOLDER], startedAt: 'now', version: '0.1.0' }),
    gatePaused: () => false,
    healthProbe: async () => ({ ok: true, version: '0.1.0', paused: false, pid: 4242 }),
    readSessionFile: async () => ({ pid: 4242, port: 51000, token: 'x', folders: [FOLDER], startedAt: 'now', version: '0.1.0' }),
    verifyIntegrity: async () => ({
      ok: true,
      checks: [
        { name: 'claude script hash', ok: true },
        { name: 'claude settings entry', ok: true },
        { name: 'codex script hash', ok: true },
        { name: 'codex hooks.json entry', ok: true },
        { name: 'hook script', ok: true },
      ],
    }),
    adapterStates: async () => [
      { agent: 'claude', installed: true, armed: true },
      { agent: 'codex', installed: true, armed: true },
    ],
    codexConfigText: async () => '[hooks.state]\n"explainit-hook.sh --agent codex" = "trusted"\n',
    hookLiveTest: async () => ({ answered: true, decision: 'allow' }),
    folders: [FOLDER],
    kits: [
      {
        folder: FOLDER,
        verifyChain: async () => ({ ok: true, entries: 12 }),
        selfTest: async () => ({ ok: true, detail: 'round trip ok' }),
      },
    ],
    gitExcludeText: async () => '*_explain.txt\n',
    instructionFiles: async () => [
      { agent: 'claude', file: 'CLAUDE.md', text: '<!-- explainit:start -->\nx\n<!-- explainit:end -->' },
      { agent: 'codex', file: 'AGENTS.md', text: '<!-- explainit:start -->\nx\n<!-- explainit:end -->' },
      { agent: 'copilot', file: '.github/copilot-instructions.md', text: '<!-- explainit:start -->\nx\n<!-- explainit:end -->' },
    ],
    sectionText: () => '<!-- explainit:start -->\nx\n<!-- explainit:end -->',
    watchdogSeconds: 120,
    freeBytes: async () => 10 * 1024 ** 3,
    checkpointsMaxTotalMB: 200,
    fixes,
    checkTimeoutMs: 500,
    liveTestTimeoutMs: 500,
    now: () => new Date('2026-09-02T00:00:00Z'),
    ...over,
  };
}

suite('ux/pure/doctorChecks', () => {
  test('a healthy setup yields an all-ok report with at least 10 checks in a fixed order', async () => {
    const r = await runDoctorChecks(healthyDeps());
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.ok(r.checks.length >= 10, `only ${r.checks.length} checks`);
    assert.equal(r.ranAt, '2026-09-02T00:00:00.000Z');
    const names = r.checks.map((c) => c.name);
    assert.equal(names[0], 'Permission to use your assistants');
    assert.ok(names.includes('Claude Code checkpoint hook'));
    assert.ok(names.includes('Codex checkpoint hook'));
    assert.ok(names.includes('Codex trusts the ExplainIT hook'));
    assert.ok(names.includes('Hook wiring live test'));
    assert.ok(names.some((n) => n.startsWith('Restore point self-test')));
    assert.ok(names.some((n) => n.startsWith('Change journal intact')));
    assert.ok(names.some((n) => n.startsWith('Twins kept out of git')));
    for (const c of r.checks) {
      assert.ok(c.detail.length > 10, `${c.name} needs a detail`);
      assert.ok(!c.detail.includes('undefined'), `${c.name}: ${c.detail}`);
    }
  });

  test('assistants check names the VS Code extension path', async () => {
    const c = await checkAssistants(healthyDeps());
    assert.equal(c.ok, true);
    assert.ok(c.detail.includes('anthropic.claude-code'));
    assert.ok(c.detail.includes('Copilot: not found'));
  });

  test('consent missing -> not ok with a setup fix', async () => {
    const d = healthyDeps({ consentGranted: () => false });
    const c = checkConsent(d);
    assert.equal(c.ok, false);
    assert.equal(c.fix?.label, 'Run setup');
    await c.fix!.run();
    sinon.assert.calledOnce(d.fixes.runOnboarding as sinon.SinonStub);
  });

  test('no assistant found -> not ok and offers setup', async () => {
    const d = healthyDeps({ detect: async () => [{ agent: 'claude', present: false, detail: 'not on PATH' }], channels: async () => [{ channel: 'claude', available: false, reason: 'missing' }] });
    const a = await checkAssistants(d);
    const ch = await checkChannels(d);
    assert.equal(a.ok, false);
    assert.ok(a.fix);
    assert.equal(ch.ok, false);
    assert.ok(ch.detail.includes('missing'));
  });

  test('gate not running -> listening/health/session/live checks fail without fixes', async () => {
    const d = healthyDeps({ gateInfo: () => undefined });
    assert.equal(checkGateListening(d).ok, false);
    assert.equal((await checkGateHealth(d)).ok, false);
    assert.equal((await checkSessionFile(d)).ok, false);
    const w = await checkHookWiring(d);
    assert.equal(w.ok, false);
    assert.equal(w.fix, undefined);
  });

  test('paused gate -> not ok with a resume fix (listening and live test)', async () => {
    const d = healthyDeps({ gatePaused: () => true });
    const l = checkGateListening(d);
    assert.equal(l.ok, false);
    assert.equal(l.fix?.label, 'Resume the checkpoint');
    const w = await checkHookWiring(d);
    assert.equal(w.ok, false);
    assert.equal(w.fix?.label, 'Resume the checkpoint');
  });

  test('health probe failing / wrong pid', async () => {
    const bad = await checkGateHealth(healthyDeps({ healthProbe: async () => ({ ok: false, error: 'ECONNREFUSED' }) }));
    assert.equal(bad.ok, false);
    assert.ok(bad.detail.includes('ECONNREFUSED'));
    const wrongPid = await checkGateHealth(healthyDeps({ healthProbe: async () => ({ ok: true, pid: 1 }) }));
    assert.equal(wrongPid.ok, false);
    assert.ok(wrongPid.detail.includes('answering process is 1'));
  });

  test('session file missing or with a different port', async () => {
    const missing = await checkSessionFile(healthyDeps({ readSessionFile: async () => undefined }));
    assert.equal(missing.ok, false);
    const wrong = await checkSessionFile(healthyDeps({ readSessionFile: async () => ({ pid: 4242, port: 1, token: '', folders: [], startedAt: '', version: '' }) }));
    assert.equal(wrong.ok, false);
    assert.ok(wrong.detail.includes('port 1'));
  });

  test('hook integrity: tampered -> re-arm fix; not installed but present -> install fix; not present -> ok', async () => {
    const tampered = healthyDeps({
      verifyIntegrity: async () => ({ ok: false, checks: [{ name: 'claude script hash', ok: false, detail: 'hash mismatch', fixable: true }, { name: 'codex hooks.json entry', ok: true }] }),
    });
    const [claude, codex] = await checkHookIntegrity(tampered);
    assert.equal(claude.ok, false);
    assert.equal(claude.fix?.label, 'Re-arm the hooks');
    assert.ok(claude.detail.includes('hash mismatch'));
    assert.equal(codex.ok, true);

    const notInstalled = healthyDeps({ adapterStates: async () => [{ agent: 'claude', installed: false, armed: false }], verifyIntegrity: async () => ({ ok: true, checks: [] }) });
    const [c2, x2] = await checkHookIntegrity(notInstalled);
    assert.equal(c2.ok, false);
    assert.equal(c2.fix?.label, 'Install the Claude Code hook');
    await c2.fix!.run();
    sinon.assert.calledWith(notInstalled.fixes.installHook as sinon.SinonStub, 'claude');
    assert.equal(x2.ok, false, 'codex present but no state -> install');

    const absent = healthyDeps({ detect: async () => [{ agent: 'claude', present: false }, { agent: 'codex', present: false }], adapterStates: async () => [], verifyIntegrity: async () => ({ ok: true, checks: [] }) });
    const [c3, x3] = await checkHookIntegrity(absent);
    assert.equal(c3.ok, true);
    assert.equal(x3.ok, true);
    assert.ok(c3.detail.includes('not installed on this computer'));
  });

  test('hook integrity: present, not installed, adapter reports an informational "not connected" line -> install fix (not re-arm)', async () => {
    // The real adapter emits `{ name: 'Claude Code hook', ok: true, detail: 'Not connected...' }` for an agent
    // that is present but never connected; that line must not be mistaken for an installed hook.
    const d = healthyDeps({
      adapterStates: async () => [{ agent: 'claude', installed: false, armed: false }, { agent: 'codex', installed: true, armed: true }],
      verifyIntegrity: async () => ({ ok: true, checks: [{ name: 'Claude Code hook', ok: true, detail: 'Not connected. Run "ExplainIT: Connect Claude Code" to arm the checkpoint.' }, { name: 'Codex hook script', ok: true }] }),
    });
    const [claude, codex] = await checkHookIntegrity(d);
    assert.equal(claude.ok, false);
    assert.equal(claude.fix?.label, 'Install the Claude Code hook');
    assert.ok(claude.detail.includes('not installed'));
    assert.equal(codex.ok, true);
  });

  test('hook integrity: installed but not armed -> re-arm fix', async () => {
    const d = healthyDeps({ adapterStates: async () => [{ agent: 'claude', installed: true, armed: false, notes: ['restart Claude Code'] }, { agent: 'codex', installed: true, armed: true }] });
    const [claude] = await checkHookIntegrity(d);
    assert.equal(claude.ok, false);
    assert.equal(claude.fix?.label, 'Re-arm the hooks');
    assert.ok(claude.detail.includes('restart Claude Code'));
  });

  test('codex trust states', async () => {
    assert.equal((await checkCodexTrust(healthyDeps())).ok, true);
    const noConfig = await checkCodexTrust(healthyDeps({ codexConfigText: async () => undefined }));
    assert.equal(noConfig.ok, false);
    assert.ok(noConfig.detail.includes('trust'));
    const untrusted = await checkCodexTrust(healthyDeps({ codexConfigText: async () => '[hooks.state]\nexplainit = false\n' }));
    assert.equal(untrusted.ok, false);
    const noRecord = await checkCodexTrust(healthyDeps({ codexConfigText: async () => '[hooks.state]\nother = "trusted"\n' }));
    assert.equal(noRecord.ok, false);
    const absent = await checkCodexTrust(healthyDeps({ detect: async () => [{ agent: 'codex', present: false }], adapterStates: async () => [] }));
    assert.equal(absent.ok, true);
    const notInstalled = await checkCodexTrust(healthyDeps({ adapterStates: async () => [{ agent: 'codex', installed: false, armed: false }] }));
    assert.equal(notInstalled.ok, false);
    assert.equal(notInstalled.fix?.label, 'Install the Codex hook');
  });

  test('hook wiring: answered -> ok; no answer -> re-arm fix; no folder -> skipped', async () => {
    const ok = await checkHookWiring(healthyDeps());
    assert.equal(ok.ok, true);
    assert.ok(ok.detail.includes('allow'));
    const bad = await checkHookWiring(healthyDeps({ hookLiveTest: async () => ({ answered: false, problem: 'printed nothing' }) }));
    assert.equal(bad.ok, false);
    assert.ok(bad.detail.includes('printed nothing'));
    assert.equal(bad.fix?.label, 'Re-arm the hooks');
    const none = await checkHookWiring(healthyDeps({ folders: [] }));
    assert.equal(none.ok, false);
    assert.ok(none.detail.includes('Skipped'));
  });

  test('journal and restore self-test per kit', async () => {
    const good = healthyDeps().kits[0];
    assert.equal((await checkJournal(good)).ok, true);
    assert.equal((await checkRestore(good)).ok, true);
    const empty = await checkJournal({ ...good, verifyChain: async () => ({ ok: true, entries: 0 }) });
    assert.ok(empty.detail.includes('empty'));
    const broken = await checkJournal({ ...good, verifyChain: async () => ({ ok: false, entries: 5, brokenAt: 3, detail: 'hash mismatch' }) });
    assert.equal(broken.ok, false);
    assert.ok(broken.detail.includes('entry 3'));
    const failed = await checkRestore({ ...good, selfTest: async () => ({ ok: false, detail: 'EACCES' }) });
    assert.equal(failed.ok, false);
    assert.ok(failed.detail.includes('EACCES'));
    assert.ok(failed.name.includes(shortFolder(FOLDER)));
  });

  test('git exclude: present, missing (fix), not a repo', async () => {
    assert.equal((await checkGitExclude(FOLDER, healthyDeps())).ok, true);
    const d = healthyDeps({ gitExcludeText: async () => '' });
    const missing = await checkGitExclude(FOLDER, d);
    assert.equal(missing.ok, false);
    await missing.fix!.run();
    sinon.assert.calledWith(d.fixes.addGitExclude as sinon.SinonStub, FOLDER);
    const noGit = await checkGitExclude(FOLDER, healthyDeps({ gitExcludeText: async () => 'no-git' }));
    assert.equal(noGit.ok, true);
  });

  test('instruction sections: missing file -> fix', async () => {
    const d = healthyDeps({ instructionFiles: async () => [{ agent: 'claude', file: 'CLAUDE.md', text: undefined }, { agent: 'codex', file: 'AGENTS.md', text: '<!-- explainit:start -->\nx\n<!-- explainit:end -->' }] });
    const c = await checkInstructions(FOLDER, d);
    assert.equal(c.ok, false);
    assert.ok(c.detail.includes('CLAUDE.md'));
    assert.ok(!c.detail.includes('AGENTS.md'));
    await c.fix!.run();
    sinon.assert.calledWith(d.fixes.updateInstructions as sinon.SinonStub, FOLDER);
    const none = await checkInstructions(FOLDER, healthyDeps({ instructionFiles: async () => [] }));
    assert.equal(none.ok, true);
  });

  test('watchdog bounds', () => {
    assert.equal(checkWatchdog(healthyDeps({ watchdogSeconds: 120 })).ok, true);
    const low = checkWatchdog(healthyDeps({ watchdogSeconds: 5 }));
    assert.equal(low.ok, false);
    assert.equal(low.fix?.label, 'Reset to 120 seconds');
    assert.equal(checkWatchdog(healthyDeps({ watchdogSeconds: 601 })).ok, false);
    assert.equal(checkWatchdog(healthyDeps({ watchdogSeconds: Number.NaN })).ok, false);
  });

  test('disk space', async () => {
    assert.equal((await checkDiskSpace(healthyDeps())).ok, true);
    const low = await checkDiskSpace(healthyDeps({ freeBytes: async () => 10 * 1024 * 1024 }));
    assert.equal(low.ok, false);
    assert.ok(low.detail.includes('10 MB'));
  });

  test('a hanging check is cut off by its timeout and reported plainly', async () => {
    const d = healthyDeps({ detect: () => new Promise(() => {}), checkTimeoutMs: 50, liveTestTimeoutMs: 50 });
    const r = await runDoctorChecks(d);
    const assistants = r.checks.find((c) => c.name.startsWith('Assistants detected'))!;
    assert.equal(assistants.ok, false);
    assert.ok(assistants.detail.includes('did not finish'));
    assert.equal(r.ok, false);
  });

  test('a throwing check becomes a failed check, not a crash', async () => {
    const r = await runDoctorChecks(healthyDeps({ freeBytes: async () => { throw new Error('statfs unsupported'); } }));
    const disk = r.checks.find((c) => c.name.startsWith('Free disk'))!;
    assert.equal(disk.ok, false);
    assert.ok(disk.detail.includes('statfs unsupported'));
  });

  test('whole report finishes well under 15 seconds even with slow checks', async () => {
    const slow = () => new Promise<never>(() => {});
    const d = healthyDeps({ detect: slow, channels: slow, hookLiveTest: slow, healthProbe: slow, checkTimeoutMs: 300, liveTestTimeoutMs: 400 });
    const started = Date.now();
    await runDoctorChecks(d);
    assert.ok(Date.now() - started < 2000, 'checks run concurrently, bounded by the longest timeout');
  });

  test('a session file that parses to a different pid or empty folders is still reported in plain words', async () => {
    const r = await checkSessionFile(healthyDeps({ readSessionFile: async () => ({ pid: 4242, port: 51000, token: '', folders: [], startedAt: '', version: '' }) }));
    assert.equal(r.ok, true);
    assert.ok(r.detail.includes('no folders'));
    assert.ok(!r.detail.includes('undefined'));
  });

  test('two doctor runs at once do not share or corrupt each other\'s reports', async () => {
    let calls = 0;
    const d = healthyDeps({ hookLiveTest: async () => { calls++; return { answered: true, decision: 'allow' }; } });
    const [a, b] = await Promise.all([runDoctorChecks(d), runDoctorChecks(d)]);
    assert.equal(calls, 2);
    assert.equal(a.checks.length, b.checks.length);
    assert.notEqual(a.checks, b.checks);
    assert.equal(a.ok && b.ok, true);
  });

  test('applyAllFixes runs each distinct fix once and reports failures', async () => {
    const rearm = sinon.stub().resolves();
    const boom = sinon.stub().rejects(new Error('no permission'));
    const report: DoctorReport = {
      ok: false,
      ranAt: 'x',
      checks: [
        { name: 'ok one', ok: true, detail: 'd' },
        { name: 'claude hook', ok: false, detail: 'd', fix: { label: 'Re-arm the hooks', run: rearm } },
        { name: 'codex hook', ok: false, detail: 'd', fix: { label: 'Re-arm the hooks', run: rearm } },
        { name: 'exclude', ok: false, detail: 'd', fix: { label: 'Add', run: boom } },
        { name: 'no fix', ok: false, detail: 'd' },
      ],
    };
    const r = await applyAllFixes(report);
    sinon.assert.calledOnce(rearm);
    assert.deepEqual(r.applied, ['claude hook']);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].name, 'exclude');
    assert.ok(r.failed[0].detail.includes('no permission'));
  });
});
