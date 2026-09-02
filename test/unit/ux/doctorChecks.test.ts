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
        { name: 'Codex hook trust', ok: true, detail: 'Codex trusts the ExplainIT hook.' },
        { name: 'hook script', ok: true },
      ],
    }),
    adapterStates: async () => [
      { agent: 'claude', installed: true, armed: true },
      { agent: 'codex', installed: true, armed: true },
    ],
    codexPaths: { hooksJson: '~/.codex/hooks.json', configToml: '~/.codex/config.toml' },
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

  // Exact shapes produced by src/adapters/codex.ts extraChecks(); TRUST_STEP is the adapter's CODEX_TRUST_STEP.
  const TRUST_STEP =
    'Codex only runs hooks you have trusted: open codex in a terminal once, and when it shows the ExplainIT hook choose Trust (or type /hooks). The Codex VS Code extension uses the same trust record.';
  const TRUST_OK = { name: 'Codex hook trust', ok: true, detail: 'Codex trusts the ExplainIT hook.' };
  const TRUST_UNTRUSTED = { name: 'Codex hook trust', ok: false, fixable: false, detail: `Codex has no trust record for the ExplainIT hook yet. ${TRUST_STEP}` };
  const TRUST_MODIFIED = {
    name: 'Codex hook trust',
    ok: false,
    fixable: false,
    detail: `Codex has a trust record for the ExplainIT hook, but it does not match the current hook entry. Codex will not run it until you trust it again. ${TRUST_STEP}`,
  };
  const TRUST_DISABLED = { name: 'Codex hook trust', ok: false, fixable: false, detail: 'The ExplainIT hook is disabled in Codex (enabled = false in config.toml). Enable it in codex with /hooks.' };
  const TRUST_UNKNOWN = {
    name: 'Codex hook trust',
    ok: false,
    fixable: false,
    detail: 'Trust unknown — run the Doctor after starting codex once. (No ExplainIT PreToolUse entry in hooks.json. Config: ~/.codex/config.toml)',
  };
  const withTrust = (trust: { name: string; ok: boolean; detail?: string; fixable?: boolean }, over: Partial<DoctorDeps> = {}) =>
    healthyDeps({
      verifyIntegrity: async () => ({
        ok: trust.ok,
        checks: [
          { name: 'Claude Code hook script', ok: true, detail: 'Hook script present and unchanged.' },
          { name: '~/.claude/settings.json', ok: true, detail: 'Checkpoint hook entries present and unchanged in ~/.claude/settings.json.' },
          { name: 'Codex hook script', ok: true, detail: 'Hook script present and unchanged.' },
          { name: 'Codex hook wrapper', ok: true, detail: 'Wrapper script present and unchanged.' },
          { name: '~/.codex/hooks.json', ok: true, detail: 'Checkpoint hook entries present and unchanged in ~/.codex/hooks.json.' },
          trust,
        ],
      }),
      ...over,
    });

  test('codex trust: the adapter verdict is shown verbatim, trusted -> ok', async () => {
    const ok = await checkCodexTrust(withTrust(TRUST_OK));
    assert.equal(ok.ok, true);
    assert.equal(ok.detail, TRUST_OK.detail);
    assert.equal(ok.fix, undefined);
  });

  test('codex trust: untrusted / modified / disabled -> problem with the adapter detail verbatim and no fix action', async () => {
    for (const t of [TRUST_UNTRUSTED, TRUST_MODIFIED, TRUST_DISABLED]) {
      const c = await checkCodexTrust(withTrust(t));
      assert.equal(c.name, 'Codex trusts the ExplainIT hook');
      assert.equal(c.ok, false);
      assert.equal(c.detail, t.detail, 'the adapter detail carries the trust steps and must not be reworded');
      assert.equal(c.fix, undefined, 'only the person can trust a hook inside codex');
    }
    const u = await checkCodexTrust(withTrust(TRUST_UNTRUSTED));
    assert.ok(u.detail.includes('open codex in a terminal once'));
    assert.ok(u.detail.includes('choose Trust'));
    assert.ok(u.detail.includes('/hooks'));
    assert.ok(u.detail.includes('Codex VS Code extension uses the same trust record'));
  });

  test('codex trust: "Trust unknown — run the Doctor after starting codex once" is surfaced as is, with no fix action', async () => {
    const c = await checkCodexTrust(withTrust(TRUST_UNKNOWN));
    assert.equal(c.ok, false);
    assert.equal(c.detail, TRUST_UNKNOWN.detail);
    assert.equal(c.fix, undefined);
    assert.ok(c.detail.startsWith('Trust unknown'));
  });

  test('codex trust: absent -> ok; not installed -> install fix naming hooks.json; adapter silent -> problem naming config.toml', async () => {
    const absent = await checkCodexTrust(healthyDeps({ detect: async () => [{ agent: 'codex', present: false }], adapterStates: async () => [] }));
    assert.equal(absent.ok, true);
    const d = healthyDeps({ adapterStates: async () => [{ agent: 'codex', installed: false, armed: false }] });
    const notInstalled = await checkCodexTrust(d);
    assert.equal(notInstalled.ok, false);
    assert.equal(notInstalled.fix?.label, 'Install the Codex hook');
    assert.ok(notInstalled.detail.includes('~/.codex/hooks.json'));
    await notInstalled.fix!.run();
    sinon.assert.calledWith(d.fixes.installHook as sinon.SinonStub, 'codex');
    const silent = await checkCodexTrust(healthyDeps({ verifyIntegrity: async () => ({ ok: true, checks: [{ name: 'Codex hook script', ok: true }] }) }));
    assert.equal(silent.ok, false);
    assert.equal(silent.fix, undefined);
    assert.ok(silent.detail.includes('~/.codex/config.toml'));
    assert.ok(silent.detail.includes('Trust'));
  });

  test('codex trust: the paths shown honour CODEX_HOME (they come from the glue, never a hard-coded ~/.codex)', async () => {
    const paths = { hooksJson: '/srv/codex-home/hooks.json', configToml: '/srv/codex-home/config.toml' };
    const notInstalled = await checkCodexTrust(healthyDeps({ codexPaths: paths, adapterStates: async () => [{ agent: 'codex', installed: false, armed: false }] }));
    assert.ok(notInstalled.detail.includes('/srv/codex-home/hooks.json'));
    assert.ok(!notInstalled.detail.includes('~/.codex'));
    const silent = await checkCodexTrust(healthyDeps({ codexPaths: paths, verifyIntegrity: async () => ({ ok: true, checks: [] }) }));
    assert.ok(silent.detail.includes('/srv/codex-home/config.toml'));
  });

  test('codex trust failure does not turn "Codex checkpoint hook" into a re-arm problem', async () => {
    const [claude, codex] = await checkHookIntegrity(withTrust(TRUST_UNTRUSTED));
    assert.equal(claude.ok, true);
    assert.equal(codex.ok, true, codex.detail);
    assert.equal(codex.fix, undefined);
    assert.ok(!codex.detail.includes('trust'));
  });

  test('a full report with an untrusted Codex hook is not ok, offers nothing to "Fix all" for it, and keeps every other check green', async () => {
    const r = await runDoctorChecks(withTrust(TRUST_UNTRUSTED));
    assert.equal(r.ok, false);
    const trust = r.checks.find((c) => c.name === 'Codex trusts the ExplainIT hook')!;
    assert.equal(trust.ok, false);
    assert.equal(trust.fix, undefined);
    assert.equal(trust.detail, TRUST_UNTRUSTED.detail);
    assert.deepEqual(r.checks.filter((c) => !c.ok).map((c) => c.name), ['Codex trusts the ExplainIT hook']);
    const fixed = await applyAllFixes(r);
    assert.deepEqual(fixed.applied, []);
    assert.deepEqual(fixed.failed, []);
  });

  test('hook integrity: a failure the adapter marks fixable=false (config not valid JSON) gets no re-arm action', async () => {
    const d = healthyDeps({
      verifyIntegrity: async () => ({
        ok: false,
        checks: [{ name: '~/.codex/hooks.json', ok: false, fixable: false, detail: '~/.codex/hooks.json is not valid JSON (Unexpected token); the assistant cannot load any hooks from it. Fix the file by hand, then run the Doctor again.' }],
      }),
    });
    const [claude, codex] = await checkHookIntegrity(d);
    assert.equal(claude.ok, true);
    assert.equal(codex.ok, false);
    assert.equal(codex.fix, undefined);
    assert.ok(codex.detail.includes('not valid JSON'));
    assert.ok(codex.detail.includes('cannot fix this by itself'));
  });

  test('assistant details that carry a revoked Codex sign-in get the "codex login" hint', async () => {
    const d = healthyDeps({
      detect: async () => [{ agent: 'codex', present: true, ready: false, detail: 'codex exec failed: refresh token was revoked. Please log out and sign in again.' }],
      channels: async () => [{ channel: 'codex', available: false, reason: 'Please log out and sign in again' }],
    });
    const a = await checkAssistants(d);
    assert.ok(a.detail.includes('codex login'), a.detail);
    const ch = await checkChannels(d);
    assert.ok(ch.detail.includes('codex login'), ch.detail);
    const clean = await checkAssistants(healthyDeps());
    assert.ok(!clean.detail.includes('codex login'));
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

  test('hook wiring: uses the installed wrapper when present and says so in the detail', async () => {
    const wrapper = '/home/pat/.explainit/hooks/explainit-hook.sh';
    const viaWrapper = await checkHookWiring(healthyDeps({ hookLiveTest: async () => ({ answered: true, decision: 'allow', via: `through the installed wrapper ${wrapper}` }) }));
    assert.equal(viaWrapper.ok, true);
    assert.ok(viaWrapper.detail.includes(wrapper), viaWrapper.detail);
    assert.ok(viaWrapper.detail.includes('installed wrapper'), viaWrapper.detail);
    const viaScript = await checkHookWiring(healthyDeps({ hookLiveTest: async () => ({ answered: false, problem: 'printed nothing', via: 'by running the hook script directly (/ext/hooks/explainit-hook.js) because no wrapper is installed yet' }) }));
    assert.equal(viaScript.ok, false);
    assert.ok(viaScript.detail.includes('no wrapper is installed'), viaScript.detail);
    assert.ok(viaScript.detail.includes('printed nothing'));
    assert.ok(!viaScript.detail.includes('undefined'));
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
