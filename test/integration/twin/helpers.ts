/**
 * Shared helpers for the twin integration suites. They run inside VS Code (extension host process),
 * so stubbing `api.router` with sinon replaces what the twin engine calls at run time.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { ExplainRequest, GenerationOptions, TextDocumentLike } from '../../../src/core/interfaces';
import type { Explanation } from '../../../src/core/types';
import type { ExplainitApi } from '../../../src/extension';

export async function getApi(): Promise<ExplainitApi> {
  const ext = vscode.extensions.getExtension('BaharulIslam.explainit');
  assert.ok(ext, 'extension not found');
  return (await ext!.activate()) as ExplainitApi;
}

export function workspaceRoot(): string {
  const f = vscode.workspace.workspaceFolders?.[0];
  assert.ok(f, 'no workspace folder');
  return f!.uri.fsPath;
}

export function fakeExplanation(f: { functionId: string; name: string; contentHash: string }, tag = ''): Explanation {
  return {
    functionId: f.functionId,
    name: f.name,
    summary: `${f.name} does one simple thing${tag}.`,
    steps: ['It looks at what it was given.', 'It works out the answer.', 'It hands the answer back.'],
    modelChannel: 'claude',
    createdAt: new Date().toISOString(),
    contentHash: f.contentHash,
  };
}

export interface RouterStub {
  explain: sinon.SinonStub;
  requests: ExplainRequest[];
  restore(): void;
}

/**
 * Replace the router's model calls with a deterministic fake. `delayMs` delays every request;
 * `perFunctionMs` streams each explanation through progress.onExplanation with that spacing.
 */
export function stubRouter(api: ExplainitApi, opts: { delayMs?: number; perFunctionMs?: number; failWith?: string } = {}): RouterStub {
  const requests: ExplainRequest[] = [];
  const sandbox = sinon.createSandbox();
  const explain = sandbox.stub(api.router, 'explainFunctions').callsFake(async (req: ExplainRequest, o?: GenerationOptions) => {
    requests.push(req);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.failWith) throw new Error(opts.failWith);
    const out: Explanation[] = [];
    for (const f of req.functions) {
      if (opts.perFunctionMs) await new Promise((r) => setTimeout(r, opts.perFunctionMs));
      const exp = fakeExplanation(f);
      out.push(exp);
      o?.progress?.onExplanation?.(exp);
    }
    return out;
  });
  sandbox.stub(api.router, 'resolveChannel').resolves('claude');
  sandbox.stub(api.router, 'availableChannels').resolves([{ channel: 'claude', available: true }]);
  return { explain, requests, restore: () => sandbox.restore() };
}

export function docLike(doc: vscode.TextDocument): TextDocumentLike {
  return { uri: doc.uri.toString(), fsPath: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined, languageId: doc.languageId, getText: () => doc.getText(), version: doc.version };
}

export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number, what: string, stepMs = 50): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await sleep(100);
}

export function visibleEditorFor(p: string): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file' && path.resolve(e.document.uri.fsPath) === path.resolve(p));
}

export function readText(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** Temp folder INSIDE the workspace (so sidecars and findFiles see it). Removed by `rm`. */
export function tempFolder(name: string): { dir: string; rm(): void } {
  const dir = path.join(workspaceRoot(), `twin-tmp-${name}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Delete every `*_explain.txt` under `root` (skipping node_modules/.git). */
export async function deleteTwins(root: string): Promise<string[]> {
  const removed: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('_explain.txt')) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    }
  };
  walk(root);
  return removed;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('explainit').update(key, value, vscode.ConfigurationTarget.Global);
}

export function pyFile(functions: string[]): string {
  return '"""temp module"""\nimport os\n\n\n' + functions.map((name) => `def ${name}(x):\n    value = x + 1\n    return value\n`).join('\n\n') + '\n';
}
