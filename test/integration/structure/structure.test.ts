/**
 * Runs inside VS Code (workspace = test/fixtures/workspace, EXPLAINIT_TEST_MODE=1).
 * Covers the vscode glue of the structure engine: the built-in TypeScript symbol provider,
 * the tree-sitter fallback for a language without a provider, virtual documents for proposed
 * text, and the 5 s readiness cap.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { AiSegment, GenerationRouter, StructureEngine } from '../../../src/core/interfaces';
import type { FunctionMap } from '../../../src/core/types';
import { resolveWasmDir, TreeSitterService } from '../../../src/structure/pure/treeSitter';
import type { StructureTestHooks } from '../../../src/structure';

type Api = { structure: StructureEngine & { __test?: StructureTestHooks }; router: GenerationRouter };

const workspaceRoot = (): string => vscode.workspace.workspaceFolders![0].uri.fsPath;
const fixturePath = (rel: string): string => path.join(workspaceRoot(), ...rel.split('/'));
const names = (map: FunctionMap): string[] => map.functions.map((f) => f.name);

/** The TypeScript server starts lazily; wait until it outlines a file before timing the engine. */
async function waitForTsSymbols(uri: vscode.Uri, maxMs = 90_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const result = await vscode.commands.executeCommand<unknown[]>('vscode.executeDocumentSymbolProvider', uri);
    if (Array.isArray(result) && result.length) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The built-in TypeScript symbol provider did not answer within 90 s');
}

suite('structure engine (integration)', function () {
  this.timeout(180_000);
  let api: Api;
  let extensionPath: string;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('BaharulIslam.explainit');
    assert.ok(ext, 'extension BaharulIslam.explainit should be installed in the test host');
    api = (await ext!.activate()) as Api;
    extensionPath = ext!.extensionPath;
    assert.ok(api.structure, 'activate() should expose the structure engine');
  });

  test('src/util.ts: the built-in TypeScript provider answers and matches the tree-sitter names', async () => {
    const uri = vscode.Uri.file(fixturePath('src/util.ts'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await waitForTsSymbols(uri);

    const map = await api.structure.getFunctionMap({ uri: doc.uri.toString(), fsPath: doc.uri.fsPath, languageId: doc.languageId, getText: () => doc.getText() });
    assert.equal(map.source, 'symbols', `expected the symbol provider, got ${map.source}`);
    assert.equal(map.languageId, 'typescript');

    const wasmDir = resolveWasmDir(extensionPath);
    assert.ok(wasmDir, 'dist/wasm (or node_modules) should hold the grammars');
    const ts = new TreeSitterService({ wasmDir: wasmDir! });
    try {
      const parsed = await ts.parseFunctions(doc.getText(), 'typescript');
      assert.ok(parsed);
      const expected = parsed!.functions.map((f) => f.name).sort();
      assert.deepEqual(names(map).sort(), expected);
      assert.deepEqual(expected, ['UserStore.add', 'UserStore.find', 'add', 'fetchJson', 'slugify']);
    } finally {
      ts.dispose();
    }
    for (const f of map.functions) {
      assert.ok(f.range.startLine <= f.range.endLine);
      assert.match(f.id, /^.+#\d+$/);
      assert.equal(f.contentHash.length, 64);
    }
  });

  test('src/app.py: no Python extension in the test host, so tree-sitter answers quickly', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fixturePath('src/app.py')));
    assert.equal(doc.languageId, 'python');
    const started = Date.now();
    const map = await api.structure.getFunctionMap({ uri: doc.uri.toString(), fsPath: doc.uri.fsPath, languageId: doc.languageId, getText: () => doc.getText() });
    const elapsed = Date.now() - started;
    assert.equal(map.source, 'tree-sitter', `expected tree-sitter, got ${map.source}`);
    assert.deepEqual(names(map), ['load_config', 'greet', 'Server.__init__', 'Server.start', 'Server.stop', 'main']);
    assert.ok(elapsed < 6000, `took ${elapsed}ms`);
    assert.ok(api.structure.treeSitterLanguages().includes('python'));
  });

  test('getFunctionMapForText outlines proposed TypeScript text through a virtual document and cleans up', async () => {
    const text = [
      'export function proposedOne(a: number): number {',
      '  return a + 1;',
      '}',
      'export const proposedTwo = (b: string) => b.trim();',
      'class Widget {',
      '  render(): string {',
      '    return "ok";',
      '  }',
      '}',
      '',
    ].join('\n');
    const uriHint = vscode.Uri.file(fixturePath('src/proposed-not-on-disk.ts')).toString();
    assert.ok(!fs.existsSync(fixturePath('src/proposed-not-on-disk.ts')));
    const map = await api.structure.getFunctionMapForText(text, 'typescript', uriHint);
    assert.equal(map.fileUri, uriHint);
    assert.ok(['symbols', 'tree-sitter'].includes(map.source), `unexpected source ${map.source}`);
    assert.deepEqual(names(map).sort(), ['Widget.render', 'proposedOne', 'proposedTwo']);
    const two = map.functions.find((f) => f.name === 'proposedTwo')!;
    assert.deepEqual(two.range, { startLine: 3, endLine: 3 });
    assert.equal(api.structure.__test?.proposedCount(), 0, 'the proposed text should be released after the call');
    assert.ok(!fs.existsSync(fixturePath('src/proposed-not-on-disk.ts')), 'nothing may be written to disk');
  });

  test('getFunctionMapForText falls back for a language nobody outlines', async () => {
    const cobol = fs.readFileSync(fixturePath('legacy/report.cob'), 'utf8');
    const map = await api.structure.getFunctionMapForText(cobol, 'cobol', vscode.Uri.file(fixturePath('legacy/report.cob')).toString());
    assert.equal(map.source, 'heuristic');
    assert.deepEqual(names(map), ['MAIN-PARA', 'READ-INPUT', 'PRINT-TOTAL']);
  });

  test('readiness retry never exceeds 5 s for a plausible language whose provider finds nothing', async () => {
    // Markdown has a built-in symbol provider (headings) but this prose has none, so the engine walks
    // the whole backoff schedule before giving up; it must still stay under the 5 s cap.
    assert.equal(api.structure.__test?.isPlausible('markdown'), true);
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: 'Just prose here.\nNo headings at all.\nThird line of prose.\n' });
    const started = Date.now();
    const map = await api.structure.getFunctionMap({ uri: doc.uri.toString(), languageId: doc.languageId, getText: () => doc.getText() });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5500, `readiness retry took ${elapsed}ms`);
    assert.equal(map.functions.length, 0);
    assert.equal(map.source, 'none');
  });

  test('a language without any installed extension is not retried (fast path)', async () => {
    assert.equal(api.structure.__test?.isPlausible('cobol'), false);
    const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'hello\nworld\nthis is not code at all\n' });
    const started = Date.now();
    const map = await api.structure.getFunctionMap({ uri: doc.uri.toString(), languageId: doc.languageId, getText: () => doc.getText() });
    assert.ok(Date.now() - started < 1500);
    assert.equal(map.functions.length, 0);
  });

  test('AI segmentation (REQ-012) runs only when the caller allows it, and its answer becomes an "ai" map', async () => {
    // Fortran: no symbol provider in the test host, no tree-sitter grammar, no heuristic keyword.
    const text = 'subroutine foo(x)\n  integer :: x\n  x = x + 1\nend subroutine foo\n\nsubroutine bar(y)\n  y = 0\nend subroutine bar\n';
    const uriHint = vscode.Uri.file(fixturePath('legacy/not-on-disk.f90')).toString();
    assert.ok(!api.structure.treeSitterLanguages().includes('fortran'));
    const segments: AiSegment[] = [
      { name: 'foo', startLine: 0, endLine: 3 },
      { name: 'bar', startLine: 5, endLine: 7 },
      { name: '', startLine: 0, endLine: 1 }, // nonsense from the model is dropped
      { name: 'beyond', startLine: 40, endLine: 50 },
    ];
    const sandbox = sinon.createSandbox();
    const segment = sandbox.stub(api.router, 'segmentWithAi').resolves(segments);
    try {
      const silent = await api.structure.getFunctionMapForText(text, 'fortran', uriHint);
      assert.equal(silent.source, 'none', 'without allowAi nothing may spend credits');
      assert.equal(silent.functions.length, 0);
      assert.equal(segment.callCount, 0, 'segmentWithAi must not be called unless allowAi is set');

      const map = await api.structure.getFunctionMapForText(text, 'fortran', uriHint, { allowAi: true });
      assert.equal(segment.callCount, 1);
      const req = segment.firstCall.args[0] as { fileName: string; languageId: string; text: string };
      assert.deepEqual([req.fileName, req.languageId, req.text], ['not-on-disk.f90', 'fortran', text]);
      assert.equal(map.source, 'ai');
      assert.deepEqual(map.functions.map((f) => [f.name, f.range.startLine, f.range.endLine, f.source]), [['foo', 0, 3, 'ai'], ['bar', 5, 7, 'ai']]);
      for (const f of map.functions) assert.equal(f.contentHash.length, 64);

      // A failing assistant degrades to "none" instead of throwing.
      segment.rejects(new Error('The assistant did not answer.'));
      const failed = await api.structure.getFunctionMapForText(text, 'fortran', uriHint, { allowAi: true });
      assert.equal(failed.source, 'none');
      assert.equal(failed.functions.length, 0);
    } finally {
      sandbox.restore();
    }
  });

  test('an empty document yields an empty map without touching any provider', async () => {
    const map = await api.structure.getFunctionMapForText('', 'typescript', 'file:///empty.ts');
    assert.equal(map.source, 'none');
    assert.equal(map.functions.length, 0);
  });
});
