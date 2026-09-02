/**
 * Scroll sync (REQ-010, goal item 5): the twin follows the code and the code follows the twin.
 * Source top line -> enclosing function -> its section revealed AtTop in the visible twin editor, and the
 * reverse. A 200 ms guard per editor stops the two reveals from feeding each other.
 */
import * as vscode from 'vscode';
import type { Logger } from '../core/log';
import type { Settings } from '../core/settings';
import type { Disposable } from '../core/interfaces';
import { canonicalPath } from '../core/paths';
import { isTwinPath } from './pure/naming';
import { sectionAtLine } from './pure/parse';
import { functionAtLine } from './pure/stale';
import { samePath, type TwinEngineImpl } from './engine';

export const SCROLL_GUARD_MS = 200;

export function registerScrollSync(engine: TwinEngineImpl, deps: { settings: Settings; logger: Logger; disposables: Disposable[] }): void {
  const log = deps.logger.child('twin:scroll');
  /** canonical path -> time we last programmatically revealed in that editor. */
  const guard = new Map<string, number>();
  let busy = false;

  const reveal = (editor: vscode.TextEditor, line: number): void => {
    const top = editor.visibleRanges[0]?.start.line;
    if (top === line) return;
    guard.set(canonicalPath(editor.document.uri.fsPath), Date.now());
    const pos = new vscode.Position(Math.max(0, Math.min(line, editor.document.lineCount - 1)), 0);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
  };

  const findVisible = (p: string, exclude?: vscode.TextEditor): vscode.TextEditor | undefined =>
    vscode.window.visibleTextEditors.find((e) => e !== exclude && e.document.uri.scheme === 'file' && samePath(e.document.uri.fsPath, p));

  const onSourceScroll = async (editor: vscode.TextEditor, top: number): Promise<void> => {
    const state = await engine.stateFor(editor.document.uri.fsPath);
    if (!state?.sidecar) return;
    const twinEditor = findVisible(state.twinPath, editor);
    if (!twinEditor) return;
    const map = await engine.mapForDocument(editor.document);
    if (!map) return;
    const fi = functionAtLine(map.functions, top);
    let line = 0;
    if (fi !== undefined) {
      const fn = map.functions[fi];
      const section = state.sidecar.sections.find((s) => s.functionId === fn.id) ?? state.sidecar.sections[fi];
      line = section?.startLine ?? 0;
    }
    reveal(twinEditor, line);
  };

  const onTwinScroll = async (editor: vscode.TextEditor, top: number): Promise<void> => {
    const source = await engine.sourceForTwin(editor.document.uri.fsPath);
    if (!source) return;
    const sourceEditor = findVisible(source, editor);
    if (!sourceEditor) return;
    const state = await engine.stateFor(source);
    if (!state?.sidecar) return;
    const si = sectionAtLine(state.sidecar.sections, top);
    if (si === undefined) return;
    const section = state.sidecar.sections[si];
    const map = await engine.mapForDocument(sourceEditor.document);
    if (!map) return;
    const fn = map.functions.find((f) => f.id === section.functionId) ?? map.functions[si];
    if (!fn) return;
    reveal(sourceEditor, fn.range.startLine);
  };

  deps.disposables.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (!deps.settings.get('scrollSync') || busy) return;
      const doc = e.textEditor.document;
      if (doc.uri.scheme !== 'file') return;
      const key = canonicalPath(doc.uri.fsPath);
      const last = guard.get(key);
      if (last !== undefined && Date.now() - last < SCROLL_GUARD_MS) return;
      const top = e.visibleRanges[0]?.start.line;
      if (top === undefined) return;
      busy = true;
      const run = isTwinPath(doc.uri.fsPath) ? onTwinScroll(e.textEditor, top) : onSourceScroll(e.textEditor, top);
      run.catch((err) => log.debug('scroll sync skipped', err)).finally(() => {
        busy = false;
      });
    }),
  );
}
