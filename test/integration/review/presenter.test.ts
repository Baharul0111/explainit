/**
 * Integration tests for the review presenter (REQ-014). Runs inside VS Code with
 * test/fixtures/workspace as the workspace and EXPLAINIT_TEST_MODE=1, driving the panel through
 * `globalThis.__explainitReviewTestHook` (the hook goes through the same host-side validation as the
 * webview's messages).
 */
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangeExplanation, Decision, FunctionHunk, GateRequest } from '../../../src/core/types';
import type { CancelToken } from '../../../src/core/interfaces';
import type { ExplainitApi } from '../../../src/extension';
import type { ReviewTestHook } from '../../../src/review/panel';
import { CancelSource } from '../../../src/core/cancel';

const hook = (): ReviewTestHook => {
  const h = (globalThis as Record<string, unknown>).__explainitReviewTestHook as ReviewTestHook | undefined;
  assert.ok(h, 'review test hook must be installed in EXPLAINIT_TEST_MODE');
  return h;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

let seq = 0;
function fabricateRequest(opts: { hunks?: number; warnings?: string[]; agent?: GateRequest['agent']; file?: string } = {}): GateRequest {
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const file = opts.file ?? path.join(folder, 'src', 'app.py');
  const n = opts.hunks ?? 2;
  const hunks: FunctionHunk[] = [];
  for (let i = 0; i < n; i++) {
    hunks.push({
      id: `h${i + 1}`,
      kind: 'function',
      functionName: i === 0 ? 'load_config' : `fn_${i + 1}`,
      changeType: 'modified',
      beforeRange: { startLine: 5 + i * 8, endLine: 10 + i * 8 },
      afterRange: { startLine: 5 + i * 8, endLine: 11 + i * 8 },
      beforeText: `def f${i}():\n    return ${i}\n`,
      afterText: `def f${i}():\n    # changed\n    return ${i + 1}\n`,
      trivial: false,
    });
  }
  seq++;
  return {
    id: `it-review-${Date.now()}-${seq}`,
    agent: opts.agent ?? 'claude',
    sessionId: 'it-session',
    toolName: 'Edit',
    cwd: folder,
    writes: [{ kind: 'modify', path: file, before: 'x', after: 'y' }],
    hunksByPath: { [file]: hunks },
    receivedAt: new Date().toISOString(),
    warnings: opts.warnings,
  };
}

function slowExplain(delayMs = 300) {
  const calls: string[] = [];
  const fn = async (hunk: FunctionHunk, onText: (chunk: string) => void, token: CancelToken): Promise<ChangeExplanation> => {
    calls.push(hunk.id);
    onText('It now ');
    await sleep(delayMs / 2);
    if (token.isCancellationRequested) throw new Error('explaining cancelled');
    onText('returns a bigger number.');
    await sleep(delayMs / 2);
    return {
      functionName: hunk.functionName ?? 'unknown',
      whatChanged: 'The function now returns a bigger number.',
      whyItMatters: ['Callers will see a different value.'],
      modelChannel: 'claude',
      createdAt: new Date().toISOString(),
    };
  };
  return { fn, calls };
}

suite('review presenter (integration)', function () {
  this.timeout(60000);
  let api: ExplainitApi;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('BaharulIslam.explainit-code');
    assert.ok(ext, 'extension must be installed');
    api = await ext.activate();
    assert.ok(api.review, 'api.review must be exposed');
  });

  setup(async () => {
    // Make sure no stale review is active from a previous test.
    const h = hook();
    for (let i = 0; i < 10 && h.current(); i++) {
      h.closePanel();
      await sleep(50);
    }
  });

  test('accept is refused before the explanation and allowed after waitForExplained()', async () => {
    const h = hook();
    const { fn, calls } = slowExplain(300);
    const shownSnaps: string[] = [];
    const sub = h.onShown((s) => shownSnaps.push(s.requestId));
    const req = fabricateRequest({ hunks: 2 });
    const promise = api.review.review(req, fn);
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    assert.deepEqual(shownSnaps, [req.id]);
    sub.dispose();

    const cur = h.current()!;
    assert.equal(cur.hunkIndex, 0);
    assert.equal(cur.cards.length, 2);
    assert.equal(cur.explained, false);
    assert.equal(h.decide('accept'), false, 'accept must be refused before the explanation');
    assert.equal(h.current()!.hunkIndex, 0, 'a refused accept changes nothing');

    await h.waitForExplained();
    assert.equal(h.current()!.explained, true);
    assert.equal(h.decide('accept'), true);
    assert.equal(h.current()!.hunkIndex, 1);
    // The second card was prefetched (max 2 in flight): both hunks were requested.
    await waitFor(() => calls.length === 2, 'prefetch of the second explanation');

    await h.waitForExplained();
    assert.equal(h.decide('accept'), true);
    const decision: Decision = await promise;
    assert.equal(decision.requestId, req.id);
    assert.equal(decision.verdict, 'accept');
    assert.equal(decision.scope, 'one');
    assert.deepEqual(decision.hunkVerdicts, { h1: 'accept', h2: 'accept' });
    assert.equal(h.current(), undefined, 'no review active afterwards');
  });

  test('the source file is revealed in the first editor column while reviewing', async () => {
    const h = hook();
    const req = fabricateRequest({ hunks: 1 });
    const file = Object.keys(req.hunksByPath)[0];
    const promise = api.review.review(req, slowExplain(100).fn);
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    await waitFor(
      () => vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath === file && e.viewColumn === vscode.ViewColumn.One),
      'the changed file to open in column one',
    );
    await h.waitForExplained();
    assert.equal(h.decide('accept'), true);
    await promise;
  });

  test('reject with a reason yields Decision.reason verbatim (and partial when mixed)', async () => {
    const h = hook();
    const req = fabricateRequest({ hunks: 2 });
    const promise = api.review.review(req, slowExplain(100).fn);
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    assert.equal(h.decide('reject'), false, 'reject without a reason is refused');
    assert.equal(h.decide('reject', '   '), false, 'blank reason is refused');
    assert.equal(h.decide('reject', 'Keep the old return value'), true, 'reject needs no explanation');
    await h.waitForExplained();
    assert.equal(h.decide('accept'), true);
    const decision = await promise;
    assert.equal(decision.verdict, 'partial');
    assert.equal(decision.reason, 'Keep the old return value');
    assert.deepEqual(decision.hunkVerdicts, { h1: 'reject', h2: 'accept' });
  });

  test('rejecting everything yields verdict reject', async () => {
    const h = hook();
    const req = fabricateRequest({ hunks: 1 });
    const promise = api.review.review(req, slowExplain(100).fn);
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    assert.equal(h.decide('reject', 'Not like this'), true);
    const decision = await promise;
    assert.equal(decision.verdict, 'reject');
    assert.equal(decision.reason, 'Not like this');
  });

  test('acceptSession yields scope session and accepts every remaining hunk', async () => {
    const h = hook();
    const req = fabricateRequest({ hunks: 3 });
    const promise = api.review.review(req, slowExplain(100).fn);
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    assert.equal(h.decide('acceptSession'), false, 'refused before the current explanation');
    await h.waitForExplained();
    assert.equal(h.decide('acceptSession'), true);
    const decision = await promise;
    assert.equal(decision.verdict, 'accept');
    assert.equal(decision.scope, 'session');
    assert.deepEqual(decision.hunkVerdicts, { h1: 'accept', h2: 'accept', h3: 'accept' });
  });

  test('acceptFile yields scope file', async () => {
    const h = hook();
    const req = fabricateRequest({ hunks: 2 });
    const promise = api.review.review(req, slowExplain(100).fn);
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    await h.waitForExplained();
    assert.equal(h.decide('acceptFile'), true);
    const decision = await promise;
    assert.equal(decision.verdict, 'accept');
    assert.equal(decision.scope, 'file');
  });

  test('closing the panel resolves reject with "Review closed without a decision"', async () => {
    const h = hook();
    const req = fabricateRequest({ hunks: 2 });
    const promise = api.review.review(req, slowExplain(200).fn);
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    h.closePanel();
    const decision = await promise;
    assert.equal(decision.verdict, 'reject');
    assert.equal(decision.reason, 'Review closed without a decision');
    assert.equal(h.current(), undefined);
  });

  test('requests queue FIFO while a review is in progress', async () => {
    const h = hook();
    const first = fabricateRequest({ hunks: 1 });
    const second = fabricateRequest({ hunks: 1 });
    const p1 = api.review.review(first, slowExplain(100).fn);
    await waitFor(() => h.current()?.requestId === first.id, 'first review to be shown');
    const p2 = api.review.review(second, slowExplain(100).fn);
    await sleep(50);
    assert.equal(h.current()!.requestId, first.id, 'the second request waits');
    assert.equal(h.waiting(), 1);
    await h.waitForExplained();
    assert.equal(h.decide('accept'), true);
    const d1 = await p1;
    assert.equal(d1.verdict, 'accept');
    await waitFor(() => h.current()?.requestId === second.id, 'second review to be shown');
    assert.equal(h.waiting(), 0);
    await h.waitForExplained();
    assert.equal(h.decide('accept'), true);
    const d2 = await p2;
    assert.equal(d2.requestId, second.id);
  });

  test('a failing explanation shows the error state and accept stays refused', async () => {
    const h = hook();
    const req = fabricateRequest({ hunks: 1 });
    let attempts = 0;
    const failing = async (): Promise<ChangeExplanation> => {
      attempts++;
      throw new Error('assistant unavailable');
    };
    const promise = api.review.review(req, failing);
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    await waitFor(() => h.current()?.cards[0].explain === 'error', 'error state', 15000);
    assert.equal(attempts, 2, 'exactly one jittered retry');
    assert.equal(h.decide('accept'), false);
    await assert.rejects(h.waitForExplained(), /assistant unavailable/);
    assert.equal(h.decide('reject', 'Could not read an explanation'), true);
    const decision = await promise;
    assert.equal(decision.verdict, 'reject');
  });

  test('a request with warnings needs an explicit "I understand" before accept', async () => {
    const h = hook();
    const req = fabricateRequest({ hunks: 1, warnings: ['This change touches the .git folder.'] });
    const promise = api.review.review(req, slowExplain(100).fn);
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    await h.waitForExplained();
    assert.equal(h.decide('accept'), false, 'refused until the warning is acknowledged');
    assert.equal(h.ackWarning(true), true);
    assert.equal(h.decide('accept'), true);
    const decision = await promise;
    assert.equal(decision.verdict, 'accept');
  });

  test('cancelling the token resolves reject without a person', async () => {
    const h = hook();
    const req = fabricateRequest({ hunks: 1 });
    const src = new CancelSource();
    const promise = api.review.review(req, slowExplain(500).fn, { token: src.token });
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    src.cancel();
    const decision = await promise;
    assert.equal(decision.verdict, 'reject');
    assert.match(decision.reason ?? '', /cancelled/);
  });

  test('trivial hunks are batched into one self-explained card', async () => {
    const h = hook();
    const req = fabricateRequest({ hunks: 1 });
    const file = Object.keys(req.hunksByPath)[0];
    req.hunksByPath[file].push(
      { id: 'ws1', kind: 'function', functionName: 'greet', changeType: 'modified', beforeText: 'a\n', afterText: 'a \n', trivial: true },
      { id: 'ws2', kind: 'other', changeType: 'modified', beforeText: '# x\n', afterText: '# y\n', trivial: true },
    );
    const { fn, calls } = slowExplain(100);
    const promise = api.review.review(req, fn);
    await waitFor(() => h.current()?.requestId === req.id, 'review to be shown');
    assert.equal(h.current()!.cards.length, 2);
    assert.match(h.current()!.cards[1].title, /^Whitespace and comment-only changes \(2\)/);
    await h.waitForExplained();
    assert.equal(h.decide('accept'), true);
    assert.equal(h.current()!.explained, true, 'the trivial card explains itself without an assistant call');
    assert.equal(h.decide('accept'), true);
    const decision = await promise;
    assert.deepEqual(decision.hunkVerdicts, { h1: 'accept', ws1: 'accept', ws2: 'accept' });
    assert.deepEqual(calls, ['h1'], 'no assistant call for the trivial card');
  });
});
