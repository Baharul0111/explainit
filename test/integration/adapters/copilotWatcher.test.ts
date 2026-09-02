/**
 * Copilot overlay integration test: an edit applied through the workspace (the way Copilot's agent
 * mode lands changes) must produce an "ExplainIT: what changed" CodeLens above the changed function.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { CopilotWatcher } from '../../../src/core/interfaces';
import { COPILOT_NOTICE } from '../../../src/adapters/copilotWatcher';

interface Api {
  copilot: CopilotWatcher;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

suite('copilot watcher (integration)', function () {
  this.timeout(120000);
  let api: Api;
  let dir: string;
  let file: string;
  let info: sinon.SinonStub;
  const noticeCount = (): number => info.getCalls().filter((c) => c.args[0] === COPILOT_NOTICE).length;

  suiteSetup(async () => {
    info = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    api = (await vscode.extensions.getExtension('BaharulIslam.explainit')!.activate()) as Api;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-copilot-'));
    file = path.join(dir, 'app.py');
    const fixture = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'src', 'app.py');
    fs.copyFileSync(fixture, file);
  });
  suiteTeardown(async () => {
    info.restore();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('creates a CodeLens above a function changed outside the gate', async () => {
    if (!api.copilot.running) api.copilot.start();
    assert.strictEqual(api.copilot.running, true);
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await sleep(800); // let the watcher snapshot the freshly opened document

    const text = doc.getText();
    const needle = 'message = "Hello, " + name';
    const offset = text.indexOf(needle);
    assert.ok(offset >= 0, 'fixture contains the greet body');
    const start = doc.positionAt(offset);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(start, doc.positionAt(offset + needle.length)), 'message = "Hi there, " + name');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await doc.save();

    const greetLine = doc.getText().split('\n').findIndex((l) => l.startsWith('def greet('));
    assert.ok(greetLine >= 0);
    let found: vscode.CodeLens | undefined;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !found) {
      const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri)) ?? [];
      found = lenses.find((l) => (l.command?.title ?? '').startsWith('ExplainIT: what changed'));
      if (!found) await sleep(1000);
    }
    assert.ok(found, 'an ExplainIT CodeLens appeared after the edit');
    assert.strictEqual(found.range.start.line, greetLine, 'lens sits above the changed function');
    assert.strictEqual(found.command?.command, 'explainit.copilot.showChange');
    assert.strictEqual(noticeCount(), 1, 'the review-only notice was shown once');
  });

  test('the review-only notice is not repeated for a second change', async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const needle = 'message = "Hi there, " + name';
    const offset = text.indexOf(needle);
    assert.ok(offset >= 0, 'the first edit landed');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + needle.length)), 'message = "Hey, " + name');
    assert.ok(await vscode.workspace.applyEdit(edit));
    await doc.save();
    await sleep(3000);
    assert.strictEqual(noticeCount(), 1, 'still exactly one notice');
  });
});
