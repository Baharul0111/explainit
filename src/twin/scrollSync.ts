/**
 * Scroll sync (REQ-010, goal item 5): the twin follows the code and the code follows the twin.
 * Source top line -> enclosing function -> its section put on the top line of the visible twin editor, and
 * the reverse. VS Code pads a programmatic "reveal at top" by the sticky-scroll height (pure/reveal.ts),
 * so every reveal aims that many lines further down and the target really lands on the top line.
 * Events are coalesced per editor (the newest position wins) and handled one at a time; the echo of our
 * own reveal is recognised by its expected top line, with a 200 ms guard per editor as a fallback, so the
 * two editors never feed each other.
 */
import * as vscode from 'vscode';
import type { Logger } from '../core/log';
import type { Settings } from '../core/settings';
import type { Disposable } from '../core/interfaces';
import { canonicalPath } from '../core/paths';
import { isTwinPath } from './pure/naming';
import { sectionAtLine } from './pure/parse';
import { revealLineFor, revealPaddingLines, type RevealOptions } from './pure/reveal';
import { functionAtLine } from './pure/stale';
import { samePath, type TwinEngineImpl } from './engine';

export const SCROLL_GUARD_MS = 200;

/** The editor options VS Code uses to pad a programmatic reveal (language overrides included). */
export function revealOptionsOf(editor: vscode.TextEditor): RevealOptions {
  const cfg = vscode.workspace.getConfiguration('editor', editor.document);
  return {
    stickyScrollEnabled: cfg.get<boolean>('stickyScroll.enabled', true),
    stickyMaxLineCount: cfg.get<number>('stickyScroll.maxLineCount', 5),
    cursorSurroundingLines: cfg.get<number>('cursorSurroundingLines', 0),
    viewportLines: editor.visibleRanges.reduce((n, r) => n + (r.end.line - r.start.line + 1), 0),
  };
}

export function registerScrollSync(engine: TwinEngineImpl, deps: { settings: Settings; logger: Logger; disposables: Disposable[] }): void {
  const log = deps.logger.child('twin:scroll');
  /** canonical path -> time we last programmatically revealed in that editor. */
  const guard = new Map<string, number>();
  /** canonical path -> the top line our reveal is expected to produce there. */
  const expected = new Map<string, number>();
  /** canonical path -> newest unhandled scroll position of that editor. */
  const queue = new Map<string, { editor: vscode.TextEditor; top: number }>();
  let pumping = false;

  const reveal = (editor: vscode.TextEditor, line: number): void => {
    const last = editor.document.lineCount - 1;
    const target = Math.max(0, Math.min(line, last));
    if (editor.visibleRanges[0]?.start.line === target) return;
    const key = canonicalPath(editor.document.uri.fsPath);
    const at = revealLineFor(target, revealPaddingLines(revealOptionsOf(editor)), last);
    guard.set(key, Date.now());
    expected.set(key, target);
    const pos = new vscode.Position(at, 0);
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

  /** Handle queued positions one at a time, always the newest one per editor. */
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const next = queue.entries().next();
        if (next.done) break;
        const [key, { editor, top }] = next.value;
        queue.delete(key);
        try {
          if (isTwinPath(editor.document.uri.fsPath)) await onTwinScroll(editor, top);
          else await onSourceScroll(editor, top);
        } catch (err) {
          log.debug('scroll sync skipped', err);
        }
      }
    } finally {
      pumping = false;
    }
  };

  deps.disposables.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (!deps.settings.get('scrollSync')) return;
      const doc = e.textEditor.document;
      if (doc.uri.scheme !== 'file') return;
      const top = e.visibleRanges[0]?.start.line;
      if (top === undefined) return;
      const key = canonicalPath(doc.uri.fsPath);
      // The echo of our own reveal: never answer it, or the two editors feed each other.
      if (expected.get(key) === top) {
        expected.delete(key);
        return;
      }
      const last = guard.get(key);
      if (last !== undefined && Date.now() - last < SCROLL_GUARD_MS) return;
      expected.delete(key);
      queue.set(key, { editor: e.textEditor, top });
      void pump();
    }),
  );
  deps.disposables.push({
    dispose: () => {
      queue.clear();
      guard.clear();
      expected.clear();
    },
  });
}
