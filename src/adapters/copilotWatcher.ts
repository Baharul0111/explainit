/**
 * Copilot compose path (REQ-018). Copilot cannot be stopped before it writes, so ExplainIT watches
 * open file documents, notices changes the gate did not land, works out which functions changed,
 * and shows a CodeLens ("ExplainIT: what changed — ...") plus a gutter highlight above each one.
 * Clicking the lens shows the full plain-English change explanation. When the person keeps the
 * change (30 s without further edits) the snapshot moves forward and the lenses clear.
 */
import * as vscode from 'vscode';
import { CancelSource } from '../core/cancel';
import type { CopilotWatcher, CoreDeps, Disposable, GenerationRouter, StructureEngine, TextDocumentLike, TwinEngine } from '../core/interfaces';
import { canonicalPath } from '../core/paths';
import { landedRecently } from '../core/landing';
import type { ChangeExplanation, FunctionMap } from '../core/types';
import { diffFunctionMaps, lensTitle, MAX_WATCHED_BYTES, shouldWatchPath, type FunctionChange, type LensState } from './pure/copilotDiff';

export const SHOW_CHANGE_COMMAND = 'explainit.copilot.showChange';
export const COPILOT_NOTICE = 'Copilot changes cannot be stopped before they land. ExplainIT reviews them after they land — use Copilot\'s own Keep/Undo to decide.';
const DEBOUNCE_MS = 1500;
const KEEP_MS = 30_000;
const MAX_SNAPSHOTS = 200;

interface Snapshot {
  text: string;
  languageId: string;
  map?: FunctionMap;
}

interface LensItem extends LensState {
  line: number;
  change: FunctionChange;
  explanation?: ChangeExplanation;
}

interface FileReview {
  items: LensItem[];
  cancel: CancelSource;
  keepTimer?: NodeJS.Timeout;
}

export function createCopilotWatcher(deps: CoreDeps & { structure: StructureEngine; router: GenerationRouter; twin: TwinEngine; disposables: Disposable[] }): CopilotWatcher {
  const log = deps.logger.child('copilot');
  const snapshots = new Map<string, Snapshot>();
  const reviews = new Map<string, FileReview>();
  const debounces = new Map<string, NodeJS.Timeout>();
  let running = false;
  let noticeShown = false;
  let subs: vscode.Disposable[] = [];

  const lensEmitter = new vscode.EventEmitter<void>();
  const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  let refreshTimer: NodeJS.Timeout | undefined;
  const refresh = (): void => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      lensEmitter.fire();
      applyDecorations();
    }, 250);
  };

  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensEmitter.event,
    provideCodeLenses(doc) {
      if (!running || doc.uri.scheme !== 'file') return [];
      const review = reviews.get(keyOf(doc));
      if (!review) return [];
      return review.items.map((it) => {
        const line = Math.min(it.line, Math.max(0, doc.lineCount - 1));
        const range = new vscode.Range(line, 0, line, 0);
        return new vscode.CodeLens(range, { title: lensTitle(it), command: SHOW_CHANGE_COMMAND, arguments: [keyOf(doc), it.name, it.line] });
      });
    },
  };

  deps.disposables.push(
    lensEmitter,
    decoration,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider),
    vscode.commands.registerCommand(SHOW_CHANGE_COMMAND, (key: string, name: string, line: number) => showChange(key, name, line)),
    { dispose: () => stop() },
  );

  function keyOf(doc: vscode.TextDocument): string {
    return canonicalPath(doc.uri.fsPath);
  }

  function watchable(doc: vscode.TextDocument): boolean {
    if (doc.uri.scheme !== 'file') return false;
    if (!shouldWatchPath(doc.uri.fsPath, (p) => deps.twin.isTwinPath(p))) return false;
    return true;
  }

  function takeSnapshot(doc: vscode.TextDocument): void {
    if (!watchable(doc)) return;
    const text = doc.getText();
    if (text.length > MAX_WATCHED_BYTES) return;
    const key = keyOf(doc);
    snapshots.delete(key);
    snapshots.set(key, { text, languageId: doc.languageId });
    if (snapshots.size > MAX_SNAPSHOTS) {
      const oldest = snapshots.keys().next().value;
      if (oldest) snapshots.delete(oldest);
    }
  }

  function docLike(doc: vscode.TextDocument): TextDocumentLike {
    return { uri: doc.uri.toString(), fsPath: doc.uri.fsPath, languageId: doc.languageId, getText: () => doc.getText(), version: doc.version };
  }

  function scheduleReview(doc: vscode.TextDocument, delay: number): void {
    if (!running || !watchable(doc)) return;
    const key = keyOf(doc);
    const t = debounces.get(key);
    if (t) clearTimeout(t);
    debounces.set(
      key,
      setTimeout(() => {
        debounces.delete(key);
        void review(doc).catch((e) => log.warn('copilot review failed', e));
      }, delay),
    );
  }

  async function review(doc: vscode.TextDocument): Promise<void> {
    if (!running || doc.isClosed) return;
    const key = keyOf(doc);
    const current = doc.getText();
    if (current.length > MAX_WATCHED_BYTES) return;
    const snap = snapshots.get(key);
    if (landedRecently(key, 10_000)) {
      // The gate wrote this (Claude/Codex accepted change): move the snapshot on, nothing to review.
      takeSnapshot(doc);
      clearReview(key);
      return;
    }
    if (!snap) {
      takeSnapshot(doc);
      return;
    }
    if (snap.text === current) {
      armKeepTimer(key, doc);
      return;
    }
    if (!snap.map) snap.map = await deps.structure.getFunctionMapForText(snap.text, snap.languageId, doc.uri.toString());
    const afterMap = await deps.structure.getFunctionMap(docLike(doc));
    if (!running || doc.isClosed) return;
    if (doc.getText() !== current) {
      // The text moved on while the maps were being built; look again once it settles.
      scheduleReview(doc, DEBOUNCE_MS);
      return;
    }
    const changes = diffFunctionMaps(snap.map, snap.text, afterMap, current);
    const existing = reviews.get(key);
    existing?.cancel.cancel();
    if (existing?.keepTimer) clearTimeout(existing.keepTimer);
    if (changes.length === 0) {
      reviews.delete(key);
      refresh();
      armKeepTimer(key, doc);
      return;
    }
    const cancel = new CancelSource();
    const items: LensItem[] = changes
      .filter((c) => c.line !== undefined)
      .map((c) => ({ name: c.name, changeType: c.changeType, line: c.line!, change: c, status: 'pending' }));
    const fileReview: FileReview = { items, cancel };
    reviews.set(key, fileReview);
    refresh();
    if (!noticeShown) {
      noticeShown = true;
      void vscode.window.showInformationMessage(COPILOT_NOTICE);
    }
    log.info(`copilot overlay: ${changes.length} changed function(s) in ${doc.uri.fsPath}`);
    armKeepTimer(key, doc);
    await explainAll(doc, fileReview);
    // Give the person 30 s to read the finished explanations before the lenses clear.
    if (reviews.get(key) === fileReview && !doc.isClosed) armKeepTimer(key, doc);
  }

  async function explainAll(doc: vscode.TextDocument, r: FileReview): Promise<void> {
    for (const it of r.items) {
      if (r.cancel.token.isCancellationRequested) return;
      it.status = 'streaming';
      it.summary = '';
      try {
        const exp = await deps.router.explainChange(
          { fileName: doc.uri.fsPath, languageId: doc.languageId, functionName: it.name, changeType: it.changeType, beforeText: it.change.beforeText, afterText: it.change.afterText },
          {
            token: r.cancel.token,
            progress: {
              onText: (chunk) => {
                it.summary = (it.summary ?? '') + chunk;
                refresh();
              },
            },
          },
        );
        it.explanation = exp;
        it.summary = exp.whatChanged;
        it.status = 'done';
      } catch (e) {
        it.status = 'error';
        it.error = friendlyError(e);
      }
      refresh();
    }
  }

  function friendlyError(e: unknown): string {
    const msg = (e as Error)?.message ?? String(e);
    if (/cancel/i.test(msg)) return 'cancelled';
    if (/no (channel|assistant)|not connected|unavailable|consent/i.test(msg)) return 'no assistant connected (run "ExplainIT: Set up assistants")';
    return 'explanation failed: ' + msg.split('\n')[0].slice(0, 60);
  }

  function armKeepTimer(key: string, doc: vscode.TextDocument): void {
    const r = reviews.get(key);
    if (!r) return;
    if (r.keepTimer) clearTimeout(r.keepTimer);
    r.keepTimer = setTimeout(() => {
      // 30 s without further changes (and after the explanations arrived): the person kept the change.
      // Move the snapshot and clear the lenses.
      if (!doc.isClosed) takeSnapshot(doc);
      clearReview(key);
    }, KEEP_MS);
  }

  function clearReview(key: string): void {
    const r = reviews.get(key);
    if (!r) return;
    r.cancel.cancel();
    if (r.keepTimer) clearTimeout(r.keepTimer);
    reviews.delete(key);
    refresh();
  }

  function applyDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== 'file') continue;
      const r = running ? reviews.get(keyOf(editor.document)) : undefined;
      const ranges = (r?.items ?? []).map((it) => {
        const line = Math.min(it.line, Math.max(0, editor.document.lineCount - 1));
        return new vscode.Range(line, 0, line, 0);
      });
      editor.setDecorations(decoration, ranges);
    }
  }

  async function showChange(key: string, name: string, line: number): Promise<void> {
    const r = reviews.get(key);
    const it = r?.items.find((i) => i.name === name && i.line === line) ?? r?.items.find((i) => i.name === name);
    if (!it) {
      void vscode.window.showInformationMessage('ExplainIT: this change was kept and its note has been cleared.');
      return;
    }
    if (it.status === 'pending' || it.status === 'streaming') {
      void vscode.window.showInformationMessage(`ExplainIT is still explaining ${it.name}… try again in a moment.`);
      return;
    }
    if (!it.explanation) {
      void vscode.window.showWarningMessage(`ExplainIT could not explain the change to ${it.name}: ${it.error ?? 'unknown error'}.`);
      return;
    }
    const exp = it.explanation;
    const items: vscode.QuickPickItem[] = [
      { label: '$(diff) What changed', detail: exp.whatChanged },
      ...exp.whyItMatters.map((w, i) => ({ label: i === 0 ? '$(lightbulb) Why it matters' : ' ', detail: w })),
    ];
    if (exp.risk) items.push({ label: '$(warning) Watch out', detail: exp.risk });
    items.push({ label: '$(info) Decide with Copilot', detail: 'Use Copilot\'s Keep / Undo to accept or reject this change. ExplainIT only reviews it.' });
    await vscode.window.showQuickPick(items, { title: `ExplainIT: ${it.name} (${it.changeType})`, placeHolder: exp.whatChanged, canPickMany: false, ignoreFocusOut: true });
  }

  function start(): void {
    if (running) return;
    running = true;
    for (const doc of vscode.workspace.textDocuments) takeSnapshot(doc);
    subs = [
      vscode.workspace.onDidOpenTextDocument((doc) => takeSnapshot(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) return;
        scheduleReview(e.document, DEBOUNCE_MS);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => scheduleReview(doc, 0)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = keyOf(doc);
        snapshots.delete(key);
        clearReview(key);
        const t = debounces.get(key);
        if (t) clearTimeout(t);
        debounces.delete(key);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => applyDecorations()),
    ];
    log.info('copilot review overlay started');
  }

  function stop(): void {
    if (!running) return;
    running = false;
    for (const s of subs) s.dispose();
    subs = [];
    for (const t of debounces.values()) clearTimeout(t);
    debounces.clear();
    for (const key of [...reviews.keys()]) clearReview(key);
    snapshots.clear();
    applyDecorations();
    log.info('copilot review overlay stopped');
  }

  const watcher: CopilotWatcher & { __test?: { resetNotice(): void } } = {
    start,
    stop,
    get running() {
      return running;
    },
    dispose: () => stop(),
  };
  // Integration tests share one extension host; let them start from "notice not shown yet".
  if (process.env.EXPLAINIT_TEST_MODE === '1') watcher.__test = { resetNotice: () => { noticeShown = false; } };
  return watcher;
}
