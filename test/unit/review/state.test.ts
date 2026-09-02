import * as assert from 'node:assert/strict';
import {
  CLOSED_WITHOUT_DECISION,
  NOTHING_REVIEWABLE,
  createInitialState,
  effectiveScope,
  currentCard,
  explainQueue,
  finalize,
  isComplete,
  reduce,
  rejectReasonText,
  snapshot,
  type ReviewState,
} from '../../../src/review/pure/state';
import type { ChangeExplanation, FunctionHunk, GateRequest } from '../../../src/core/types';

function hunk(id: string, extra: Partial<FunctionHunk> = {}): FunctionHunk {
  return { id, kind: 'function', functionName: id, changeType: 'modified', beforeText: 'a\n', afterText: 'b\n', trivial: false, ...extra };
}

function request(hunksByPath: Record<string, FunctionHunk[]>, extra: Partial<GateRequest> = {}): GateRequest {
  return {
    id: 'req-9',
    agent: 'claude',
    sessionId: 'sess',
    toolName: 'Edit',
    cwd: '/w',
    writes: Object.keys(hunksByPath).map((p) => ({ kind: 'modify' as const, path: p, before: '', after: '' })),
    hunksByPath,
    receivedAt: new Date().toISOString(),
    ...extra,
  };
}

const explanation: ChangeExplanation = {
  functionName: 'f',
  whatChanged: 'It now returns early.',
  whyItMatters: ['Faster.'],
  modelChannel: 'claude',
  createdAt: new Date().toISOString(),
};

const twoHunks = () => request({ '/w/app.py': [hunk('h1'), hunk('h2')] });
const init = (req = twoHunks(), allowSessionAccept = true): ReviewState =>
  createInitialState(req, { batchTrivial: true, allowSessionAccept });

/** Apply a series of actions, asserting each succeeds. */
function run(state: ReviewState, ...actions: Parameters<typeof reduce>[1][]): ReviewState {
  for (const a of actions) {
    const r = reduce(state, a);
    assert.ok(r.ok, `expected ${a.type} to succeed: ${r.error}`);
    state = r.state;
  }
  return state;
}

suite('review/pure/state initial state', () => {
  test('cards start pending; trivial card starts explained', () => {
    const s = createInitialState(request({ '/w/a.py': [hunk('f'), hunk('ws', { trivial: true })] }), { batchTrivial: true, allowSessionAccept: true });
    assert.equal(s.cards.length, 2);
    assert.equal(s.cards[0].explain, 'pending');
    assert.equal(s.cards[1].explain, 'done');
    assert.equal(s.cards[1].explanation?.modelChannel, 'none');
    assert.equal(s.current, 0);
    assert.equal(s.scope, 'one');
    assert.deepEqual(s.paths, ['/w/a.py']);
    assert.deepEqual(explainQueue(s), ['card-1']);
  });

  test('warnings are carried and start unacknowledged', () => {
    const s = init(request({ '/w/.git/config': [hunk('x')] }, { warnings: ['This change touches .git'] }));
    assert.deepEqual(s.warnings, ['This change touches .git']);
    assert.equal(s.warningAcknowledged, false);
  });

  test('an empty request is complete immediately and finalizes as accept', () => {
    const s = init(request({}));
    assert.equal(isComplete(s), true);
    assert.equal(finalize(s).verdict, 'accept');
  });

  test('a request that really changes files but has nothing reviewable fails closed (reject, never accept unseen)', () => {
    // No hunks at all, yet the write deletes a file: a person never saw it, so it is not accepted.
    const del = request({}, { writes: [{ kind: 'delete', path: '/w/gone.py', before: 'x', after: null }] });
    const s = init(del);
    assert.equal(isComplete(s), true);
    const d = finalize(s);
    assert.equal(d.verdict, 'reject');
    assert.equal(d.reason, NOTHING_REVIEWABLE);
    // Same for a content change with an empty hunk list.
    const mod = request({}, { writes: [{ kind: 'modify', path: '/w/a.py', before: 'a', after: 'b' }] });
    assert.equal(finalize(init(mod)).verdict, 'reject');
    // A true no-op (same content, no hunks) is still an accept.
    const noop = request({}, { writes: [{ kind: 'modify', path: '/w/a.py', before: 'a', after: 'a' }] });
    assert.equal(finalize(init(noop)).verdict, 'accept');
  });
});

suite('review/pure/state accept-before-explained refusal (host-side)', () => {
  test('accept is refused while pending, streaming, or errored; allowed after explainDone', () => {
    let s = init();
    let r = reduce(s, { type: 'accept', cardId: 'card-1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not-explained');
    assert.equal(r.state, s, 'state is unchanged on refusal');

    s = run(s, { type: 'explainStart', cardId: 'card-1' }, { type: 'explainChunk', cardId: 'card-1', chunk: 'It now' });
    assert.equal(s.cards[0].explain, 'streaming');
    assert.equal(s.cards[0].text, 'It now');
    r = reduce(s, { type: 'accept', cardId: 'card-1' });
    assert.equal(r.code, 'not-explained');

    s = run(s, { type: 'explainError', cardId: 'card-1', reason: 'timed out' });
    r = reduce(s, { type: 'accept', cardId: 'card-1' });
    assert.equal(r.code, 'not-explained');
    assert.match(r.error!, /Retry/);

    s = run(s, { type: 'retry', cardId: 'card-1' }, { type: 'explainDone', cardId: 'card-1', explanation });
    r = reduce(s, { type: 'accept', cardId: 'card-1' });
    assert.equal(r.ok, true);
    assert.equal(r.state.cards[0].verdict, 'accept');
    assert.equal(r.state.current, 1);
  });

  test('retry is a no-op unless the explanation failed (a call is already on its way)', () => {
    let s = run(init(), { type: 'explainStart', cardId: 'card-1' }, { type: 'explainChunk', cardId: 'card-1', chunk: 'partial' });
    const r = reduce(s, { type: 'retry', cardId: 'card-1' });
    assert.equal(r.ok, true);
    assert.equal(r.state, s, 'state unchanged while streaming');
    s = run(s, { type: 'explainError', cardId: 'card-1', reason: 'x' });
    const after = reduce(s, { type: 'retry', cardId: 'card-1' }).state;
    assert.equal(after.cards[0].explain, 'pending');
    assert.equal(after.cards[0].text, '');
  });

  test('accept rest of file / session are also refused before the current card is explained', () => {
    const s = init();
    assert.equal(reduce(s, { type: 'acceptFile', cardId: 'card-1' }).code, 'not-explained');
    assert.equal(reduce(s, { type: 'acceptSession', cardId: 'card-1' }).code, 'not-explained');
  });

  test('reject does not require an explanation but requires a reason', () => {
    const s = init();
    const r = reduce(s, { type: 'reject', cardId: 'card-1', reason: '   ' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'reason-required');
    const ok = reduce(s, { type: 'reject', cardId: 'card-1', reason: 'Keep the old name' });
    assert.equal(ok.ok, true);
    assert.equal(ok.state.cards[0].rejectReason, 'Keep the old name');
  });

  test('only the current card can be decided, and never twice', () => {
    let s = init();
    assert.equal(reduce(s, { type: 'reject', cardId: 'card-2', reason: 'x' }).code, 'not-current');
    assert.equal(reduce(s, { type: 'accept', cardId: 'nope' }).code, 'unknown-card');
    s = run(s, { type: 'reject', cardId: 'card-1', reason: 'x' });
    assert.equal(reduce(s, { type: 'reject', cardId: 'card-1', reason: 'y' }).code, 'already-decided');
  });

  test('warnings require an explicit acknowledgement before accept', () => {
    let s = init(request({ '/w/.git/hooks/x': [hunk('x')] }, { warnings: ['touches .git'] }));
    s = run(s, { type: 'explainDone', cardId: 'card-1', explanation });
    assert.equal(reduce(s, { type: 'accept', cardId: 'card-1' }).code, 'warning-not-acknowledged');
    s = run(s, { type: 'ackWarning', value: true });
    assert.equal(reduce(s, { type: 'accept', cardId: 'card-1' }).ok, true);
    s = run(s, { type: 'ackWarning', value: false });
    assert.equal(reduce(s, { type: 'accept', cardId: 'card-1' }).code, 'warning-not-acknowledged');
  });

  test('explain events for a done card are ignored; chunks after error are ignored', () => {
    let s = init();
    s = run(s, { type: 'explainDone', cardId: 'card-1', explanation });
    const r = reduce(s, { type: 'explainError', cardId: 'card-1', reason: 'late' });
    assert.equal(r.ok, true);
    assert.equal(r.state.cards[0].explain, 'done');
    s = run(init(), { type: 'explainError', cardId: 'card-1', reason: 'boom' });
    s = run(s, { type: 'explainChunk', cardId: 'card-1', chunk: 'late' });
    assert.equal(s.cards[0].explain, 'error');
    assert.equal(s.cards[0].text, '');
  });

  test('actions after close are refused', () => {
    let s = init();
    s = run(s, { type: 'close' });
    assert.equal(reduce(s, { type: 'reject', cardId: 'card-1', reason: 'x' }).code, 'closed');
  });

  test('acceptSession is refused when the setting is off', () => {
    let s = init(twoHunks(), false);
    s = run(s, { type: 'explainDone', cardId: 'card-1', explanation });
    assert.equal(reduce(s, { type: 'acceptSession', cardId: 'card-1' }).code, 'session-accept-disabled');
  });
});

suite('review/pure/state decision aggregation', () => {
  const explainAll = (s: ReviewState): ReviewState =>
    s.cards.reduce((acc, c) => run(acc, { type: 'explainDone', cardId: c.card.id, explanation }), s);

  test('all accepted -> accept with scope one and per-hunk verdicts', () => {
    let s = explainAll(init());
    s = run(s, { type: 'accept', cardId: 'card-1' }, { type: 'accept', cardId: 'card-2' });
    assert.equal(isComplete(s), true);
    const d = finalize(s, () => '2026-09-02T00:00:00.000Z');
    assert.deepEqual(d, {
      requestId: 'req-9',
      verdict: 'accept',
      scope: 'one',
      decidedAt: '2026-09-02T00:00:00.000Z',
      hunkVerdicts: { h1: 'accept', h2: 'accept' },
    });
  });

  test('one accept + one reject -> partial with the reason verbatim', () => {
    let s = explainAll(init());
    s = run(s, { type: 'accept', cardId: 'card-1' }, { type: 'reject', cardId: 'card-2', reason: 'Do not log passwords' });
    const d = finalize(s);
    assert.equal(d.verdict, 'partial');
    assert.equal(d.reason, 'Do not log passwords');
    assert.deepEqual(d.hunkVerdicts, { h1: 'accept', h2: 'reject' });
  });

  test('all rejected -> reject; several reasons are listed per function', () => {
    let s = init();
    s = run(s, { type: 'reject', cardId: 'card-1', reason: 'first' }, { type: 'reject', cardId: 'card-2', reason: 'second' });
    const d = finalize(s);
    assert.equal(d.verdict, 'reject');
    assert.equal(d.reason, 'h1: first\nh2: second');
    assert.equal(rejectReasonText([]), undefined);
  });

  test('accept rest of file accepts the remaining hunks of that path only and sets scope file', () => {
    const req = request({ '/w/a.py': [hunk('a1'), hunk('a2')], '/w/b.py': [hunk('b1')] });
    let s = explainAll(init(req));
    s = run(s, { type: 'acceptFile', cardId: 'card-1' });
    assert.equal(s.cards[0].verdict, 'accept');
    assert.equal(s.cards[1].verdict, 'accept');
    assert.equal(s.cards[2].verdict, undefined);
    assert.equal(s.current, 2);
    assert.equal(s.scope, 'file');
    assert.deepEqual(s.fileAcceptedPaths, ['/w/a.py']);
    assert.equal(isComplete(s), false);
    s = run(s, { type: 'reject', cardId: 'card-3', reason: 'no' });
    const d = finalize(s);
    assert.equal(d.verdict, 'partial');
    // Decision.scope cannot name the file, and b.py was never file-accepted: report 'one' so the
    // decision memory does not loosen the checkpoint for b.py.
    assert.equal(d.scope, 'one');
    assert.deepEqual(d.hunkVerdicts, { a1: 'accept', a2: 'accept', b1: 'reject' });
  });

  test('scope file is reported only when every path of the request was file-accepted', () => {
    const single = explainAll(init(request({ '/w/a.py': [hunk('a1'), hunk('a2')] })));
    const s1 = run(single, { type: 'acceptFile', cardId: 'card-1' });
    assert.equal(effectiveScope(s1), 'file');
    assert.equal(finalize(s1).scope, 'file');

    const multi = explainAll(init(request({ '/w/a.py': [hunk('a1')], '/w/b.py': [hunk('b1'), hunk('b2')] })));
    const partial = run(multi, { type: 'acceptFile', cardId: 'card-1' }, { type: 'accept', cardId: 'card-2' }, { type: 'accept', cardId: 'card-3' });
    assert.equal(partial.scope, 'file');
    assert.equal(finalize(partial).scope, 'one', 'b.py was accepted hunk by hunk, not as a file');
    const both = run(multi, { type: 'acceptFile', cardId: 'card-1' }, { type: 'acceptFile', cardId: 'card-2' });
    assert.equal(finalize(both).scope, 'file');
    assert.equal(finalize(both).verdict, 'accept');
  });

  test('accept rest of session accepts everything remaining and sets scope session', () => {
    const req = request({ '/w/a.py': [hunk('a1'), hunk('a2')], '/w/b.py': [hunk('b1')] });
    let s = run(init(req), { type: 'explainDone', cardId: 'card-1', explanation });
    s = run(s, { type: 'acceptSession', cardId: 'card-1' });
    assert.equal(isComplete(s), true);
    const d = finalize(s);
    assert.equal(d.verdict, 'accept');
    assert.equal(d.scope, 'session');
    assert.deepEqual(d.hunkVerdicts, { a1: 'accept', a2: 'accept', b1: 'accept' });
  });

  test('trivial card is accepted as a batch: all its hunk ids get the verdict', () => {
    const req = request({ '/w/a.py': [hunk('ws1', { trivial: true }), hunk('ws2', { trivial: true })] });
    let s = init(req);
    assert.equal(s.cards.length, 1);
    assert.equal(currentCard(s)?.explain, 'done', 'trivial card explains itself');
    s = run(s, { type: 'accept', cardId: 'card-1' });
    assert.deepEqual(finalize(s).hunkVerdicts, { ws1: 'accept', ws2: 'accept' });
  });

  test('closing resolves reject with the closed-without-decision reason', () => {
    let s = explainAll(init());
    s = run(s, { type: 'accept', cardId: 'card-1' });
    s = run(s, { type: 'close' });
    assert.equal(isComplete(s), true);
    const d = finalize(s);
    assert.equal(d.verdict, 'reject');
    assert.equal(d.reason, CLOSED_WITHOUT_DECISION);
    assert.equal(d.hunkVerdicts, undefined);
    // Closing a finished review changes nothing.
    const done = run(explainAll(init()), { type: 'accept', cardId: 'card-1' }, { type: 'accept', cardId: 'card-2' });
    assert.equal(reduce(done, { type: 'close' }).state.closedReason, undefined);
  });

  test('custom close reason is kept (cancellation)', () => {
    const s = run(init(), { type: 'close', reason: 'Review cancelled before a decision was made' });
    assert.equal(finalize(s).reason, 'Review cancelled before a decision was made');
  });
});

suite('review/pure/state explain queue and snapshot', () => {
  test('explainQueue lists pending non-trivial cards from the current one forward', () => {
    const req = request({ '/w/a.py': [hunk('a'), hunk('ws', { trivial: true }), hunk('b'), hunk('c')] });
    let s = init(req);
    assert.deepEqual(explainQueue(s), ['card-1', 'card-3', 'card-4']);
    s = run(s, { type: 'explainStart', cardId: 'card-1' });
    assert.deepEqual(explainQueue(s), ['card-3', 'card-4']);
    s = run(s, { type: 'explainError', cardId: 'card-1', reason: 'x' });
    assert.deepEqual(explainQueue(s), ['card-3', 'card-4'], 'errored cards wait for an explicit retry');
    s = run(s, { type: 'reject', cardId: 'card-1', reason: 'r' }, { type: 'accept', cardId: 'card-2' });
    assert.deepEqual(explainQueue(s), ['card-3', 'card-4']);
    s = run(s, { type: 'close' });
    assert.deepEqual(explainQueue(s), []);
  });

  test('snapshot reflects the current card and explained flag', () => {
    let s = init();
    let snap = snapshot(s);
    assert.equal(snap.requestId, 'req-9');
    assert.equal(snap.hunkIndex, 0);
    assert.equal(snap.explained, false);
    assert.equal(snap.cards.length, 2);
    assert.equal(snap.complete, false);
    s = run(s, { type: 'explainDone', cardId: 'card-1', explanation });
    snap = snapshot(s);
    assert.equal(snap.explained, true);
    s = run(s, { type: 'accept', cardId: 'card-1' });
    snap = snapshot(s);
    assert.equal(snap.hunkIndex, 1);
    assert.equal(snap.explained, false);
    assert.equal(snap.cards[0].verdict, 'accept');
  });

  test('reducer never mutates the previous state', () => {
    const s = init();
    const frozen = JSON.stringify(s);
    reduce(s, { type: 'explainDone', cardId: 'card-1', explanation });
    reduce(s, { type: 'reject', cardId: 'card-1', reason: 'x' });
    reduce(s, { type: 'ackWarning', value: true });
    assert.equal(JSON.stringify(s), frozen);
  });
});
