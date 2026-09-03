/**
 * Integration tests for the adapter manager (run inside VS Code by the integrator).
 * EXPLAINIT_TEST_MODE=1 makes the adapters use <EXPLAINIT_HOME>/user-home as the person's home,
 * so installs never touch the real ~/.claude or ~/.codex.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AdapterManager } from '../../../src/core/interfaces';
import { explainitHome } from '../../../src/core/paths';

interface Api {
  adapters: AdapterManager;
}

suite('adapters (integration)', function () {
  this.timeout(120000);
  let api: Api;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('BaharulIslam.explainit-code');
    assert.ok(ext, 'extension present');
    api = (await ext.activate()) as Api;
  });

  test('detect() returns entries for all three agents without throwing', async () => {
    const results = await api.adapters.detect();
    assert.deepStrictEqual(results.map((r) => r.agent).sort(), ['claude', 'codex', 'copilot']);
    for (const r of results) {
      assert.strictEqual(typeof r.present, 'boolean');
      assert.ok(r.detail && r.detail.length > 10, `${r.agent} has a plain-English detail`);
    }
  });

  test('verifyIntegrity() never throws, is fast and has plain-English checks', async () => {
    const t = Date.now();
    const report = await api.adapters.verifyIntegrity();
    const ms = Date.now() - t;
    assert.ok(Array.isArray(report.checks));
    assert.strictEqual(typeof report.ok, 'boolean');
    assert.ok(ms < 1000, `integrity took ${ms} ms`);
    for (const c of report.checks) assert.ok(c.name && c.detail);
  });

  test('states() lists claude, codex and copilot', async () => {
    const states = await api.adapters.states();
    assert.deepStrictEqual(states.map((s) => s.agent), ['claude', 'codex', 'copilot']);
    assert.strictEqual(states[2].armed, false, 'copilot is review-only, never armed');
  });

  test('hookScriptPath() points into the ExplainIT home', () => {
    const p = api.adapters.hookScriptPath();
    assert.ok(p.endsWith('explainit-hook.js'));
    assert.ok(p.startsWith(explainitHome()));
  });

  test('install/uninstall claude is surgical in the test user home, and rearm repairs tampering', async function () {
    if (process.env.EXPLAINIT_TEST_MODE !== '1' && !process.env.EXPLAINIT_USER_HOME) this.skip();
    const userHome = process.env.EXPLAINIT_USER_HOME ? path.resolve(process.env.EXPLAINIT_USER_HOME) : path.join(explainitHome(), 'user-home');
    const settings = path.join(userHome, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const original = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }] } };
    fs.writeFileSync(settings, JSON.stringify(original, null, 2) + '\n');
    try {
      const r = await api.adapters.install('claude');
      assert.strictEqual(r.ok, true, r.detail);
      assert.ok(r.nextSteps.length >= 1);
      const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
      assert.strictEqual(after.theme, 'dark');
      assert.strictEqual(after.hooks.PreToolUse[0].hooks[0].command, 'guard.sh');
      assert.ok(after.hooks.PreToolUse.some((g: any) => g.hooks.some((h: any) => String(h.command).includes('explainit-hook'))));
      assert.ok(fs.existsSync(api.adapters.hookScriptPath()));

      let report = await api.adapters.verifyIntegrity();
      const claudeChecks = report.checks.filter((c) => c.name.startsWith('Claude Code'));
      assert.ok(claudeChecks.length >= 3 && claudeChecks.every((c) => c.ok), JSON.stringify(claudeChecks));

      fs.appendFileSync(api.adapters.hookScriptPath(), '\n// tampered\n');
      report = await api.adapters.verifyIntegrity();
      assert.strictEqual(report.ok, false);
      const fixed = await api.adapters.rearm();
      assert.ok(fixed.checks.filter((c) => c.name.startsWith('Claude Code')).every((c) => c.ok), JSON.stringify(fixed.checks));
      assert.ok(!fs.readFileSync(api.adapters.hookScriptPath(), 'utf8').includes('tampered'));

      const states = await api.adapters.states();
      assert.strictEqual(states.find((s) => s.agent === 'claude')!.installed, true);

      const u = await api.adapters.uninstall('claude');
      assert.strictEqual(u.ok, true);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), original);
    } finally {
      await api.adapters.uninstall('claude').catch(() => undefined);
      fs.rmSync(settings, { force: true });
      fs.rmSync(settings + '.explainit-backup', { force: true });
    }
  });

  test('install/uninstall codex writes only hooks.json and reports trust honestly', async function () {
    if (process.env.EXPLAINIT_TEST_MODE !== '1' && !process.env.EXPLAINIT_USER_HOME) this.skip();
    const userHome = process.env.EXPLAINIT_USER_HOME ? path.resolve(process.env.EXPLAINIT_USER_HOME) : path.join(explainitHome(), 'user-home');
    const hooks = path.join(userHome, '.codex', 'hooks.json');
    try {
      const r = await api.adapters.install('codex');
      assert.strictEqual(r.ok, true, r.detail);
      assert.ok(r.nextSteps[0].includes('Trust'));
      const parsed = JSON.parse(fs.readFileSync(hooks, 'utf8'));
      assert.deepStrictEqual(Object.keys(parsed), ['hooks']);
      const report = await api.adapters.verifyIntegrity();
      const trust = report.checks.find((c) => c.name === 'Codex hook trust');
      assert.ok(trust && trust.ok === false && trust.fixable === false, JSON.stringify(trust));
      const u = await api.adapters.uninstall('codex');
      assert.strictEqual(u.ok, true);
      assert.ok(!fs.existsSync(hooks) || !fs.readFileSync(hooks, 'utf8').includes('explainit-hook'));
    } finally {
      await api.adapters.uninstall('codex').catch(() => undefined);
      fs.rmSync(hooks, { force: true });
    }
  });

  test('copilot install records the overlay and explains it is review-only', async () => {
    const r = await api.adapters.install('copilot');
    assert.strictEqual(r.ok, true);
    assert.ok(r.nextSteps.some((s) => /Keep\/Undo/.test(s)));
    const states = await api.adapters.states();
    assert.strictEqual(states.find((s) => s.agent === 'copilot')!.installed, true);
    await api.adapters.uninstall('copilot');
  });
});
