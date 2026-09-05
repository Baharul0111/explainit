import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExplainitApi } from '../../../src/extension';
import { canonicalPath } from '../../../src/core/paths';
import { closeAllEditors, deleteTwins, docLike, getApi, setSetting, sleep, stubRouter, visibleEditorFor, waitFor, workspaceRoot } from './helpers';

/**
 * Per-project permission: nothing is explained in a project until the person says yes, a refused
 * project stays quiet, and the decision can be changed with the command. In test mode the question
 * is auto-answered "Explain this project" (EXPLAINIT_TEST_ANSWERS can override it).
 */
suite('twin engine (integration): per-project permission', function () {
  this.timeout(60_000);
  let api: ExplainitApi;
  let folder: string;
  let stub: ReturnType<typeof stubRouter>;

  suiteSetup(async () => {
    api = await getApi();
    folder = canonicalPath(workspaceRoot());
    stub = stubRouter(api);
    await setSetting('twin.autoOpen', true);
    await closeAllEditors();
    await deleteTwins(workspaceRoot());
  });

  suiteTeardown(async () => {
    await api.projectConsent.set(folder, 'allowed');
    await setSetting('twin.autoOpen', false);
    (stub as { restore?: () => void }).restore?.();
    await closeAllEditors();
    await deleteTwins(workspaceRoot());
  });

  test('a refused project gets no twin, neither on open nor on an explicit request', async () => {
    await api.projectConsent.set(folder, 'denied');
    assert.strictEqual(api.projectConsent.status(folder), 'denied');
    const src = path.join(workspaceRoot(), 'pkg', 'lib.rs');
    const twin = path.join(workspaceRoot(), 'pkg', 'lib_explain.txt');
    const doc = await vscode.workspace.openTextDocument(src);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    await sleep(2500);
    assert.ok(!fs.existsSync(twin), 'no twin may be written in a refused project');
    assert.ok(!visibleEditorFor(twin));
    const explicit = await api.twin.ensureTwin(docLike(doc), { open: true, silent: true });
    assert.strictEqual(explicit, undefined);
    assert.ok(!fs.existsSync(twin));
  });

  test('allowing the project turns explanations back on', async () => {
    await api.projectConsent.set(folder, 'allowed');
    const src = path.join(workspaceRoot(), 'pkg', 'Calculator.java');
    const twin = path.join(workspaceRoot(), 'pkg', 'Calculator_explain.txt');
    const doc = await vscode.workspace.openTextDocument(src);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    await waitFor(() => fs.existsSync(twin), 20_000, 'twin for an allowed project');
  });

  test('a project nobody decided on yet is asked once; the answer is remembered', async () => {
    await api.projectConsent.clear(folder);
    assert.strictEqual(api.projectConsent.status(folder), 'unknown');
    // A file no other suite touches, so earlier opens, closes or deleted twins cannot colour this test.
    const src = path.join(workspaceRoot(), 'pkg', 'permission_probe.py');
    const twin = path.join(workspaceRoot(), 'pkg', 'permission_probe_explain.txt');
    fs.writeFileSync(src, 'def probe(value):\n    """Return the value doubled."""\n    return value * 2\n');
    try {
      const doc = await vscode.workspace.openTextDocument(src);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
      // Test mode answers the question with "Explain this project" unless EXPLAINIT_TEST_ANSWERS says otherwise.
      await waitFor(() => api.projectConsent.status(folder) === 'allowed', 15_000, 'the project decision to be recorded');
      await waitFor(() => fs.existsSync(twin), 20_000, 'twin after the question was answered');
    } finally {
      await closeAllEditors();
      fs.rmSync(src, { force: true });
      fs.rmSync(twin, { force: true });
    }
  });

  test('the command changes the decision and reports it', async () => {
    await api.projectConsent.set(folder, 'denied');
    // In test mode the quick pick takes its default: the first item, "Explain this project".
    await vscode.commands.executeCommand('explainit.projectPermission');
    assert.strictEqual(api.projectConsent.status(folder), 'allowed');
  });

  test('the "always" setting skips the question', async () => {
    await api.projectConsent.clear(folder);
    await setSetting('twin.projectPermission', 'always');
    try {
      assert.strictEqual(api.twin.projectGate.status(path.join(workspaceRoot(), 'src', 'app.py')), 'allowed');
    } finally {
      await setSetting('twin.projectPermission', 'ask');
    }
    assert.strictEqual(api.twin.projectGate.status(path.join(workspaceRoot(), 'src', 'app.py')), 'unknown');
  });
});
