import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  EXTENSION_ID,
  GREET_AFTER,
  GREET_BEFORE,
  HOOK_MARK,
  REQUIRED_COMMANDS,
  REQUIRED_STEPS,
  Report,
  buildUserSettings,
  changeGreet,
  checkpointsFor,
  claudeWritePayload,
  cliInvocation,
  formatMs,
  hasExtension,
  hookCommandFromSettings,
  installArgs,
  installedWrapperPath,
  launchArgs,
  listArgs,
  missingRequiredSteps,
  noVsixMessage,
  parseArgs,
  parseHookStdout,
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
  shellInvocation,
  twinHeaderMatches,
  twinSectionStatus,
  withRetry,
} from '../pure/smoke';

suite('install-smoke/pure/smoke: VSIX discovery', () => {
  test('versionFromVsixName parses explainit-code-<semver>.vsix only', () => {
    assert.equal(versionFromVsixName('explainit-code-0.1.0.vsix'), '0.1.0');
    assert.equal(versionFromVsixName('explainit-code-1.2.3-beta.1.vsix'), '1.2.3-beta.1');
    assert.equal(versionFromVsixName('EXPLAINIT-CODE-0.1.0.VSIX'), '0.1.0');
    assert.equal(versionFromVsixName('other-0.1.0.vsix'), undefined);
    assert.equal(versionFromVsixName('explainit.vsix'), undefined);
    assert.equal(versionFromVsixName('explainit-code-0.1.0.vsix.bak'), undefined);
  });

  test('pickNewestVsix prefers the most recently written package', () => {
    const picked = pickNewestVsix([
      { name: 'explainit-code-0.2.0.vsix', mtimeMs: 100 },
      { name: 'explainit-code-0.1.0.vsix', mtimeMs: 200 },
      { name: 'README.md', mtimeMs: 999 },
    ]);
    assert.equal(picked?.name, 'explainit-code-0.1.0.vsix');
  });

  test('pickNewestVsix breaks mtime ties by version and ignores non-matching names', () => {
    const picked = pickNewestVsix([
      { name: 'explainit-code-0.1.0.vsix', mtimeMs: 100 },
      { name: 'explainit-code-0.1.10.vsix', mtimeMs: 100 },
      { name: 'explainit-code-0.1.9.vsix', mtimeMs: 100 },
      { name: 'notes.txt', mtimeMs: 100 },
    ]);
    assert.equal(picked?.name, 'explainit-code-0.1.10.vsix');
    assert.equal(pickNewestVsix([]), undefined);
    assert.equal(pickNewestVsix([{ name: 'foo.vsix', mtimeMs: 1 }]), undefined);
  });

  test('noVsixMessage tells the person what to do next', () => {
    const msg = noVsixMessage('/repo');
    assert.match(msg, /No explainit-code-\*\.vsix found in \/repo/);
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
    assert.deepEqual(installArgs('/r/explainit-code-0.1.0.vsix', '/ud', '/ed'), ['--install-extension', '/r/explainit-code-0.1.0.vsix', '--user-data-dir', '/ud', '--extensions-dir', '/ed', '--force']);
    const list = listArgs('/ud', '/ed');
    assert.ok(list.includes('--list-extensions'));
    assert.ok(list.includes('--show-versions'));
    assert.ok(list.includes('/ud') && list.includes('/ed'));
  });

  test('parseListExtensions keeps only extension ids, lower-cased, with versions', () => {
    const out = parseListExtensions('Extensions installed on ...\r\nBaharulIslam.explainit-code@0.1.0\nms-python.python@2026.1.0\n\n[main 12:00] some log line\nvscode.git\n');
    assert.deepEqual(out, [
      { id: 'baharulislam.explainit-code', version: '0.1.0' },
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

  test('probeEnv sets test mode, home, the temp user home and probe paths, and strips Electron-as-Node', () => {
    const env = probeEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', HOME: '/h' }, { home: '/tmp/home', resultFile: '/tmp/r.json', workspaceDir: '/tmp/ws', repoRoot: '/repo', userHome: '/tmp/user-home' });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.HOME, '/h', 'the real HOME is left alone; the hook install goes to EXPLAINIT_USER_HOME');
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.EXPLAINIT_TEST_MODE, '1');
    assert.equal(env.EXPLAINIT_HOME, '/tmp/home');
    assert.equal(env.EXPLAINIT_USER_HOME, '/tmp/user-home');
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
    r.check('VSIX present', true, 'explainit-code-0.1.0.vsix', 12);
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
    assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 300000, 'five minutes: the two checkpoint round trips add about a minute to the twin steps');
  });

  test('flags and environment', () => {
    const a = parseArgs(['--keep', '--version', 'insiders', '--vsix=/x/explainit-code-0.1.0.vsix', '--timeout', '30'], {});
    assert.equal(a.keep, true);
    assert.equal(a.version, 'insiders');
    assert.equal(a.vsix, '/x/explainit-code-0.1.0.vsix');
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

suite('install-smoke/pure/smoke: checkpoint round trip through the installed hook', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
  const probeSource = fs.readFileSync(path.join(REPO_ROOT, 'test', 'install-smoke', 'probe', 'extension.js'), 'utf8');

  test('REQUIRED_STEPS name every step the probe records, and the probe carries each name verbatim', () => {
    assert.ok(REQUIRED_STEPS.length >= 11, 'the checkpoint steps (hook install, reject, accept) are required');
    for (const name of REQUIRED_STEPS) {
      assert.ok(probeSource.includes(JSON.stringify(name).slice(1, -1)) || probeSource.includes(name), `probe/extension.js does not carry the step "${name}"`);
    }
    // The probe's step constants are all in REQUIRED_STEPS (nothing is quietly added on one side only).
    const probeSteps = [...probeSource.matchAll(/^const STEP_[A-Z_]+ = '((?:[^'\\]|\\.)*)';$/gm)].map((m) => m[1].replace(/\\'/g, "'"));
    assert.deepEqual(probeSteps, REQUIRED_STEPS);
    assert.ok(REQUIRED_STEPS.some((s) => /Claude Code hook installs/.test(s)));
    assert.ok(REQUIRED_STEPS.some((s) => /denied when the person rejects it/.test(s) && /app\.py is unchanged/.test(s)));
    assert.ok(REQUIRED_STEPS.some((s) => /allowed when the person accepts it/.test(s) && /restore point/.test(s)));
  });

  test('the probe copies of the pure helpers are kept in step (same function bodies)', () => {
    // twinSectionStatus, hookCommandFromSettings, shellInvocation, parseHookStdout and claudeWritePayload
    // exist twice: here (typed, unit-tested) and in the probe (plain JS, no build step).
    for (const fn of ['twinSectionStatus', 'hookCommandFromSettings', 'shellInvocation', 'parseHookStdout', 'claudeWritePayload', 'runHook', 'roundTrip']) {
      assert.ok(new RegExp(`function ${fn}\\(`).test(probeSource), `probe/extension.js has no function ${fn}`);
    }
    assert.ok(probeSource.includes("api.adapters.install('claude')"), 'the probe installs the hook through the installed extension API');
    assert.ok(probeSource.includes('__explainitReviewTestHook'), 'the probe drives the review through the test hook');
    assert.ok(probeSource.includes('waitForExplained()'), 'accept waits for the explanation, as the person must');
    assert.ok(probeSource.includes("decide('reject', REJECT_REASON)"), 'reject carries the person\'s words');
    assert.ok(probeSource.includes(`REJECT_REASON = 'keep it'`));
    assert.ok(probeSource.includes(`GREET_BEFORE = '${GREET_BEFORE}'`) && probeSource.includes(`GREET_AFTER = '${GREET_AFTER}'`), 'same one-line change to greet()');
  });

  test('missingRequiredSteps names what the probe never recorded (a failed step is present, not missing)', () => {
    assert.deepEqual(missingRequiredSteps(undefined, ['a', 'b']), ['a', 'b']);
    assert.deepEqual(missingRequiredSteps({ ok: false, steps: [{ name: 'a', ok: false }] }, ['a', 'b']), ['b']);
    assert.deepEqual(missingRequiredSteps({ ok: true, steps: [{ name: 'a', ok: true }, { name: 'b', ok: true }, { name: 'extra', ok: true }] }, ['a', 'b']), []);
    const all = missingRequiredSteps({ ok: true, steps: REQUIRED_STEPS.map((name) => ({ name, ok: true })) });
    assert.deepEqual(all, []);
    const stoppedEarly = missingRequiredSteps({ ok: false, steps: REQUIRED_STEPS.slice(0, 8).map((name) => ({ name, ok: true })) });
    assert.equal(stoppedEarly.length, 3);
    assert.ok(stoppedEarly.every((s) => /hook/i.test(s)), stoppedEarly.join(' | '));
  });

  test('installedWrapperPath: .sh on POSIX, .cmd on Windows, inside <home>/hooks', () => {
    assert.equal(installedWrapperPath('/tmp/h', 'darwin'), path.join('/tmp/h', 'hooks', 'explainit-hook.sh'));
    assert.equal(installedWrapperPath('/tmp/h', 'linux'), path.join('/tmp/h', 'hooks', 'explainit-hook.sh'));
    assert.equal(installedWrapperPath('C:\\x\\h', 'win32'), path.join('C:\\x\\h', 'hooks', 'explainit-hook.cmd'));
  });

  test('hookCommandFromSettings finds the PreToolUse command ExplainIT wrote (not the PostToolUse one) and reports problems in plain English', () => {
    const settings = {
      other: true,
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] },
          { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: "'/h/hooks/explainit-hook.sh' --agent claude --watchdog 120 --home '/h' --claude-home '/u/.claude' --codex-home '/u/.codex'", timeout: 7200 }] },
        ],
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: "'/h/hooks/explainit-hook.sh' --agent claude --event PostToolUse --home '/h'", timeout: 10 }] }],
      },
    };
    const found = hookCommandFromSettings(JSON.stringify(settings));
    assert.equal(found.problem, undefined);
    assert.ok(found.command!.includes(HOOK_MARK) && found.command!.includes('--home') && !found.command!.includes('PostToolUse'), found.command);
    // The PostToolUse spelling in the PreToolUse list is skipped too.
    const onlyPost = { hooks: { PreToolUse: [{ hooks: [{ command: '/h/hooks/explainit-hook.sh --agent claude --event PostToolUse' }] }] } };
    assert.match(hookCommandFromSettings(JSON.stringify(onlyPost)).problem!, /no PreToolUse entry whose command contains "explainit-hook"/);
    assert.match(hookCommandFromSettings(undefined).problem!, /does not exist/);
    assert.match(hookCommandFromSettings('{oops').problem!, /not valid JSON/);
    assert.match(hookCommandFromSettings('{}').problem!, /no hooks\.PreToolUse list/);
    assert.match(hookCommandFromSettings('{"hooks":{"PreToolUse":[{"hooks":"nope"},{"hooks":[{"command":"other"}]}]}}').problem!, /no PreToolUse entry/);
  });

  test('shellInvocation runs the command line the way the agents do: sh -c on POSIX, cmd.exe /d /s /c verbatim on Windows', () => {
    const cmd = "'/h/hooks/explainit-hook.sh' --agent claude --home '/h'";
    assert.deepEqual(shellInvocation(cmd, 'darwin'), { command: 'sh', args: ['-c', cmd], windowsVerbatimArguments: false });
    assert.deepEqual(shellInvocation(cmd, 'linux'), { command: 'sh', args: ['-c', cmd], windowsVerbatimArguments: false });
    const win = shellInvocation('"C:\\h\\hooks\\explainit-hook.cmd" --agent claude', 'win32', 'C:\\Windows\\system32\\cmd.exe');
    assert.deepEqual(win, { command: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', '""C:\\h\\hooks\\explainit-hook.cmd" --agent claude"'], windowsVerbatimArguments: true });
    assert.equal(shellInvocation('x', 'win32', '  ').command, 'cmd.exe');
    assert.equal(shellInvocation('x', 'win32').command, 'cmd.exe');
  });

  test('claudeWritePayload has the shape Claude Code sends on stdin for a Write', () => {
    const p = claudeWritePayload({ cwd: '/ws', filePath: '/ws/src/app.py', content: 'x = 1\n', sessionId: 's1', toolUseId: 'toolu_1' });
    assert.equal(p.hook_event_name, 'PreToolUse');
    assert.equal(p.tool_name, 'Write');
    assert.equal(p.session_id, 's1');
    assert.equal(p.tool_use_id, 'toolu_1');
    assert.equal(p.cwd, '/ws');
    assert.equal(p.permission_mode, 'default');
    assert.deepEqual(p.tool_input, { file_path: '/ws/src/app.py', content: 'x = 1\n' });
    assert.equal(p.transcript_path, path.join('/ws', '.transcript.jsonl'));
    assert.doesNotThrow(() => JSON.stringify(p));
  });

  test('changeGreet changes exactly one line of greet() and refuses a fixture without it', () => {
    const appPy = fs.readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'workspace', 'src', 'app.py'), 'utf8');
    const after = changeGreet(appPy);
    assert.ok(after, 'the fixture app.py has the greet() line the smoke test changes');
    assert.ok(after!.includes(GREET_AFTER) && !after!.includes(GREET_BEFORE));
    const diff = appPy.split('\n').filter((l, i) => after!.split('\n')[i] !== l);
    assert.equal(diff.length, 1, 'one line differs');
    assert.equal(changeGreet('def greet():\n    return 1\n'), undefined);
    assert.equal(changeGreet(undefined), undefined);
    assert.equal(changeGreet(''), undefined);
  });

  test('parseHookStdout reads the Claude Code hook JSON and treats silence or junk as a problem', () => {
    const deny = parseHookStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Rejected by the person: keep it' } }) + '\n');
    assert.deepEqual(deny, { decision: 'deny', reason: 'Rejected by the person: keep it' });
    const allow = parseHookStdout('{"hookSpecificOutput":{"permissionDecision":"allow"}}');
    assert.deepEqual(allow, { decision: 'allow', reason: undefined });
    assert.equal(parseHookStdout('{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":1}}').decision, 'ask');
    assert.match(parseHookStdout('').problem!, /printed nothing/);
    assert.match(parseHookStdout(undefined).problem!, /printed nothing/);
    assert.match(parseHookStdout('   \n').problem!, /printed nothing/);
    assert.match(parseHookStdout('Error: boom').problem!, /not JSON/);
    assert.match(parseHookStdout('{"decision":"deny"}').problem!, /no permissionDecision/);
    assert.match(parseHookStdout('{"hookSpecificOutput":{"permissionDecision":"maybe"}}').problem!, /no permissionDecision/);
  });

  test('checkpointsFor lists the restore points recorded for a file name in a checkpoints index', () => {
    const index = JSON.stringify([
      { id: 'c1', path: '/ws/src/app.py', ts: '2026-09-02T00:00:00.000Z', contentHash: 'x', size: 1 },
      { id: 'c2', path: '/ws/src/util.ts', ts: '2026-09-02T00:00:01.000Z', contentHash: 'y', size: 1 },
      { id: 'c3', path: 'C:\\ws\\src\\app.py', ts: '2026-09-02T00:00:02.000Z', contentHash: 'z', size: 1 },
      null,
      { id: 'c4' },
    ]);
    const cps = checkpointsFor(index, 'app.py');
    // path.basename only understands backslashes on Windows, exactly like the store that wrote the index.
    assert.deepEqual(cps.map((c) => c.id), process.platform === 'win32' ? ['c1', 'c3'] : ['c1']);
    assert.deepEqual(checkpointsFor(index, 'nope.py'), []);
    assert.deepEqual(checkpointsFor(undefined, 'app.py'), []);
    assert.deepEqual(checkpointsFor('{not json', 'app.py'), []);
    assert.deepEqual(checkpointsFor('{"id":"c1"}', 'app.py'), [], 'the index is an array');
  });
});
