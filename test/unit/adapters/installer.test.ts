/**
 * End-to-end installer tests in plain Node: a temp ExplainIT home, a temp "user home" for
 * ~/.claude and ~/.codex, and a fake extension folder holding the real hook script.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../../../src/core/log';
import { inMemorySettings } from '../../../src/core/settings';
import { createStateStore } from '../../../src/core/state';
import { ClaudeAdapter } from '../../../src/adapters/claude';
import { CodexAdapter } from '../../../src/adapters/codex';
import { makeAdapterEnv, userHomeDir, type AdapterEnv, type HostProbe } from '../../../src/adapters/installer';
import { codexHookHash, codexHookStateHeader } from '../../../src/adapters/pure/codexTrust';
import { findOurEntries } from '../../../src/adapters/pure/hookConfig';
import { shPath, shQuote } from '../../../src/adapters/pure/wrappers';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const HOOK_SRC = path.join(REPO, 'hooks', 'explainit-hook.js');

interface Sandbox {
  root: string;
  env: AdapterEnv;
  claude: ClaudeAdapter;
  codex: CodexAdapter;
  claudeSettings: string;
  codexHooks: string;
  codexConfig: string;
}

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-installer-'));
  const extensionPath = path.join(root, 'ext');
  fs.mkdirSync(path.join(extensionPath, 'hooks'), { recursive: true });
  fs.copyFileSync(HOOK_SRC, path.join(extensionPath, 'hooks', 'explainit-hook.js'));
  const home = path.join(root, 'home');
  const userHome = path.join(root, 'user');
  fs.mkdirSync(userHome, { recursive: true });
  const probe: HostProbe = { findExtension: () => undefined, copilotModelCount: async () => 0 };
  const state = createStateStore(path.join(home, 'state.json'));
  const env = makeAdapterEnv({ logger: createLogger([], 'test'), settings: inMemorySettings({ gateWatchdogSeconds: 90 }), extensionPath, version: '0.0.0' }, state, probe, {
    explainitHome: home,
    hooksDir: path.join(home, 'hooks'),
    userHome,
  });
  return {
    root,
    env,
    claude: new ClaudeAdapter(env),
    codex: new CodexAdapter(env),
    claudeSettings: path.join(userHome, '.claude', 'settings.json'),
    codexHooks: path.join(userHome, '.codex', 'hooks.json'),
    codexConfig: path.join(userHome, '.codex', 'config.toml'),
  };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

suite('adapters/installer (claude + codex round trip)', function () {
  this.timeout(20000);
  let sb: Sandbox;
  setup(() => {
    sb = sandbox();
  });
  teardown(() => {
    fs.rmSync(sb.root, { recursive: true, force: true });
  });

  test('userHomeDir honours EXPLAINIT_USER_HOME and test mode', () => {
    const prevUser = process.env.EXPLAINIT_USER_HOME;
    const prevMode = process.env.EXPLAINIT_TEST_MODE;
    const prevHome = process.env.EXPLAINIT_HOME;
    try {
      process.env.EXPLAINIT_USER_HOME = sb.root;
      assert.strictEqual(userHomeDir(), path.resolve(sb.root));
      delete process.env.EXPLAINIT_USER_HOME;
      process.env.EXPLAINIT_TEST_MODE = '1';
      process.env.EXPLAINIT_HOME = path.join(sb.root, 'h');
      assert.strictEqual(userHomeDir(), path.join(path.resolve(sb.root, 'h'), 'user-home'));
      delete process.env.EXPLAINIT_TEST_MODE;
      assert.strictEqual(userHomeDir(), os.homedir());
    } finally {
      if (prevUser === undefined) delete process.env.EXPLAINIT_USER_HOME; else process.env.EXPLAINIT_USER_HOME = prevUser;
      if (prevMode === undefined) delete process.env.EXPLAINIT_TEST_MODE; else process.env.EXPLAINIT_TEST_MODE = prevMode;
      if (prevHome === undefined) delete process.env.EXPLAINIT_HOME; else process.env.EXPLAINIT_HOME = prevHome;
    }
  });

  test('claude install creates settings.json, copies the script, writes wrappers and records hashes', async () => {
    const r = await sb.claude.install();
    assert.strictEqual(r.ok, true, r.detail);
    assert.strictEqual(r.changed, true);
    assert.ok(r.nextSteps.some((s) => /VS Code extension/.test(s)), 'mentions the extension path shares the hooks');
    const settings = readJson(sb.claudeSettings);
    const ours = findOurEntries(settings);
    assert.strictEqual(ours.length, 2);
    assert.ok(ours[0].command.includes('--watchdog 90'));
    // The command pins every location the hook relies on, so environment variables cannot move them.
    for (const e of ours) {
      assert.ok(e.command.includes(`--home "${sb.env.explainitHome}"`), e.command);
      assert.ok(e.command.includes(`--claude-home "${path.join(sb.env.userHome, '.claude')}"`), e.command);
      assert.ok(e.command.includes(`--codex-home "${path.join(sb.env.userHome, '.codex')}"`), e.command);
    }
    assert.ok(!ours[0].command.includes('--unresponsive'), 'Claude keeps its own ask fallback');
    // Both wrappers pin the home on every platform: the POSIX one in the spelling Git Bash reads
    // (forward slashes on Windows, where `\` is an escape), the .cmd one as the native path.
    const pinnedHome = path.resolve(sb.env.explainitHome);
    const wrapper = fs.readFileSync(path.join(sb.env.hooksDir, 'explainit-hook.sh'), 'utf8');
    assert.ok(wrapper.includes(`EXPLAINIT_HOME=${shQuote(shPath(pinnedHome))}\nexport EXPLAINIT_HOME\n`), 'the .sh wrapper pins EXPLAINIT_HOME: ' + wrapper);
    const cmdWrapper = fs.readFileSync(path.join(sb.env.hooksDir, 'explainit-hook.cmd'), 'utf8');
    assert.ok(cmdWrapper.includes(`set "EXPLAINIT_HOME=${pinnedHome}"`), 'the .cmd wrapper pins EXPLAINIT_HOME: ' + cmdWrapper);
    assert.ok(fs.existsSync(path.join(sb.env.hooksDir, 'explainit-hook.js')));
    assert.ok(fs.existsSync(path.join(sb.env.hooksDir, 'explainit-hook.sh')));
    assert.ok(fs.existsSync(path.join(sb.env.hooksDir, 'explainit-hook.cmd')));
    const rec = sb.env.state.read().adapters!.claude!;
    assert.ok(rec.scriptHash && rec.wrapperHash && rec.configHash && rec.installedAt);
    assert.strictEqual(rec.configPath, sb.claudeSettings);
    assert.ok(rec.runtime && fs.existsSync(rec.runtime));
    const checks = sb.claude.verify();
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  });

  test('claude install preserves unrelated settings and hooks; uninstall removes only ours', async () => {
    fs.mkdirSync(path.dirname(sb.claudeSettings), { recursive: true });
    const original = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] } };
    fs.writeFileSync(sb.claudeSettings, JSON.stringify(original, null, 4) + '\n');
    await sb.claude.install();
    const after = readJson(sb.claudeSettings);
    assert.strictEqual(after.model, 'opus');
    assert.strictEqual(after.hooks.PreToolUse[0].hooks[0].command, 'guard.sh');
    assert.strictEqual(after.hooks.PreToolUse.length, 2);
    assert.ok(fs.readFileSync(sb.claudeSettings, 'utf8').includes('\n    "model"'), 'four-space indent preserved');
    assert.ok(fs.existsSync(sb.claudeSettings + '.explainit-backup'), 'backup kept');
    const second = await sb.claude.install();
    assert.strictEqual(second.changed, false, 'idempotent');
    const u = await sb.claude.uninstall();
    assert.strictEqual(u.ok, true);
    assert.strictEqual(u.changed, true);
    assert.deepStrictEqual(readJson(sb.claudeSettings), original);
    assert.strictEqual(sb.env.state.read().adapters?.claude, undefined);
    assert.strictEqual(sb.claude.isInstalled(), false);
  });

  test('invalid settings.json produces a plain-English failure, not a crash', async () => {
    fs.mkdirSync(path.dirname(sb.claudeSettings), { recursive: true });
    fs.writeFileSync(sb.claudeSettings, '{ broken');
    const r = await sb.claude.install();
    assert.strictEqual(r.ok, false);
    assert.match(r.detail ?? '', /not valid JSON/);
    assert.strictEqual(fs.readFileSync(sb.claudeSettings, 'utf8'), '{ broken', 'file untouched');
  });

  test('integrity detects a modified script, wrapper and config; rearm restores them', async () => {
    await sb.claude.install();
    const script = path.join(sb.env.hooksDir, 'explainit-hook.js');
    fs.appendFileSync(script, '\n// tampered\n');
    const wrapper = sb.env.state.read().adapters!.claude!.wrapperPath!;
    fs.appendFileSync(wrapper, '\n# tampered\n');
    const settings = readJson(sb.claudeSettings);
    settings.hooks.PreToolUse[0].hooks[0].command = 'something-else';
    fs.writeFileSync(sb.claudeSettings, JSON.stringify(settings, null, 2));
    const checks = sb.claude.verify();
    const failing = checks.filter((c) => !c.ok);
    assert.deepStrictEqual(
      failing.map((c) => c.name).sort(),
      ['Claude Code hook script', 'Claude Code hook wrapper', path.join('~', '.claude', 'settings.json')].sort(),
      JSON.stringify(checks),
    );
    assert.ok(failing.every((c) => c.fixable && c.detail && /Rearm/.test(c.detail)));
    const changed = await sb.claude.rearm();
    assert.strictEqual(changed, true);
    assert.ok(sb.claude.verify().every((c) => c.ok), JSON.stringify(sb.claude.verify()));
    assert.ok(!fs.readFileSync(script, 'utf8').includes('tampered'));
    assert.strictEqual(findOurEntries(readJson(sb.claudeSettings)).length, 2);
    assert.strictEqual(await sb.claude.rearm(), false, 'nothing to do when healthy');
  });

  test('integrity flags an outdated script when the extension ships a newer one', async () => {
    await sb.claude.install();
    fs.appendFileSync(path.join(sb.env.extensionPath, 'hooks', 'explainit-hook.js'), '\n// v2\n');
    const c = sb.claude.verify().find((x) => x.name === 'Claude Code hook script up to date');
    assert.ok(c && !c.ok && c.fixable);
    await sb.claude.rearm();
    assert.ok(!sb.claude.verify().some((x) => x.name === 'Claude Code hook script up to date'));
  });

  test('a changed watchdog setting shows as a fixable config mismatch and rearm rewrites it', async () => {
    await sb.claude.install();
    await sb.env.settings.set('gateWatchdogSeconds', 200);
    const c = sb.claude.verify().find((x) => x.name.endsWith('settings.json'));
    assert.ok(c && !c.ok && c.fixable, JSON.stringify(c));
    await sb.claude.rearm();
    assert.ok(findOurEntries(readJson(sb.claudeSettings))[0].command.includes('--watchdog 200'));
  });

  test('changing checkpoint.codexUnresponsive shows as a fixable codex config mismatch and rearm rewrites it', async () => {
    await sb.codex.install();
    await sb.env.settings.set('gateCodexUnresponsive', 'passthrough');
    const c = sb.codex.verify().find((x) => x.name.endsWith('hooks.json'));
    assert.ok(c && !c.ok && c.fixable, JSON.stringify(c));
    await sb.codex.rearm();
    assert.ok(findOurEntries(readJson(sb.codexHooks)).find((e) => e.event === 'PreToolUse')!.command.includes('--unresponsive passthrough'));
    assert.ok(sb.codex.verify().filter((x) => x.name !== 'Codex hook trust').every((x) => x.ok));
  });

  test('a tampered pin in the command (rogue --home) is a fixable mismatch and rearm restores the real one', async () => {
    await sb.claude.install();
    const settings = readJson(sb.claudeSettings);
    const entry = settings.hooks.PreToolUse[0].hooks[0];
    entry.command = entry.command.replace(`--home "${sb.env.explainitHome}"`, '--home "/rogue"');
    fs.writeFileSync(sb.claudeSettings, JSON.stringify(settings, null, 2));
    const c = sb.claude.verify().find((x) => x.name.endsWith('settings.json'));
    assert.ok(c && !c.ok && c.fixable, JSON.stringify(c));
    await sb.claude.rearm();
    assert.ok(findOurEntries(readJson(sb.claudeSettings)).every((e) => e.command.includes(`--home "${sb.env.explainitHome}"`)));
  });

  test('verify without an install reports "not connected" as ok, and orphan entries as fixable', async () => {
    assert.deepStrictEqual(sb.claude.verify().map((c) => c.ok), [true]);
    assert.match(sb.claude.verify()[0].detail ?? '', /Not connected/);
    fs.mkdirSync(path.dirname(sb.claudeSettings), { recursive: true });
    fs.writeFileSync(sb.claudeSettings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: '/old/explainit-hook.sh --agent claude' }] }] } }));
    const c = sb.claude.verify();
    assert.strictEqual(c[0].ok, false);
    assert.strictEqual(c[0].fixable, true);
    assert.ok(sb.claude.isInstalled());
    await sb.claude.rearm();
    assert.ok(sb.claude.verify().every((x) => x.ok));
  });

  test('codex install writes hooks.json with only "hooks" at top level and reports trust status', async () => {
    const r = await sb.codex.install();
    assert.strictEqual(r.ok, true, r.detail);
    assert.ok(r.nextSteps[0].includes('Trust'));
    const hooks = readJson(sb.codexHooks);
    assert.deepStrictEqual(Object.keys(hooks), ['hooks']);
    const ours = findOurEntries(hooks);
    assert.strictEqual(ours.length, 2);
    assert.strictEqual(ours.find((e) => e.event === 'PreToolUse')!.matcher, 'apply_patch|Edit|Write|Bash');
    assert.ok(ours[0].command.includes('--agent codex'));
    assert.ok(ours.find((e) => e.event === 'PreToolUse')!.command.includes('--unresponsive deny'), 'the default setting is deny');
    assert.ok(ours[0].command.includes(`--home "${sb.env.explainitHome}"`));
    // No config.toml yet -> untrusted, not fixable by us, with the trust instructions.
    let trust = sb.codex.verify().find((c) => c.name === 'Codex hook trust')!;
    assert.strictEqual(trust.ok, false);
    assert.strictEqual(trust.fixable, false);
    assert.match(trust.detail ?? '', /Trust/);
    // A matching trust record -> trusted.
    const pre = ours.find((e) => e.event === 'PreToolUse')!;
    const hash = codexHookHash('PreToolUse', pre.matcher, { command: pre.command, timeout: pre.timeout });
    // Seed the record through the same helper the adapter reads with: a Windows path has to be
    // TOML-escaped or its backslashes vanish when the key is parsed back.
    const header = codexHookStateHeader(sb.codexHooks, 'PreToolUse', pre.groupIndex, pre.handlerIndex);
    fs.writeFileSync(sb.codexConfig, `model = "x"\n\n${header}\nenabled = true\ntrusted_hash = "${hash}"\n`);
    trust = sb.codex.verify().find((c) => c.name === 'Codex hook trust')!;
    assert.strictEqual(trust.ok, true, trust.detail);
    // A stale record -> modified.
    fs.writeFileSync(sb.codexConfig, `${header}\ntrusted_hash = "sha256:stale"\n`);
    assert.strictEqual(sb.codex.trustStatus().status, 'modified');
    assert.ok(sb.codex.verify().every((c) => c.name === 'Codex hook trust' || c.ok));
  });

  test('codex install merges with existing hooks.json and uninstall leaves the rest', async () => {
    fs.mkdirSync(path.dirname(sb.codexHooks), { recursive: true });
    const original = { description: 'mine', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh', timeout: 5 }] }] } };
    fs.writeFileSync(sb.codexHooks, JSON.stringify(original, null, 2) + '\n');
    await sb.codex.install();
    const merged = readJson(sb.codexHooks);
    assert.strictEqual(merged.description, 'mine');
    assert.strictEqual(merged.hooks.PreToolUse[0].hooks[0].command, 'audit.sh');
    assert.strictEqual(merged.hooks.PreToolUse[1].matcher, 'apply_patch|Edit|Write|Bash');
    assert.strictEqual(sb.codex.trustStatus().status, 'untrusted');
    await sb.codex.uninstall();
    assert.deepStrictEqual(readJson(sb.codexHooks), original);
  });

  test('both agents share one script and wrapper set', async () => {
    await sb.claude.install();
    await sb.codex.install();
    const a = sb.env.state.read().adapters!;
    assert.strictEqual(a.claude!.scriptHash, a.codex!.scriptHash);
    assert.strictEqual(a.claude!.wrapperPath, a.codex!.wrapperPath);
    assert.ok(sb.claude.verify().every((c) => c.ok));
    const checks = sb.codex.verify();
    assert.ok(checks.filter((c) => c.name !== 'Codex hook trust').every((c) => c.ok), JSON.stringify(checks));
  });

  test('claude and codex can be installed at the same time (shared script and wrappers)', async () => {
    const [a, b] = await Promise.all([sb.claude.install(), sb.codex.install()]);
    assert.strictEqual(a.ok, true, a.detail);
    assert.strictEqual(b.ok, true, b.detail);
    assert.ok(!fs.readdirSync(sb.env.hooksDir).some((f) => f.endsWith('.tmp')), 'no temp files left behind');
    assert.ok(sb.claude.verify().every((c) => c.ok), JSON.stringify(sb.claude.verify()));
    assert.ok(sb.codex.verify().filter((c) => c.name !== 'Codex hook trust').every((c) => c.ok));
    const rec = sb.env.state.read().adapters!;
    assert.ok(rec.claude && rec.codex, 'both records survive the concurrent state updates');
  });

  test('a corrupt state.json is treated as "not connected" and a fresh install repairs it', async () => {
    fs.mkdirSync(path.dirname(sb.env.state.file), { recursive: true });
    fs.writeFileSync(sb.env.state.file, '{ corrupt');
    assert.strictEqual(sb.claude.isInstalled(), false);
    assert.ok(sb.claude.verify().every((c) => c.ok));
    const r = await sb.claude.install();
    assert.strictEqual(r.ok, true, r.detail);
    assert.ok(sb.env.state.read().adapters?.claude?.scriptHash);
  });

  test('a hooks.json with a non-object top level is reported in plain English and left untouched', async () => {
    fs.mkdirSync(path.dirname(sb.codexHooks), { recursive: true });
    fs.writeFileSync(sb.codexHooks, '[1, 2]');
    const r = await sb.codex.install();
    assert.strictEqual(r.ok, false);
    assert.match(r.detail ?? '', /not valid JSON/);
    assert.strictEqual(fs.readFileSync(sb.codexHooks, 'utf8'), '[1, 2]');
    assert.strictEqual(sb.codex.trustStatus().status, 'unknown');
  });

  test('verify is fast', async () => {
    await sb.claude.install();
    await sb.codex.install();
    const t = Date.now();
    for (let i = 0; i < 5; i++) {
      sb.claude.verify();
      sb.codex.verify();
    }
    assert.ok(Date.now() - t < 1000, `10 verify runs took ${Date.now() - t} ms`);
  });
});
