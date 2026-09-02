/**
 * Review presenter (REQ-014, goal item 7): one reusable webview panel that shows every proposed hunk
 * as a card beside its plain-English meaning, reveals the function in the real editor, and resolves a
 * Decision only when the person has decided every card.
 *
 * All decision logic lives in pure/state.ts; this file is the vscode glue. Every message from the
 * webview and every call from the test hook is validated by the same `dispatch()`.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { ChangeExplanation, Decision, FunctionHunk, GateRequest } from '../core/types';
import type { CancelToken, CoreDeps, Disposable, ReviewPresenter } from '../core/interfaces';
import { CancelSource, jitter, sleep, withTimeout } from '../core/cancel';
import { agentLabel, escapeHtml, makeNonce, shortPath } from './pure/html';
import {
  CLOSED_WITHOUT_DECISION,
  createInitialState,
  currentCard,
  explainQueue,
  finalize,
  isComplete,
  reduce,
  snapshot,
  type CardState,
  type ReviewAction,
  type ReviewState,
} from './pure/state';

export type ExplainFn = (hunk: FunctionHunk, onText: (chunk: string) => void, token: CancelToken) => Promise<ChangeExplanation>;

interface Job {
  request: GateRequest;
  explain: ExplainFn;
  token?: CancelToken;
  state: ReviewState;
  resolve: (d: Decision) => void;
  inFlight: Map<string, CancelSource>;
  tokenSub?: Disposable;
  done: boolean;
}

/** Messages the webview may send. Anything else is ignored and logged. */
type InMessage =
  | { type: 'ready' }
  | { type: 'accept' | 'acceptFile' | 'acceptSession' | 'retry'; cardId: string }
  | { type: 'reject'; cardId: string; reason: string }
  | { type: 'ackWarning'; value: boolean }
  | { type: 'openFile'; path: string };

export interface ReviewTestHook {
  current(): ReturnType<typeof snapshot> | undefined;
  decide(verdict: 'accept' | 'reject' | 'acceptFile' | 'acceptSession', reason?: string): boolean;
  onShown(cb: (s: ReturnType<typeof snapshot>) => void): { dispose(): void };
  waitForExplained(): Promise<void>;
  /** Extra helpers for integration tests. */
  closePanel(): void;
  waiting(): number;
  ackWarning(value: boolean): boolean;
}

const MAX_IN_FLIGHT = 2;
const PANEL_TITLE = 'ExplainIT: Review change';
const VIEW_TYPE = 'explainit.review';

export function createReviewPresenter(deps: CoreDeps & { extensionUri: string; disposables: Disposable[] }): ReviewPresenter {
  const log = deps.logger.child('review');
  const queue: Job[] = [];
  let active: Job | undefined;
  let panel: vscode.WebviewPanel | undefined;
  let disposed = false;
  const stateChanged = new vscode.EventEmitter<ReviewState>();
  const shown = new vscode.EventEmitter<ReturnType<typeof snapshot>>();
  deps.disposables.push(stateChanged, shown);

  const decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
  });
  deps.disposables.push(decoration);
  let decoratedEditor: vscode.TextEditor | undefined;

  // ------------------------------------------------------------------------------------------
  // Panel lifecycle
  // ------------------------------------------------------------------------------------------

  const mediaRoot = (): vscode.Uri => vscode.Uri.joinPath(vscode.Uri.parse(deps.extensionUri), 'media', 'review');

  function ensurePanel(): vscode.WebviewPanel {
    if (panel) {
      // Reveal where it already is; `Beside` on an existing panel could move it one column further
      // every time the person's focus sits in the panel's own group.
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, true);
      return panel;
    }
    const p = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot()], enableCommandUris: false },
    );
    panel = p;
    p.webview.html = buildHtml(p.webview);
    const sub = p.webview.onDidReceiveMessage((m: unknown) => onWebviewMessage(m));
    const closeSub = p.onDidDispose(() => {
      sub.dispose();
      closeSub.dispose();
      if (panel === p) panel = undefined;
      clearDecoration();
      if (active && !active.done) {
        log.info('review panel closed by the person; rejecting the current request', { requestId: active.request.id });
        dispatch({ type: 'close', reason: CLOSED_WITHOUT_DECISION });
      }
    });
    // The presenter's own dispose() (already in deps.disposables) closes whichever panel is current.
    return p;
  }

  function buildHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const root = mediaRoot();
    const cssPath = vscode.Uri.joinPath(root, 'review.css');
    const jsPath = vscode.Uri.joinPath(root, 'review.js');
    const haveAssets = fs.existsSync(cssPath.fsPath) && fs.existsSync(jsPath.fsPath);
    if (!haveAssets) log.error('review panel assets are missing from the extension install', { dir: root.fsPath });
    const cssUri = webview.asWebviewUri(cssPath);
    const jsUri = webview.asWebviewUri(jsPath);
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    const body = haveAssets
      ? '<div id="app" aria-live="polite"><p class="empty">Loading the review…</p></div>'
      : '<div id="app"><p class="error">ExplainIT could not load its review panel files. Reinstall the extension, then run "ExplainIT: Doctor". Close this panel to send the assistant a rejection.</p></div>';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(PANEL_TITLE)}</title>
<link rel="stylesheet" nonce="${nonce}" href="${cssUri}">
</head>
<body>
${body}
${haveAssets ? `<script nonce="${nonce}" src="${jsUri}"></script>` : ''}
</body>
</html>`;
  }

  function post(msg: Record<string, unknown>): void {
    if (!panel) return;
    void panel.webview.postMessage(msg).then(undefined, (e: unknown) => log.debug('postMessage failed', e));
  }

  // ------------------------------------------------------------------------------------------
  // View model + rendering
  // ------------------------------------------------------------------------------------------

  function viewModel(job: Job): Record<string, unknown> {
    const s = job.state;
    return {
      requestId: s.requestId,
      agent: s.agent,
      agentLabel: agentLabel(s.agent),
      note: s.agent === 'claude' || s.agent === 'codex' ? 'The assistant is waiting for your decision.' : undefined,
      paths: s.paths.map((p) => ({ full: p, short: shortPath(p) })),
      waiting: queue.length,
      warnings: s.warnings,
      warningAcknowledged: s.warningAcknowledged,
      allowSessionAccept: s.allowSessionAccept,
      current: s.current,
      total: s.cards.length,
      cards: s.cards.map((c) => ({
        id: c.card.id,
        kind: c.card.kind,
        title: c.card.title,
        path: c.card.path,
        shortPath: shortPath(c.card.path),
        diffHtml: c.card.diffHtml,
        diffRows: c.card.diffRows,
        diffCollapsed: c.card.diffCollapsed,
        diffTruncated: c.card.diffTruncated,
        trivialItems: c.card.trivialItems,
        explain: c.explain,
        text: c.text,
        explanation: c.explanation,
        error: c.error,
        verdict: c.verdict,
        rejectReason: c.rejectReason,
      })),
    };
  }

  function render(): void {
    if (!panel) return;
    if (active) post({ type: 'render', view: viewModel(active) });
    else post({ type: 'idle', waiting: queue.length });
  }

  // ------------------------------------------------------------------------------------------
  // Editor reveal + decoration
  // ------------------------------------------------------------------------------------------

  function clearDecoration(): void {
    try {
      decoratedEditor?.setDecorations(decoration, []);
    } catch {
      /* editor may be gone */
    }
    decoratedEditor = undefined;
  }

  async function revealCurrent(job: Job): Promise<void> {
    const cs = currentCard(job.state);
    clearDecoration();
    if (!cs) return;
    const cardId = cs.card.id;
    // A slow reveal must never decorate a range for a card the person has already moved past.
    const stillCurrent = (): boolean => job === active && !job.done && currentCard(job.state)?.card.id === cardId;
    const hunks = job.request.hunksByPath[cs.card.path] ?? [];
    const hunk = hunks.find((h) => h.id === cs.card.hunkIds[0]);
    const range = hunk?.beforeRange ?? hunk?.afterRange;
    if (!fs.existsSync(cs.card.path)) return; // a brand-new file: nothing on disk to show yet
    try {
      const doc = await withTimeout(Promise.resolve(vscode.workspace.openTextDocument(vscode.Uri.file(cs.card.path))), 5000, 'opening the changed file');
      const editor = await withTimeout(
        Promise.resolve(vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false })),
        5000,
        'showing the changed file',
      );
      if (!stillCurrent()) return;
      panel?.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, true);
      if (range && doc.lineCount > 0) {
        const start = Math.max(0, Math.min(range.startLine, doc.lineCount - 1));
        const end = Math.max(start, Math.min(range.endLine, doc.lineCount - 1));
        const r = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
        editor.setDecorations(decoration, [r]);
        editor.revealRange(r, vscode.TextEditorRevealType.InCenter);
        decoratedEditor = editor;
      }
    } catch (e) {
      log.warn('could not reveal the changed file in the editor', e);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Explanations: current card first, then prefetch (max 2 in flight)
  // ------------------------------------------------------------------------------------------

  function scheduleExplains(job: Job): void {
    if (job.done || job !== active) return;
    const ids = explainQueue(job.state).filter((id) => !job.inFlight.has(id));
    while (job.inFlight.size < MAX_IN_FLIGHT && ids.length) {
      const id = ids.shift()!;
      void runExplain(job, id);
    }
  }

  async function runExplain(job: Job, cardId: string): Promise<void> {
    const cs = job.state.cards.find((c) => c.card.id === cardId);
    if (!cs) return;
    const hunk = (job.request.hunksByPath[cs.card.path] ?? []).find((h) => h.id === cs.card.hunkIds[0]);
    if (!hunk) {
      applyIfActive(job, { type: 'explainError', cardId, reason: 'the change could not be matched to a function' });
      return;
    }
    const src = new CancelSource();
    job.inFlight.set(cardId, src);
    const outer = job.token?.onCancellationRequested(() => src.cancel());
    const requestId = job.request.id;
    const timeoutMs = Math.max(10, deps.settings.get('generationTimeoutSeconds')) * 1000;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (src.token.isCancellationRequested || job.done) break;
      // Each attempt gets its own token so a timed-out or failed call cannot keep streaming text
      // into the card after the retry has started.
      const attemptSrc = new CancelSource();
      const link = src.token.onCancellationRequested(() => attemptSrc.cancel());
      applyIfActive(job, { type: 'explainStart', cardId });
      post({ type: 'explainStart', requestId, cardId });
      const onText = (chunk: string): void => {
        if (job.done || job !== active || attemptSrc.token.isCancellationRequested || typeof chunk !== 'string' || !chunk) return;
        const r = reduce(job.state, { type: 'explainChunk', cardId, chunk });
        job.state = r.state;
        post({ type: 'explainChunk', requestId, cardId, chunk });
      };
      try {
        const explanation = await withTimeout(job.explain(hunk, onText, attemptSrc.token), timeoutMs, 'explaining the change', attemptSrc.token);
        if (!explanation || typeof explanation !== 'object' || typeof explanation.whatChanged !== 'string' || !explanation.whatChanged.trim()) {
          throw new Error('the assistant returned an empty explanation');
        }
        if (!src.token.isCancellationRequested) {
          applyIfActive(job, { type: 'explainDone', cardId, explanation });
          post({ type: 'explainDone', requestId, cardId, explanation });
        }
        lastError = undefined;
        link.dispose();
        break;
      } catch (e) {
        lastError = e;
        attemptSrc.cancel();
        link.dispose();
        const msg = e instanceof Error ? e.message : String(e);
        if (src.token.isCancellationRequested || /cancelled/i.test(msg)) break;
        log.warn(`explaining ${cs.card.title} failed (attempt ${attempt + 1})`, e);
        // One jittered retry only (contract: every external call has a timeout and at most one retry).
        if (attempt === 0) await sleep(jitter(400));
      }
    }
    if (lastError !== undefined && !src.token.isCancellationRequested) {
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      applyIfActive(job, { type: 'explainError', cardId, reason });
      post({ type: 'explainError', requestId, cardId, reason });
    }
    outer?.dispose();
    job.inFlight.delete(cardId);
    scheduleExplains(job);
  }

  /** Applies a non-decision action without a full re-render (streaming is incremental in the webview). */
  function applyIfActive(job: Job, action: ReviewAction): void {
    if (job.done || job !== active) return;
    const r = reduce(job.state, action);
    if (!r.ok) {
      log.debug(`ignored ${action.type}: ${r.error}`);
      return;
    }
    job.state = r.state;
    stateChanged.fire(job.state);
  }

  // ------------------------------------------------------------------------------------------
  // Decisions: the single validated entry point for webview messages AND the test hook
  // ------------------------------------------------------------------------------------------

  function dispatch(action: ReviewAction): boolean {
    const job = active;
    if (!job || job.done) {
      log.warn(`ignored ${action.type}: no review is in progress`);
      return false;
    }
    const before = job.state;
    const r = reduce(before, action);
    if (!r.ok) {
      log.warn(`refused ${action.type}${'cardId' in action ? ` on ${action.cardId}` : ''}: ${r.error}`);
      if ('cardId' in action) post({ type: 'refused', cardId: action.cardId, message: r.error });
      return false;
    }
    job.state = r.state;
    stateChanged.fire(job.state);
    if (action.type === 'retry') {
      render();
      scheduleExplains(job);
      return true;
    }
    if (isComplete(job.state)) {
      finish(job);
      return true;
    }
    render();
    if (job.state.current !== before.current) {
      void revealCurrent(job);
      scheduleExplains(job);
    }
    return true;
  }

  function onWebviewMessage(raw: unknown): void {
    const m = raw as InMessage;
    if (!m || typeof m !== 'object' || typeof (m as { type?: unknown }).type !== 'string') {
      log.debug('ignored malformed webview message');
      return;
    }
    switch (m.type) {
      case 'ready':
        render();
        return;
      case 'accept':
      case 'acceptFile':
      case 'acceptSession':
      case 'retry':
        if (typeof m.cardId !== 'string') return;
        dispatch({ type: m.type, cardId: m.cardId });
        return;
      case 'reject':
        if (typeof m.cardId !== 'string') return;
        dispatch({ type: 'reject', cardId: m.cardId, reason: typeof m.reason === 'string' ? m.reason : '' });
        return;
      case 'ackWarning':
        dispatch({ type: 'ackWarning', value: !!m.value });
        return;
      case 'openFile': {
        // Only files that belong to the request being reviewed may be opened from the panel.
        const p = typeof m.path === 'string' ? m.path : '';
        if (active && active.state.paths.includes(p) && fs.existsSync(p)) {
          void vscode.window.showTextDocument(vscode.Uri.file(p), { viewColumn: vscode.ViewColumn.One, preserveFocus: true }).then(undefined, (e: unknown) =>
            log.warn('could not open file from the review panel', e),
          );
        }
        return;
      }
      default:
        log.debug('ignored unknown webview message', { type: (m as { type: string }).type });
    }
  }

  function finish(job: Job): void {
    if (job.done) return;
    job.done = true;
    for (const src of job.inFlight.values()) src.cancel();
    job.inFlight.clear();
    job.tokenSub?.dispose();
    const decision = finalize(job.state);
    log.info(`review decided: ${decision.verdict} (${decision.scope})`, { requestId: decision.requestId, reason: decision.reason });
    if (active === job) active = undefined;
    clearDecoration();
    job.resolve(decision);
    stateChanged.fire(job.state); // wakes waitForExplained() so it can give up on a finished review
    pump();
  }

  function pump(): void {
    if (disposed) return;
    if (active) {
      render(); // header shows how many more changes are waiting
      return;
    }
    const next = queue.shift();
    if (!next) {
      render();
      return;
    }
    if (next.token?.isCancellationRequested) {
      next.done = true;
      next.resolve(finalize({ ...next.state, closedReason: 'Review cancelled before a decision was made' }));
      pump();
      return;
    }
    active = next;
    ensurePanel();
    render();
    shown.fire(snapshot(next.state));
    if (isComplete(next.state)) {
      // Nothing to review (no hunks): resolve straight away so the agent is never left waiting.
      finish(next);
      return;
    }
    void revealCurrent(next);
    scheduleExplains(next);
  }

  // ------------------------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------------------------

  const presenter: ReviewPresenter = {
    review(request, explain, opts) {
      return new Promise<Decision>((resolve) => {
        const state = createInitialState(request, {
          batchTrivial: deps.settings.get('gateBatchTrivial'),
          allowSessionAccept: deps.settings.get('gateAllowSessionAccept'),
        });
        const job: Job = { request, explain, token: opts?.token, state, resolve, inFlight: new Map(), done: false };
        if (disposed) {
          job.done = true;
          resolve(finalize({ ...state, closedReason: 'ExplainIT is shutting down; the review could not be shown' }));
          return;
        }
        job.tokenSub = opts?.token?.onCancellationRequested(() => {
          if (job.done) return;
          if (active === job) {
            dispatch({ type: 'close', reason: 'Review cancelled before a decision was made' });
          } else {
            const i = queue.indexOf(job);
            if (i >= 0) queue.splice(i, 1);
            job.done = true;
            job.resolve(finalize({ ...job.state, closedReason: 'Review cancelled before a decision was made' }));
            render();
          }
        });
        queue.push(job);
        log.info(`review requested: ${state.cards.length} card(s) for ${state.paths.length} file(s)`, { requestId: request.id, agent: request.agent });
        pump();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const reason = 'ExplainIT was closed before a decision was made';
      const pending = [...queue];
      queue.length = 0;
      for (const j of pending) {
        j.done = true;
        j.resolve(finalize({ ...j.state, closedReason: reason }));
      }
      if (active && !active.done) {
        const j = active;
        for (const src of j.inFlight.values()) src.cancel();
        j.done = true;
        active = undefined;
        j.resolve(finalize({ ...j.state, closedReason: reason }));
      }
      clearDecoration();
      panel?.dispose();
      panel = undefined;
      if (process.env.EXPLAINIT_TEST_MODE === '1') delete (globalThis as Record<string, unknown>).__explainitReviewTestHook;
    },
  };
  deps.disposables.push({ dispose: () => presenter.dispose() });

  // ------------------------------------------------------------------------------------------
  // Test hook (EXPLAINIT_TEST_MODE=1): drives the same dispatch() as the webview
  // ------------------------------------------------------------------------------------------

  if (process.env.EXPLAINIT_TEST_MODE === '1') {
    const hook: ReviewTestHook = {
      current: () => (active && !active.done ? snapshot(active.state) : undefined),
      decide: (verdict, reason) => {
        const cs: CardState | undefined = active && !active.done ? currentCard(active.state) : undefined;
        if (!cs) {
          log.warn('test hook: decide() called with no current card');
          return false;
        }
        const cardId = cs.card.id;
        switch (verdict) {
          case 'accept':
            return dispatch({ type: 'accept', cardId });
          case 'reject':
            return dispatch({ type: 'reject', cardId, reason: reason ?? '' });
          case 'acceptFile':
            return dispatch({ type: 'acceptFile', cardId });
          case 'acceptSession':
            return dispatch({ type: 'acceptSession', cardId });
          default:
            return false;
        }
      },
      onShown: (cb) => shown.event(cb),
      waitForExplained: () =>
        new Promise<void>((resolve, reject) => {
          const check = (): boolean => {
            const cs = active && !active.done ? currentCard(active.state) : undefined;
            if (!cs) {
              if (!active || active.done || isComplete(active.state)) {
                reject(new Error('no review is in progress'));
                return true;
              }
              return false;
            }
            if (cs.explain === 'done') {
              resolve();
              return true;
            }
            if (cs.explain === 'error') {
              reject(new Error(`explanation failed: ${cs.error}`));
              return true;
            }
            return false;
          };
          if (check()) return;
          const sub = stateChanged.event(() => {
            if (check()) sub.dispose();
          });
        }),
      closePanel: () => panel?.dispose(),
      waiting: () => queue.length,
      ackWarning: (value) => dispatch({ type: 'ackWarning', value }),
    };
    (globalThis as Record<string, unknown>).__explainitReviewTestHook = hook;
  }

  return presenter;
}
