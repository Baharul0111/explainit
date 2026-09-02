/**
 * Journal & safety inside VS Code (workspace = test/fixtures/workspace, EXPLAINIT_HOME = temp folder,
 * EXPLAINIT_TEST_MODE=1). Uses the ExplainitApi from activate() and the view test hook the module
 * publishes in test mode (`globalThis.__explainitJournalViewTestHook`).
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExplainitApi } from '../../../src/extension';
import type { SafetyKit } from '../../../src/core/interfaces';
import type { Checkpoint, JournalEntry } from '../../../src/core/types';
import { quickPickRestore } from '../../../src/journal';

interface ViewHook {
  provider: {
    getChildren(node?: unknown): Promise<unknown[]>;
    getTreeItem(node: unknown): vscode.TreeItem & { checkpointId?: string };
  };
  view: { refresh(): void; restore(itemOrId: unknown): Promise<void> };
}

type Node = { type: string; path?: string; checkpoint?: Checkpoint; entry?: JournalEntry };

suite('journal integration', function () {
  this.timeout(120_000);

  let api: ExplainitApi;
  let kit: SafetyKit;
  let folder: string;
  const created: string[] = [];

  const tempFile = (name: string): string => {
    const p = path.join(folder, `tmp-journal-${name}-${Date.now()}.txt`);
    created.push(p);
    return p;
  };

  const hook = (): ViewHook => {
    const h = (globalThis as Record<string, unknown>).__explainitJournalViewTestHook as ViewHook | undefined;
    assert.ok(h, 'the journal view publishes a test hook in EXPLAINIT_TEST_MODE');
    return h;
  };

  /** Walks folder nodes (multi-root) or the root (single folder) to find the file node for `p`. */
  const findFileNode = async (h: ViewHook, p: string): Promise<Node | undefined> => {
    const roots = (await h.provider.getChildren()) as Node[];
    const files: Node[] = [];
    for (const r of roots) {
      if (r.type === 'folder') files.push(...((await h.provider.getChildren(r)) as Node[]));
      else files.push(r);
    }
    const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    return files.find((n) => n.type === 'file' && n.path !== undefined && norm(path.resolve(n.path)) === norm(path.resolve(p)));
  };

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('BaharulIslam.explainit');
    assert.ok(ext, 'extension is installed in the test host');
    api = await ext.activate();
    const kits = api.kits();
    assert.ok(kits.length >= 1, 'one safety kit per workspace folder');
    kit = kits[0];
    folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  });

  suiteTeardown(async () => {
    for (const p of created) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  });

  test('the kit stores its files under EXPLAINIT_HOME, never in the workspace', () => {
    const home = process.env.EXPLAINIT_HOME;
    assert.ok(home, 'EXPLAINIT_HOME is set for integration tests');
    assert.ok(path.resolve(kit.journal.file).startsWith(path.resolve(home)), kit.journal.file);
    assert.ok(!path.resolve(kit.journal.file).startsWith(path.resolve(folder)));
  });

  test('append an entry and verify the chain', async () => {
    const p = tempFile('append');
    fs.writeFileSync(p, 'hello\n');
    const e = await kit.journal.append({ kind: 'proposed', path: p, agent: 'claude', requestId: 'it-1' });
    assert.strictEqual(e.version, 1);
    assert.ok(e.seq >= 1);
    assert.strictEqual(e.hash.length, 64);
    const listed = await kit.journal.list({ path: p });
    assert.strictEqual(listed[listed.length - 1].hash, e.hash);
    const v = await kit.journal.verifyChain();
    assert.strictEqual(v.ok, true, v.detail);
    assert.ok(v.entries >= 1);
  });

  test('the tree view provider returns the file with its entries and restore points', async () => {
    const h = hook();
    const p = tempFile('tree');
    fs.writeFileSync(p, 'v1\n');
    const cp = await kit.checkpoints.save(p, 'v1\n', { agent: 'claude', requestId: 'it-2' });
    await kit.journal.append({ kind: 'decided', path: p, agent: 'claude', requestId: 'it-2', checkpointId: cp.id, decision: { requestId: 'it-2', verdict: 'accept', scope: 'one', decidedAt: new Date().toISOString() } });
    h.view.refresh();

    const fileNode = await findFileNode(h, p);
    assert.ok(fileNode, 'file node for the temp file');
    const fileItem = h.provider.getTreeItem(fileNode);
    assert.strictEqual(fileItem.contextValue, 'file');
    assert.match(String(fileItem.description), /accepted by you · just now/);
    assert.strictEqual(fileItem.label, path.basename(p), 'shown relative to the workspace folder');

    const children = (await h.provider.getChildren(fileNode)) as Node[];
    const cpNode = children.find((c) => c.type === 'checkpoint' && c.checkpoint?.id === cp.id);
    assert.ok(cpNode, 'restore point child');
    const cpItem = h.provider.getTreeItem(cpNode);
    assert.strictEqual(cpItem.contextValue, 'checkpoint');
    assert.strictEqual(cpItem.checkpointId, cp.id);
    assert.deepStrictEqual(cpItem.command?.arguments, [cp.id], 'the click command carries the checkpoint id');
    assert.match(String(cpItem.description), /before a change by Claude Code/);
    const entryNode = children.find((c) => c.type === 'entry' && c.entry?.checkpointId === cp.id);
    assert.ok(entryNode, 'journal entry child');
    assert.strictEqual(h.provider.getTreeItem(entryNode).label, 'Accepted by you');
  });

  test('restore through the view writes the file back and keeps a safety restore point', async () => {
    const h = hook();
    const p = tempFile('restore');
    fs.writeFileSync(p, 'first version\n');
    const cp = await kit.checkpoints.save(p, 'first version\n', { agent: 'codex' });
    fs.writeFileSync(p, 'second version\n');

    await h.view.restore(cp.id);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'first version\n');
    const points = await kit.checkpoints.list(p);
    assert.strictEqual(points.length, 2);
    assert.strictEqual((await kit.checkpoints.read(points[0].id))?.content, 'second version\n', 'newest restore point holds what was replaced');
    const restored = (await kit.journal.list({ path: p })).filter((e) => e.kind === 'restored');
    assert.strictEqual(restored.length, 1);
    assert.strictEqual(restored[0].checkpointId, cp.id);

    // Restoring by tree item (what the inline button passes) works too.
    fs.writeFileSync(p, 'third version\n');
    const fileNode = await findFileNode(h, p);
    assert.ok(fileNode);
    const children = (await h.provider.getChildren(fileNode)) as Node[];
    const cpNode = children.find((c) => c.type === 'checkpoint' && c.checkpoint?.id === cp.id);
    assert.ok(cpNode);
    await h.view.restore(h.provider.getTreeItem(cpNode));
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'first version\n');
    assert.strictEqual((await kit.journal.verifyChain()).ok, true);
  });

  test('restore with an unknown id or no argument reports instead of throwing', async () => {
    const h = hook();
    await h.view.restore('no-such-restore-point');
    await h.view.restore(undefined);
  });

  test('restore refuses to overwrite a file with unsaved changes in the editor', async () => {
    const h = hook();
    const p = tempFile('dirty');
    fs.writeFileSync(p, 'saved\n');
    const cp = await kit.checkpoints.save(p, 'saved\n');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), 'unsaved '));
    assert.ok(doc.isDirty);
    await h.view.restore(cp.id);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'saved\n', 'disk untouched');
    assert.strictEqual((await kit.checkpoints.list(p)).length, 1, 'no safety restore point was made');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('quickPickRestore restores the chosen restore point (auto-answered in test mode)', async () => {
    const p = tempFile('quickpick');
    fs.writeFileSync(p, 'alpha\n');
    await kit.checkpoints.save(p, 'alpha\n');
    fs.writeFileSync(p, 'beta\n');
    const previous = process.env.EXPLAINIT_TEST_ANSWERS;
    process.env.EXPLAINIT_TEST_ANSWERS = JSON.stringify({ restore: 0 });
    try {
      await quickPickRestore(api.kits(), p);
    } finally {
      if (previous === undefined) delete process.env.EXPLAINIT_TEST_ANSWERS;
      else process.env.EXPLAINIT_TEST_ANSWERS = previous;
    }
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'alpha\n');
  });

  test('quickPickRestore with no restore points does not throw', async () => {
    await quickPickRestore(api.kits(), path.join(folder, 'never-saved.txt'));
    await quickPickRestore(api.kits(), path.join(folder, 'never-saved.txt'), undefined);
  });

  test('the restore self-test passes and journals a system note', async () => {
    const r = await kit.checkpoints.selfTest();
    assert.strictEqual(r.ok, true, r.detail);
    const notes = (await kit.journal.list()).filter((e) => e.kind === 'system' && /self-test passed/.test(e.note ?? ''));
    assert.ok(notes.length >= 1);
    assert.strictEqual((await kit.journal.verifyChain()).ok, true);
  });
});
