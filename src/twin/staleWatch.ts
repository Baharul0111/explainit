/**
 * Staleness glue (REQ-010): after a save (immediately) or an edit (debounced 1.5 s) of a code file that
 * has a twin, recompute the function map and mark changed sections out of date. No model call, ever.
 * Gate-approved landings (landedRecently) are skipped: the gate updates the twin itself.
 */
import * as vscode from 'vscode';
import type { Logger } from '../core/log';
import type { Settings } from '../core/settings';
import type { Disposable } from '../core/interfaces';
import { landedRecently } from '../core/landing';
import { canonicalPath } from '../core/paths';
import { eligibleDocument } from './autoOpen';
import { toDocLike, type TwinEngineImpl } from './engine';

export const EDIT_DEBOUNCE_MS = 1500;

export function registerStaleWatch(engine: TwinEngineImpl, deps: { settings: Settings; logger: Logger; disposables: Disposable[] }): void {
  const log = deps.logger.child('twin:stale');
  const timers = new Map<string, NodeJS.Timeout>();

  const run = async (doc: vscode.TextDocument): Promise<void> => {
    if (doc.isClosed || !deps.settings.get('stalenessMarks')) return;
    const key = canonicalPath(doc.uri.fsPath);
    if (engine.projectGate.status(key) !== 'allowed') return; // a project that was not allowed has no twins to mark
    if (landedRecently(key)) return; // the gate just wrote this file and will refresh the twin itself
    if (!(await engine.hasTwin(key))) return;
    await engine.markStaleDoc(toDocLike(doc));
  };

  const schedule = (doc: vscode.TextDocument, delay: number): void => {
    if (!eligibleDocument(doc)) return;
    const key = canonicalPath(doc.uri.fsPath);
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        run(doc).catch((e) => log.warn(`staleness check failed for ${doc.uri.fsPath}`, e));
      }, delay),
    );
  };

  deps.disposables.push(vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length && schedule(e.document, EDIT_DEBOUNCE_MS)));
  deps.disposables.push(vscode.workspace.onDidSaveTextDocument((doc) => schedule(doc, 0)));
  deps.disposables.push({
    dispose: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  });
}
