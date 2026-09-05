import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureArmedWith } from '../../../src/adapters/arm';
import { ClaudeAdapter } from '../../../src/adapters/claude';
import { CodexAdapter } from '../../../src/adapters/codex';
import { makeAdapterEnv, type HostProbe } from '../../../src/adapters/installer';
import { createLogger } from '../../../src/core/log';
import { inMemorySettings } from '../../../src/core/settings';
import { createStateStore } from '../../../src/core/state';

/**
 * ensureArmed installs the checkpoint hook for every Claude Code / Codex found on this machine, but
 * only after consent, and never throws. Everything is redirected into a temp home so the real
 * ~/.claude and ~/.codex are never touched; on a machine without the assistants it reports "not found".
 */
suite('adapters: ensureArmed (fresh-machine arming)', function () {
  this.timeout(60_000);
  let root: string;
  const HOOK_SRC = path.join(__dirname, '..', '..', '..', '..', 'hooks', 'explainit-hook.js');

  const build = () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-ensure-armed-'));
    const extensionPath = path.join(root, 'ext');
    fs.mkdirSync(path.join(extensionPath, 'hooks'), { recursive: true });
    fs.copyFileSync(HOOK_SRC, path.join(extensionPath, 'hooks', 'explainit-hook.js'));
    const home = path.join(root, 'home');
    const userHome = path.join(root, 'user');
    fs.mkdirSync(userHome, { recursive: true });
    const probe: HostProbe = { findExtension: () => undefined, copilotModelCount: async () => 0 };
    const state = createStateStore(path.join(home, 'state.json'));
    const env = makeAdapterEnv({ logger: createLogger([], 'test'), settings: inMemorySettings(), extensionPath, version: '0.0.0' }, state, probe, {
      explainitHome: home,
      hooksDir: path.join(home, 'hooks'),
      userHome,
    });
    const claude = new ClaudeAdapter(env);
    const codex = new CodexAdapter(env);
    const detect = async () => Promise.all([claude.detect(), codex.detect()]);
    return { claude, codex, detect, userHome };
  };
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('without consent nothing is installed and the reason is plain English', async () => {
    const { claude, codex, detect, userHome } = build();
    const r = await ensureArmedWith({ agents: [claude, codex], detect, consentGranted: () => false, logger: createLogger([], 'test') });
    assert.deepStrictEqual(r.armed, []);
    assert.deepStrictEqual(r.failed, []);
    assert.ok(r.skipped.some((s) => /permission/i.test(s)), r.skipped.join(' | '));
    assert.ok(!fs.existsSync(path.join(userHome, '.claude', 'settings.json')));
  });

  test('with consent every assistant found is armed into the temp user home; the rest are reported as not found', async () => {
    const { claude, codex, detect, userHome } = build();
    const detected = await detect();
    const r = await ensureArmedWith({ agents: [claude, codex], detect, consentGranted: () => true, logger: createLogger([], 'test') });
    assert.deepStrictEqual(r.failed, [], JSON.stringify(r.failed));
    for (const agent of ['claude', 'codex'] as const) {
      const present = detected.find((d) => d.agent === agent)?.present === true;
      if (present) {
        assert.ok(r.armed.includes(agent), `${agent} should have been armed`);
        const file = agent === 'claude' ? path.join(userHome, '.claude', 'settings.json') : path.join(userHome, '.codex', 'hooks.json');
        assert.ok(fs.readFileSync(file, 'utf8').includes('explainit-hook'), `${file} carries the hook`);
      } else {
        assert.ok(r.skipped.some((s) => s.toLowerCase().includes(agent === 'claude' ? 'claude code' : 'codex')), `${agent} reported as not found`);
      }
    }
    const again = await ensureArmedWith({ agents: [claude, codex], detect, consentGranted: () => true, logger: createLogger([], 'test') });
    assert.deepStrictEqual(again.armed, []);
    assert.deepStrictEqual(again.failed, []);
    assert.deepStrictEqual([...again.alreadyArmed].sort(), [...r.armed].sort(), 'a second call finds everything already armed');
  });

  test('a detector that throws is reported, never thrown', async () => {
    const { claude, codex } = build();
    const r = await ensureArmedWith({ agents: [claude, codex], detect: async () => { throw new Error('boom'); }, consentGranted: () => true, logger: createLogger([], 'test') });
    assert.deepStrictEqual(r.armed, []);
    assert.ok(r.skipped.some((s) => s.includes('boom')));
  });
});
