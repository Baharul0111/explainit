import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  EXTENSION_ID,
  REQUIRED_COMMANDS,
  Report,
  buildUserSettings,
  cliInvocation,
  formatMs,
  hasExtension,
  installArgs,
  launchArgs,
  listArgs,
  noVsixMessage,
  parseArgs,
  parseListExtensions,
  parseProbeResult,
  pickNewestVsix,
  probeEnv,
  quoteForCmd,
  seedState,
  shouldCopyFixtureFile,
  versionFromVsixName,
  hasTwinExcludeEntry,
  jitterMs,
  quoteScriptPath,
  twinHeaderMatches,
  twinSectionStatus,
  withRetry,
} from '../pure/smoke';

suite('install-smoke/pure/smoke: VSIX discovery', () => {
  test('versionFromVsixName parses explainit-<semver>.vsix only', () => {
    assert.equal(versionFromVsixName('explainit-0.1.0.vsix'), '0.1.0');
    assert.equal(versionFromVsixName('explainit-1.2.3-beta.1.vsix'), '1.2.3-beta.1');
    assert.equal(versionFromVsixName('EXPLAINIT-0.1.0.VSIX'), '0.1.0');
    assert.equal(versionFromVsixName('other-0.1.0.vsix'), undefined);
    assert.equal(versionFromVsixName('explainit.vsix'), undefined);
    assert.equal(versionFromVsixName('explainit-0.1.0.vsix.bak'), undefined);
  });

  test('pickNewestVsix prefers the most recently written package', () => {
    const picked = pickNewestVsix([
      { name: 'explainit-0.2.0.vsix', mtimeMs: 100 },
      { name: 'explainit-0.1.0.vsix', mtimeMs: 200 },
      { name: 'README.md', mtimeMs: 999 },
    ]);
    assert.equal(picked?.name, 'explainit-0.1.0.vsix');
  });

  test('pickNewestVsix breaks mtime ties by version and ignores non-matching names', () => {
    const picked = pickNewestVsix([
      { name: 'explainit-0.1.0.vsix', mtimeMs: 100 },
      { name: 'explainit-0.1.10.vsix', mtimeMs: 100 },
      { name: 'explainit-0.1.9.vsix', mtimeMs: 100 },
      { name: 'notes.txt', mtimeMs: 100 },
    ]);
    assert.equal(picked?.name, 'explainit-0.1.10.vsix');
    assert.equal(pickNewestVsix([]), undefined);
    assert.equal(pickNewestVsix([{ name: 'foo.vsix', mtimeMs: 1 }]), undefined);
  });

  test('noVsixMessage tells the person what to do next', () => {
    const msg = noVsixMessage('/repo');
    assert.match(msg, /No explainit-\*\.vsix found in \/repo/);
    assert.match(msg, /npm run package/);
  });
});

suite('install-smoke/pure/smoke: VS Code CLI invocation', () => {
  test('macOS and Linux CLIs run directly without a shell', () => {
    const inv = cliInvocation('/x/Visual Studio Code.app/Contents/Resources/app/bin/code', 'darwin', () => true);
    assert.deepEqual(inv, { command: '/x/Visual Studio Code.app/Contents/Resources/app/bin/code', argsPrefix: [], env: {}, shell: false });
    const lin = cliInvocation('/x/VSCode-linux-x64/bin/code', 'linux', () => true);
    assert.equal(lin.shell, false);
    assert.deepEqual(lin.argsPrefix, []);
  });

  test('Windows .cmd shim is replaced by Code.exe + cli.js with ELECTRON_RUN_AS_NODE (no shell)', () => {
    const cmd = path.win32.join('C:\\vs code\\bin', 'code.cmd');
    const seen: string[] = [];
    const inv = cliInvocation(cmd, 'win32', (p) => {
      seen.push(p);
      return true;
    });
    assert.equal(inv.shell, false);
    assert.deepEqual(inv.env, { ELECTRON_RUN_AS_NODE: '1' });
    assert.ok(/Code\.exe$/i.test(inv.command), inv.command);
    assert.equal(inv.argsPrefix.length, 1);
    assert.ok(/cli\.js$/.test(inv.argsPrefix[0]), inv.argsPrefix[0]);
    assert.ok(seen.length >= 2, 'checks that both files exist');
  });

  test('Windows falls back to the .cmd shim through a shell when Code.exe is not where expected', () => {
    const inv = cliInvocation('C:\\vs\\bin\\code.cmd', 'win32', () => false);
    assert.equal(inv.shell, true);
    assert.equal(inv.command, 'C:\\vs\\bin\\code.cmd');
    assert.deepEqual(inv.argsPrefix, []);
  });

  test('quoteForCmd quotes only when needed', () => {
    assert.equal(quoteForCmd('plain'), 'plain');
    assert.equal(quoteForCmd('C:\\a b\\c'), '"C:\\a b\\c"');
    assert.equal(quoteForCmd(''), '""');
    assert.equal(quoteForCmd('a"b'), '"a\\"b"');
    assert.equal(quoteForCmd('a&b'), '"a&b"');
  });

  test('install and list arguments are complete and ordered', () => {
    assert.deepEqual(installArgs('/r/explainit-0.1.0.vsix', '/ud', '/ed'), ['--install-extension', '/r/explainit-0.1.0.vsix', '--user-data-dir', '/ud', '--extensions-dir', '/ed', '--force']);
    const list = listArgs('/ud', '/ed');
    assert.ok(list.includes('--list-extensions'));
    assert.ok(list.includes('--show-versions'));
    assert.ok(list.includes('/ud') && list.includes('/ed'));
  });

  test('parseListExtensions keeps only extension ids, lower-cased, with versions', () => {
    const out = parseListExtensions('Extensions installed on ...\r\nBaharulIslam.explainit@0.1.0\nms-python.python@2026.1.0\n\n[main 12:00] some log line\nvscode.git\n');
    assert.deepEqual(out, [
      { id: 'baharulislam.explainit', version: '0.1.0' },
      { id: 'ms-python.python', version: '2026.1.0' },
      { id: 'vscode.git', version: undefined },
    ]);
    assert.equal(hasExtension(out, EXTENSION_ID), true);
    assert.equal(hasExtension(out, 'Nobody.nothing'), false);
    assert.deepEqual(parseListExtensions(''), []);
  });
});

suite('install-smoke/pure/smoke: fresh profile', () => {
  test('buildUserSettings points ExplainIT at the fake Claude CLI via "node <script>" and keeps VS Code quiet', () => {
    const s = buildUserSettings('C:\\repo\\test\\fixtures\\fake-cli\\claude.js');
    assert.equal(s['explainit.assistant.claudeCliPath'], 'node C:\\repo\\test\\fixtures\\fake-cli\\claude.js');
    assert.equal(s['explainit.assistant.channel'], 'claude');
    assert.equal(s['explainit.twin.autoOpen'], true);
    assert.equal(s['telemetry.telemetryLevel'], 'off');
    assert.equal(s['update.mode'], 'none');
    assert.equal(s['security.workspace.trust.enabled'], false);
    assert.equal(s['files.hotExit'], 'off');
    // The value round-trips through JSON (backslashes survive).
    const back = JSON.parse(JSON.stringify(s)) as Record<string, string>;
    assert.equal(back['explainit.assistant.claudeCliPath'].endsWith('claude.js'), true);
  });

  test('a script path with spaces is double-quoted so the resolver splits "node <script>" correctly', () => {
    // src/generation/channels/cli.ts parseSettingValue: `node "/path with spaces/claude.js"` is the supported form.
    assert.equal(quoteScriptPath('/repo/test/fixtures/fake-cli/claude.js'), '/repo/test/fixtures/fake-cli/claude.js');
    assert.equal(quoteScriptPath('C:\\Users\\Jane Doe\\explainit\\claude.js'), '"C:\\Users\\Jane Doe\\explainit\\claude.js"');
    assert.equal(quoteScriptPath('/Users/x/My Projects/explainit/claude.js'), '"/Users/x/My Projects/explainit/claude.js"');
    const s = buildUserSettings('/Users/x/My Projects/explainit/test/fixtures/fake-cli/claude.js');
    assert.equal(s['explainit.assistant.claudeCliPath'], 'node "/Users/x/My Projects/explainit/test/fixtures/fake-cli/claude.js"');
    // Mirrors the resolver's split: runtime before the first space, the quoted remainder is the script.
    const value = s['explainit.assistant.claudeCliPath'] as string;
    const i = value.indexOf(' ');
    assert.equal(value.slice(0, i), 'node');
    assert.equal(value.slice(i + 1).replace(/^"(.*)"$/, '$1'), '/Users/x/My Projects/explainit/test/fixtures/fake-cli/claude.js');
  });

  test('seedState grants consent and marks onboarding done', () => {
    const s = seedState('2026-09-02T00:00:00.000Z');
    assert.equal(s.version, 1);
    assert.equal(s.consentGranted, true);
    assert.equal(s.consentAt, '2026-09-02T00:00:00.000Z');
    assert.equal(s.onboardingDone, true);
  });

  test('probeEnv sets test mode, home and probe paths, and strips Electron-as-Node', () => {
    const env = probeEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', HOME: '/h' }, { home: '/tmp/home', resultFile: '/tmp/r.json', workspaceDir: '/tmp/ws', repoRoot: '/repo' });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.HOME, '/h');
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.EXPLAINIT_TEST_MODE, '1');
    assert.equal(env.EXPLAINIT_HOME, '/tmp/home');
    assert.deepEqual(JSON.parse(env.EXPLAINIT_TEST_ANSWERS!), { consent: 'Allow' });
    assert.equal(env.EXPLAINIT_SMOKE_RESULT, '/tmp/r.json');
    assert.equal(env.EXPLAINIT_SMOKE_WORKSPACE, '/tmp/ws');
    assert.equal(env.EXPLAINIT_SMOKE_REPO, '/repo');
  });

  test('launchArgs loads the probe as the development extension, uses the fresh profile and ends with the workspace', () => {
    const base = { probeDir: '/p', userDataDir: '/ud', extensionsDir: '/ed', workspaceDir: '/ws' };
    const mac = launchArgs({ ...base, platform: 'darwin' });
    assert.equal(mac[0], '--extensionDevelopmentPath=/p');
    assert.equal(mac[mac.length - 1], '/ws');
    assert.ok(mac.includes('--disable-workspace-trust'));
    assert.ok(!mac.includes('--disable-extensions'), 'the VSIX-installed ExplainIT must load');
    assert.ok(!mac.includes('--no-sandbox'));
    assert.equal(mac[mac.indexOf('--user-data-dir') + 1], '/ud');
    assert.equal(mac[mac.indexOf('--extensions-dir') + 1], '/ed');
    const lin = launchArgs({ ...base, platform: 'linux' });
    assert.ok(lin.includes('--no-sandbox'));
    assert.equal(lin[lin.length - 1], '/ws');
    const win = launchArgs({ ...base, workspaceDir: 'C:\\ws', platform: 'win32' });
    assert.equal(win[win.length - 1], 'C:\\ws');
  });

  test('shouldCopyFixtureFile skips stray twins and .git but keeps sources', () => {
    assert.equal(shouldCopyFixtureFile('src/app.py'), true);
    assert.equal(shouldCopyFixtureFile('src/app_explain.txt'), false);
    assert.equal(shouldCopyFixtureFile('.git/config'), false);
    assert.equal(shouldCopyFixtureFile('web\\index.ts'), true);
    assert.equal(shouldCopyFixtureFile('.'), true);
  });

  test('REQUIRED_COMMANDS are the three the spec names', () => {
    assert.deepEqual(REQUIRED_COMMANDS, ['explainit.openTwin', 'explainit.doctor', 'explainit.pauseCheckpoint']);
  });
});

suite('install-smoke/pure/smoke: probe result and report', () => {
  test('parseProbeResult handles missing, malformed and well-formed input', () => {
    assert.match(parseProbeResult(undefined).problem!, /never wrote/);
    assert.match(parseProbeResult('{not json').problem!, /not valid JSON/);
    assert.match(parseProbeResult('{"ok":true}').problem!, /unexpected shape/);
    assert.match(parseProbeResult('[]').problem!, /unexpected shape/);
    const good = parseProbeResult(JSON.stringify({ ok: true, steps: [{ name: 'a', ok: true }, { name: 'b', ok: 'yes' }], vscodeVersion: '1.100.0' }));
    assert.equal(good.problem, undefined);
    assert.equal(good.result!.ok, true);
    assert.equal(good.result!.steps[1].ok, false, 'non-boolean ok is treated as a failure');
    assert.equal(good.result!.vscodeVersion, '1.100.0');
    assert.equal(parseProbeResult(JSON.stringify({ ok: 'true', steps: [] })).result!.ok, false);
  });

  test('Report renders PASS when every check passed', () => {
    const r = new Report();
    assert.equal(r.ok, false, 'an empty report is not a pass');
    r.check('VSIX present', true, 'explainit-0.1.0.vsix', 12);
    r.check('installs', true, undefined, 2500);
    r.note('git init');
    const text = r.render();
    assert.ok(r.ok);
    assert.match(text, /ok {2}.*VSIX present \(12 ms\)/);
    assert.match(text, /installs \(2\.5 s\)/);
    assert.match(text, /note {2}git init/);
    assert.match(text, /\nPASS: ExplainIT installs from its package into a fresh VS Code and works \(2 checks\)\./);
    assert.doesNotMatch(text, /FAIL/);
  });

  test('Report renders FAIL with each reason', () => {
    const r = new Report();
    r.check('VSIX present', true);
    r.check('installs into a fresh profile', false, 'exit 1: something broke\nsecond line');
    r.check('twin written', false, 'no twin file');
    assert.equal(r.ok, false);
    assert.equal(r.failures.length, 2);
    const text = r.render();
    assert.match(text, /FAIL {2}installs into a fresh profile\n {8}exit 1: something broke\n {8}second line/);
    assert.match(text, /FAIL: 2 of 3 checks failed:\n {2}- installs into a fresh profile: exit 1: something broke\n {2}- twin written: no twin file/);
    assert.doesNotMatch(text, /PASS/);
  });

  test('formatMs', () => {
    assert.equal(formatMs(0), '0 ms');
    assert.equal(formatMs(999.4), '999 ms');
    assert.equal(formatMs(1000), '1.0 s');
    assert.equal(formatMs(65432), '65.4 s');
  });
});

suite('install-smoke/pure/smoke: arguments', () => {
  test('defaults', () => {
    const a = parseArgs([], {});
    // `vsix` is checked first: assert.deepEqual narrows `a` to the literal's type afterwards.
    assert.equal(a.vsix, undefined);
    assert.deepEqual(a, { keep: false, version: 'stable', timeoutMs: DEFAULT_PROBE_TIMEOUT_MS, help: false, unknown: [] });
    assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 180000);
  });

  test('flags and environment', () => {
    const a = parseArgs(['--keep', '--version', 'insiders', '--vsix=/x/explainit-0.1.0.vsix', '--timeout', '30'], {});
    assert.equal(a.keep, true);
    assert.equal(a.version, 'insiders');
    assert.equal(a.vsix, '/x/explainit-0.1.0.vsix');
    assert.equal(a.timeoutMs, 30000);
    const b = parseArgs(['--version=1.100.0', '--timeout=2.5'], { EXPLAINIT_SMOKE_KEEP: '1' });
    assert.equal(b.version, '1.100.0');
    assert.equal(b.keep, true);
    assert.equal(b.timeoutMs, 2500);
    const c = parseArgs([], { VSCODE_TEST_VERSION: ' 1.99.0 ' });
    assert.equal(c.version, '1.99.0');
    assert.equal(parseArgs(['-h'], {}).help, true);
  });

  test('bad input is reported, never thrown', () => {
    const a = parseArgs(['--bogus', '--timeout', 'soon'], {});
    assert.deepEqual(a.unknown, ['--bogus', '--timeout needs a number of seconds, got "soon"']);
    assert.equal(a.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
    assert.deepEqual(parseArgs(['--timeout', '-5'], {}).unknown, ['--timeout needs a number of seconds, got "-5"']);
  });
});

suite('install-smoke/pure/smoke: one jittered retry', () => {
  const noSleep = async (): Promise<void> => {};

  test('a good first result is returned without a retry', async () => {
    let calls = 0;
    const v = await withRetry('x', async () => ++calls, { isOk: (n) => n === 1, sleep: noSleep });
    assert.equal(v, 1);
    assert.equal(calls, 1);
  });

  test('a thrown first attempt (the download) is retried exactly once', async () => {
    let calls = 0;
    const logs: string[] = [];
    const v = await withRetry(
      'VS Code download',
      async () => {
        calls++;
        if (calls === 1) throw new Error('ECONNRESET');
        return '/vscode/exe';
      },
      { isOk: () => true, sleep: noSleep, log: (m) => logs.push(m) },
    );
    assert.equal(v, '/vscode/exe');
    assert.equal(calls, 2);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /VS Code download failed \(ECONNRESET\); retrying once in \d+(\.\d+)? (ms|s)$/);
  });

  test('a not-ok first result (the install exiting non-zero) is retried exactly once and the second result is returned as is', async () => {
    let calls = 0;
    const v = await withRetry('VSIX install', async () => ({ code: ++calls === 1 ? 1 : 0 }), { isOk: (r) => r.code === 0, sleep: noSleep });
    assert.deepEqual(v, { code: 0 });
    assert.equal(calls, 2);
    calls = 0;
    const still = await withRetry('VSIX install', async () => ({ code: 7, n: ++calls }), { isOk: (r) => r.code === 0, sleep: noSleep });
    assert.deepEqual(still, { code: 7, n: 2 }, 'never a third attempt');
  });

  test('a second failure propagates; the wait is jittered between 50% and 150% of the base', async () => {
    let calls = 0;
    const waits: number[] = [];
    await assert.rejects(
      withRetry(
        'x',
        async () => {
          calls++;
          throw new Error(`boom ${calls}`);
        },
        { isOk: () => true, baseWaitMs: 1000, random: () => 0.25, sleep: async (ms) => void waits.push(ms) },
      ),
      /boom 2/,
    );
    assert.equal(calls, 2);
    assert.deepEqual(waits, [750]);
    assert.equal(jitterMs(2000, () => 0), 1000);
    assert.equal(jitterMs(2000, () => 0.999), 2998);
    for (let i = 0; i < 50; i++) {
      const j = jitterMs(2000);
      assert.ok(j >= 1000 && j <= 3000, String(j));
    }
  });
});

suite('install-smoke/pure/smoke: twin content checks', () => {
  const header = 'ExplainIT — plain-English twin of app.py\nWritten by ExplainIT. Not committed to git. Right-click a section for "Regenerate this section".\n\n';
  const complete =
    header +
    '1. load_config\nWhat it does: It reads the settings file and turns it into a settings object.\nHow it works:\n- It opens the file at the given path.\n- It reads all of the text.\n- It hands the object back.\n\n2. greet\nWhat it does: (explaining...)\n';

  test('a complete section has a real summary and 2..5 steps', () => {
    const s = twinSectionStatus(complete, 1, 'load_config');
    assert.equal(s.state, 'complete');
    assert.equal(s.steps, 3);
    assert.equal(s.summary, 'It reads the settings file and turns it into a settings object.');
    assert.match(s.detail, /What it does: It reads the settings file/);
    // Windows line endings are fine.
    assert.equal(twinSectionStatus(complete.replace(/\n/g, '\r\n'), 1, 'load_config').state, 'complete');
    // A stale mark under the header does not hide a complete explanation.
    assert.equal(twinSectionStatus(complete.replace('1. load_config\n', '1. load_config\n(Out of date — the code changed. Right-click here and choose "ExplainIT: Regenerate this section".)\n'), 1, 'load_config').state, 'complete');
  });

  test('placeholders are pending or unavailable, never complete', () => {
    assert.equal(twinSectionStatus(complete, 2, 'greet').state, 'pending');
    const unavailable = header + '1. load_config\nWhat it does: (not explained yet — connect an assistant and run "ExplainIT: Regenerate this section")\n';
    const u = twinSectionStatus(unavailable, 1, 'load_config');
    assert.equal(u.state, 'unavailable');
    assert.match(u.detail, /no assistant was used/);
  });

  test('missing file, missing section and half-written sections are reported with reasons', () => {
    assert.equal(twinSectionStatus(undefined, 1, 'load_config').state, 'missing');
    assert.equal(twinSectionStatus('', 1, 'load_config').state, 'missing');
    const missing = twinSectionStatus(header + '1. greet\nWhat it does: It says hello.\n', 1, 'load_config');
    assert.equal(missing.state, 'missing');
    assert.match(missing.detail, /no "1. load_config" section/);
    const noWhat = twinSectionStatus(header + '1. load_config\nHow it works:\n- a\n- b\n', 1, 'load_config');
    assert.equal(noWhat.state, 'incomplete');
    assert.match(noWhat.detail, /no "What it does:" line/);
    const oneStep = twinSectionStatus(header + '1. load_config\nWhat it does: It loads.\nHow it works:\n- Only one step.\n', 1, 'load_config');
    assert.equal(oneStep.state, 'incomplete');
    assert.match(oneStep.detail, /1 "How it works" step\(s\); at least 2/);
    const noHow = twinSectionStatus(header + '1. load_config\nWhat it does: It loads.\n', 1, 'load_config');
    assert.equal(noHow.state, 'incomplete');
    const sixSteps = twinSectionStatus(header + '1. load_config\nWhat it does: It loads.\nHow it works:\n- a\n- b\n- c\n- d\n- e\n- f\n', 1, 'load_config');
    assert.equal(sixSteps.state, 'incomplete');
    assert.match(sixSteps.detail, /at most 5/);
    const notSentence = twinSectionStatus(header + '1. load_config\nWhat it does: loads config\nHow it works:\n- a\n- b\n', 1, 'load_config');
    assert.equal(notSentence.state, 'incomplete');
    assert.match(notSentence.detail, /not a sentence/);
  });

  test('steps belong to their own section only', () => {
    // Section 1 has no steps of its own; section 2's steps must not be counted for it.
    const text = header + '1. load_config\nWhat it does: It loads.\n\n2. greet\nWhat it does: It greets.\nHow it works:\n- a\n- b\n';
    assert.equal(twinSectionStatus(text, 1, 'load_config').state, 'incomplete');
    assert.equal(twinSectionStatus(text, 2, 'greet').state, 'complete');
  });

  test('twinHeaderMatches and hasTwinExcludeEntry', () => {
    assert.equal(twinHeaderMatches(complete, 'app.py'), true);
    assert.equal(twinHeaderMatches(complete, 'util.ts'), false);
    assert.equal(twinHeaderMatches(undefined, 'app.py'), false);
    assert.equal(twinHeaderMatches('random text\n', 'app.py'), false);
    assert.equal(hasTwinExcludeEntry('# git ls-files --others --exclude-from=.git/info/exclude\n*_explain.txt\n'), true);
    assert.equal(hasTwinExcludeEntry('*_explain.txt\r\n'), true);
    assert.equal(hasTwinExcludeEntry('  *_explain.txt  \n'), true);
    assert.equal(hasTwinExcludeEntry('*_explain.txt.bak\n'), false);
    assert.equal(hasTwinExcludeEntry('# *_explain.txt\n'), false);
    assert.equal(hasTwinExcludeEntry(undefined), false);
    assert.equal(hasTwinExcludeEntry(''), false);
  });
});
