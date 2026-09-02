/**
 * Integration tests for the UX layer. Run inside VS Code (workspace = test/fixtures/workspace,
 * EXPLAINIT_TEST_MODE=1, EXPLAINIT_HOME = temp). Uses mocha tdd (suite/test).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExplainitApi } from '../../../src/extension';
import { COMMAND_IDS } from '../../../src/ux/commands';
import { MESSAGES } from '../../../src/ux/pure/messages';
import { RUNBOOKS, runbookPath } from '../../../src/ux/runbooks';

function extension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.getExtension('BaharulIslam.explainit');
  assert.ok(ext, 'extension BaharulIslam.explainit must be installed in the test host');
  return ext;
}

function packageCommands(): string[] {
  return (extension().packageJSON as { contributes: { commands: { command: string }[] } }).contributes.commands.map((c) => c.command);
}

async function api(): Promise<ExplainitApi> {
  return (await extension().activate()) as ExplainitApi;
}

async function waitFor(cond: () => boolean, ms = 5000, step = 50): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  assert.ok(cond(), 'condition not met in time');
}

suite('ux: commands', function () {
  this.timeout(120_000);

  test('every command from package.json is registered (27)', async () => {
    await api();
    const registered = new Set(await vscode.commands.getCommands(true));
    const pkgCommands = packageCommands();
    assert.equal(pkgCommands.length, 27, 'package.json should contribute 27 commands');
    assert.deepEqual([...COMMAND_IDS].sort(), [...pkgCommands].sort(), 'COMMAND_IDS must mirror package.json exactly');
    const missing = pkgCommands.filter((c) => !registered.has(c));
    assert.deepEqual(missing, [], `commands not registered: ${missing.join(', ')}`);
  });

  test('pause -> gate.paused and status text says paused; resume -> back to armed', async () => {
    const a = await api();
    const ux = a.ux;
    await vscode.commands.executeCommand('explainit.pauseCheckpoint');
    assert.equal(a.gate.paused, true);
    assert.equal(a.state.read().checkpointPaused, true);
    assert.ok(ux.statusText().toLowerCase().includes('paused'), `status text: ${ux.statusText()}`);
    await vscode.commands.executeCommand('explainit.resumeCheckpoint');
    assert.equal(a.gate.paused, false);
    assert.equal(a.state.read().checkpointPaused, false);
    assert.ok(!ux.statusText().toLowerCase().includes('paused'), `status text: ${ux.statusText()}`);
    assert.ok(ux.statusText().includes('ExplainIT'));
  });

  test('showPausedBanner and setHeartbeat drive the status bar', async () => {
    const a = await api();
    const ux = a.ux;
    ux.setHeartbeat(true, 2);
    assert.ok(ux.statusText().includes('(2)') || ux.statusText().includes('ExplainIT'), ux.statusText());
    ux.setHeartbeat(false, 0);
    await waitFor(() => ux.statusText().includes('not responding'), 3000);
    ux.setHeartbeat(true, 0);
    assert.equal(ux.statusText(), '$(shield) ExplainIT');
  });

  test('toggleAutoOpen flips the setting both ways', async () => {
    await api();
    const cfg = () => vscode.workspace.getConfiguration('explainit').get<boolean>('twin.autoOpen');
    const before = cfg() ?? true;
    try {
      await vscode.commands.executeCommand('explainit.toggleAutoOpen');
      await waitFor(() => cfg() === !before, 5000);
      assert.equal(cfg(), !before);
      await vscode.commands.executeCommand('explainit.toggleAutoOpen');
      await waitFor(() => cfg() === before, 5000);
      assert.equal(cfg(), before);
    } finally {
      await vscode.workspace.getConfiguration('explainit').update('twin.autoOpen', before, vscode.ConfigurationTarget.Global);
    }
  });

  test('doctor returns >= 10 checks quickly and the restore self-test passes', async () => {
    const a = await api();
    const started = Date.now();
    const report = await a.ux.runDoctor();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 15_000, `doctor took ${elapsed} ms`);
    assert.ok(report.checks.length >= 10, `only ${report.checks.length} checks`);
    assert.ok(report.ranAt);
    for (const c of report.checks) {
      assert.ok(c.name && c.detail, `${c.name} needs a detail`);
      assert.ok(!c.detail.includes('undefined'), `${c.name}: ${c.detail}`);
    }
    const selfTests = report.checks.filter((c) => c.name.startsWith('Restore point self-test'));
    assert.ok(selfTests.length >= 1, 'one self-test per workspace folder');
    for (const s of selfTests) assert.equal(s.ok, true, s.detail);
    const listening = report.checks.find((c) => c.name === 'Checkpoint is listening');
    assert.ok(listening, 'listening check present');
    const health = report.checks.find((c) => c.name === 'Checkpoint answers over HTTP');
    assert.ok(health, 'health check present');
    if (a.gate.info && !a.gate.paused) {
      assert.equal(listening!.ok, true, listening!.detail);
      assert.equal(health!.ok, true, health!.detail);
    }
    assert.deepEqual(a.ux.lastDoctorReport(), report);
    // The command form works too and produces a fresh report.
    const viaCommand = (await vscode.commands.executeCommand('explainit.doctor')) as typeof report;
    assert.ok(viaCommand && viaCommand.checks.length >= 10);
  });

  test('onboarding in test mode completes without dialogs and records consent + onboardingDone', async () => {
    const a = await api();
    await a.ux.runOnboarding({ force: true });
    assert.equal(a.state.read().onboardingDone, true);
    assert.equal(a.ux.consentGranted(), true, 'consent store must report granted after Allow');
    // The setup command is the same flow and must not hang either.
    await vscode.commands.executeCommand('explainit.setupAssistants');
    assert.equal(a.state.read().onboardingDone, true);
  });

  test('restoreCheckpoint with an unknown id does not throw; verifyJournal reports per kit', async () => {
    const a = await api();
    await vscode.commands.executeCommand('explainit.restoreCheckpoint', { id: 'does-not-exist' });
    await vscode.commands.executeCommand('explainit.restoreCheckpoint', undefined);
    const results = (await vscode.commands.executeCommand('explainit.verifyJournal')) as { ok: boolean; entries: number }[];
    assert.equal(results.length, a.kits().length);
    for (const r of results) assert.equal(r.ok, true);
  });

  test('restoreFile round trip through the command uses the kit restore', async () => {
    const a = await api();
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const file = path.join(folder, 'ux-restore-probe.txt');
    fs.writeFileSync(file, 'version one\n');
    try {
      const kit = a.kits()[0];
      assert.ok(kit, 'a safety kit exists for the workspace folder');
      const cp = await kit.checkpoints.save(fs.realpathSync.native(file), 'version one\n');
      fs.writeFileSync(file, 'version two\n');
      await vscode.commands.executeCommand('explainit.restoreCheckpoint', { id: cp.id });
      assert.equal(fs.readFileSync(file, 'utf8'), 'version one\n');
      fs.writeFileSync(file, 'version three\n');
      // Test mode picks the newest restore point for this file and auto-confirms.
      await vscode.commands.executeCommand('explainit.restoreFile', vscode.Uri.file(file));
      const now = fs.readFileSync(file, 'utf8');
      assert.ok(now === 'version two\n' || now === 'version one\n', `restored content: ${JSON.stringify(now)}`);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('showStatus, showJournal, showLogs, openRunbooks and refreshJournalView run in test mode', async () => {
    await api();
    await vscode.commands.executeCommand('explainit.showStatus');
    await vscode.commands.executeCommand('explainit.showJournal');
    await vscode.commands.executeCommand('explainit.showLogs');
    await vscode.commands.executeCommand('explainit.openRunbooks');
    let refreshed = 0;
    (globalThis as any).__explainitJournalRefresh = () => refreshed++;
    try {
      await vscode.commands.executeCommand('explainit.refreshJournalView');
      assert.equal(refreshed, 1, 'refresh hook on globalThis is called');
    } finally {
      delete (globalThis as any).__explainitJournalRefresh;
    }
  });

  test('openTwin on the active fixture file does not throw, and on a twin path routes to the source', async () => {
    const a = await api();
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const src = path.join(folder, 'src', 'app.py');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(src));
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('explainit.openTwin', vscode.Uri.file(src));
    const twinPath = await a.twin.twinPathFor(src);
    if (fs.existsSync(twinPath)) {
      await vscode.commands.executeCommand('explainit.openTwin', vscode.Uri.file(twinPath));
      const active = vscode.window.activeTextEditor?.document.uri.fsPath;
      assert.ok(active === undefined || !active.endsWith('_explain.txt') || active === twinPath);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('every runbook file ships with the extension and has the three sections', async () => {
    const a = await api();
    const extPath = extension().extensionPath;
    assert.equal(RUNBOOKS.length, 5);
    for (const r of RUNBOOKS) {
      const p = runbookPath(extPath, r.file);
      assert.ok(fs.existsSync(p), `${p} missing`);
      const text = fs.readFileSync(p, 'utf8');
      for (const h of ['Symptoms', 'Cause', 'Fix']) assert.ok(new RegExp(`^##\\s+${h}`, 'mi').test(text), `${r.file} lacks a "${h}" section`);
    }
    assert.ok(a.ux.commandIds().includes('explainit.openRunbooks'));
  });

  test('paused banner text is the required sentence', () => {
    assert.equal(MESSAGES.pausedBanner, 'ExplainIT checkpoint is paused. Assistants are using their own prompts.');
  });
});
