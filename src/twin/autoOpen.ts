/**
 * Auto-open glue (REQ-003, goal item 2): open the twin beside a code file the moment it becomes the
 * active editor, when `twin.autoOpen` is on. Debounced per file; never opens twins for twins, and never
 * for a code file that was opened INTO the twin column while another column shows code (ping-pong guard).
 */
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { Logger } from '../core/log';
import type { Settings } from '../core/settings';
import type { Disposable } from '../core/interfaces';
import { canonicalPath } from '../core/paths';
import { isCodeLanguage, MAX_TWIN_SOURCE_BYTES } from './pure/languages';
import { isTwinPath } from './pure/naming';
import { toDocLike, type TwinEngineImpl } from './engine';

const DEBOUNCE_MS = 250;

export function eligibleDocument(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== 'file' || doc.isClosed) return false;
  if (isTwinPath(doc.uri.fsPath)) return false;
  if (!isCodeLanguage(doc.languageId)) return false;
  // getText() on a huge file is itself expensive; the byte check keeps the 2 MB rule cheap enough.
  if (doc.getText().length > MAX_TWIN_SOURCE_BYTES) return false;
  return true;
}

export function registerAutoOpen(engine: TwinEngineImpl, deps: { settings: Settings; logger: Logger; disposables: Disposable[] }): void {
  const log = deps.logger.child('twin:auto-open');
  const timers = new Map<string, NodeJS.Timeout>();
  /** Sources whose twin the person closed on purpose: leave them alone until the source is re-opened. */
  const closedByUser = new Set<string>();

  const consider = (editor: vscode.TextEditor | undefined): void => {
    if (!editor || !deps.settings.get('autoOpenTwin')) return;
    const doc = editor.document;
    if (!eligibleDocument(doc)) return;
    // A code file opened in the twin column while code is shown elsewhere: opening "beside" would
    // spawn a third column or bounce editors around, so leave it alone.
    const otherColumnShowsCode = vscode.window.visibleTextEditors.some(
      (e) => e !== editor && e.viewColumn !== editor.viewColumn && e.document.uri.scheme === 'file' && !isTwinPath(e.document.uri.fsPath),
    );
    if (engine.isTwinColumn(editor.viewColumn) && otherColumnShowsCode) return;
    const key = canonicalPath(doc.uri.fsPath);
    if (closedByUser.has(key)) return;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (doc.isClosed) return;
        // Ask once per project before the first twin is written there; a refused project stays quiet.
        engine.projectGate
          .ensureAllowed(doc.uri.fsPath, { ask: true })
          .then((allowed) => {
            if (!allowed || doc.isClosed) return undefined;
            return engine.ensureTwin(toDocLike(doc), { open: true, silent: true });
          })
          .catch((e) => log.warn(`auto-open failed for ${doc.uri.fsPath}`, e));
      }, DEBOUNCE_MS),
    );
  };

  deps.disposables.push(vscode.window.onDidChangeActiveTextEditor(consider));
  // A code editor that becomes visible without ever being "active" (focus stolen by a panel) still counts.
  const seenVisible = new WeakSet<vscode.TextDocument>();
  deps.disposables.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const e of editors) {
        if (seenVisible.has(e.document)) continue;
        seenVisible.add(e.document);
        if (e.document.uri.scheme === 'file' && !isTwinPath(e.document.uri.fsPath)) consider(e);
      }
    }),
  );
  deps.disposables.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') return;
      if (isTwinPath(doc.uri.fsPath)) {
        // A twin that vanished from disk was deleted, not closed by the person: opening the code again
        // should bring a fresh twin back.
        if (!fs.existsSync(doc.uri.fsPath)) return;
        void engine.sourceForTwin(doc.uri.fsPath).then((src) => src && closedByUser.add(src));
      } else {
        closedByUser.delete(canonicalPath(doc.uri.fsPath)); // closing the source re-arms auto-open too
      }
    }),
  );
  deps.disposables.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme === 'file' && !isTwinPath(doc.uri.fsPath)) closedByUser.delete(canonicalPath(doc.uri.fsPath));
      // Documents opened in the background (git, search, other extensions) never get twins; only ones
      // that end up visible in an editor group do. Focus may already have moved on (to a panel such as
      // an output channel, or to a quick pick), so look at the visible editors, not just the active one.
      setTimeout(() => {
        const shown = vscode.window.visibleTextEditors.find((e) => e.document === doc);
        if (shown) consider(shown);
      }, DEBOUNCE_MS);
    }),
  );
  deps.disposables.push({
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  });
  // The file that was already open when the extension activated.
  consider(vscode.window.activeTextEditor);
}
