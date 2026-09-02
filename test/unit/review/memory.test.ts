import * as assert from 'node:assert/strict';
import { createDecisionMemory, hasSessionId, hunkHashOf, INACTIVITY_TTL_MS } from '../../../src/review/pure/memory';
import type { Decision, FunctionHunk, GateRequest } from '../../../src/core/types';

function hunk(id: string, before: string, after: string, extra: Partial<FunctionHunk> = {}): FunctionHunk {
  return { id, kind: 'function', functionName: id, changeType: 'modified', beforeText: before, afterText: after, trivial: false, ...extra };
}

function request(overrides: Partial<GateRequest> = {}): GateRequest {
  const a = hunk('h1', 'a', 'b');
  const b = hunk('h2', 'c', 'd');
  return {
    id: 'req-1',
    agent: 'claude',
    sessionId: 's1',
    toolName: 'Write',
    cwd: '/w',
    writes: [{ kind: 'modify', path: '/w/app.py', before: 'a\nc', after: 'b\nd' }],
    hunksByPath: { '/w/app.py': [a, b] },
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

const decision = (verdict: Decision['verdict'], scope: Decision['scope'], extra: Partial<Decision> = {}): Decision => ({
  requestId: 'req-1',
  verdict,
  scope,
  decidedAt: new Date().toISOString(),
  ...extra,
});

suite('review/pure/memory', () => {
  test('hunkHashOf ignores line endings and trailing whitespace, but not content', () => {
    const a = hunkHashOf({ beforeText: 'x = 1\r\ny = 2  \r\n', afterText: 'x = 2\r\n' });
    const b = hunkHashOf({ beforeText: 'x = 1\ny = 2\n', afterText: 'x = 2\n' });
    const c = hunkHashOf({ beforeText: 'x = 1\ny = 3\n', afterText: 'x = 2\n' });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  test('hunkHashOf distinguishes before/after swaps', () => {
    assert.notEqual(hunkHashOf({ beforeText: 'a', afterText: 'b' }), hunkHashOf({ beforeText: 'b', afterText: 'a' }));
  });

  test('empty memory returns undefined', () => {
    const m = createDecisionMemory();
    assert.equal(m.lookup('claude', 's1', '/w/app.py', 'deadbeef'), undefined);
  });

  test('session accept covers every path and hunk for that agent+session only', () => {
    const m = createDecisionMemory();
    m.remember(decision('accept', 'session'), request());
    assert.equal(m.lookup('claude', 's1', '/w/other.py', 'anything'), 'accept');
    assert.equal(m.lookup('claude', 's2', '/w/other.py', 'anything'), undefined);
    assert.equal(m.lookup('codex', 's1', '/w/other.py', 'anything'), undefined);
  });

  test('file accept covers only the request paths of that session', () => {
    const m = createDecisionMemory();
    m.remember(decision('accept', 'file'), request());
    assert.equal(m.lookup('claude', 's1', '/w/app.py', 'x'), 'accept');
    assert.equal(m.lookup('claude', 's1', '/w/other.py', 'x'), undefined);
    assert.equal(m.lookup('claude', 's9', '/w/app.py', 'x'), undefined);
  });

  test('plain accept remembers the hashes of the accepted hunks (identical re-proposal auto-accepts)', () => {
    const m = createDecisionMemory();
    const req = request();
    m.remember(decision('accept', 'one'), req);
    const h1 = hunkHashOf(req.hunksByPath['/w/app.py'][0]);
    assert.equal(m.lookup('claude', 's1', '/w/app.py', h1), 'accept');
    // Same content, different file or session: not covered.
    assert.equal(m.lookup('claude', 's1', '/w/other.py', h1), undefined);
    assert.equal(m.lookup('claude', 's2', '/w/app.py', h1), undefined);
    // A different change in the same file is not covered.
    assert.equal(m.lookup('claude', 's1', '/w/app.py', hunkHashOf({ beforeText: 'zz', afterText: 'yy' })), undefined);
  });

  test('lookup also works with the hunk id the gate passes (differ ids, not content hashes)', () => {
    const m = createDecisionMemory();
    const req = request();
    m.remember(decision('accept', 'one'), req);
    assert.equal(m.lookup('claude', 's1', '/w/app.py', 'h1'), 'accept');
    assert.equal(m.lookup('claude', 's1', '/w/app.py', 'h2'), 'accept');
    assert.equal(m.lookup('claude', 's1', '/w/app.py', 'h3'), undefined);
    assert.equal(m.lookup('claude', 's1', '/w/app.py', ''), undefined);
    assert.equal(m.lookup('claude', 's1', '/w/app.py', undefined as unknown as string), undefined);
    m.remember(decision('partial', 'one', { hunkVerdicts: { h1: 'accept', h2: 'reject' } }), request({ sessionId: 's2' }));
    assert.equal(m.lookup('claude', 's2', '/w/app.py', 'h1'), 'accept');
    assert.equal(m.lookup('claude', 's2', '/w/app.py', 'h2'), undefined);
  });

  test('partial decision remembers only the accepted hunks', () => {
    const m = createDecisionMemory();
    const req = request();
    m.remember(decision('partial', 'one', { hunkVerdicts: { h1: 'accept', h2: 'reject' }, reason: 'no' }), req);
    const [a, b] = req.hunksByPath['/w/app.py'];
    assert.equal(m.lookup('claude', 's1', '/w/app.py', hunkHashOf(a)), 'accept');
    assert.equal(m.lookup('claude', 's1', '/w/app.py', hunkHashOf(b)), undefined);
  });

  test('rejections, asks and denies teach nothing', () => {
    const m = createDecisionMemory();
    const req = request();
    for (const v of ['reject', 'ask', 'deny-protected', 'paused'] as const) m.remember(decision(v, 'session'), req);
    assert.deepEqual(m.size(), { sessions: 0, files: 0, hunks: 0 });
    assert.equal(m.lookup('claude', 's1', '/w/app.py', hunkHashOf(req.hunksByPath['/w/app.py'][0])), undefined);
  });

  test('clearSession forgets only that session; clearAll forgets everything', () => {
    const m = createDecisionMemory();
    m.remember(decision('accept', 'session'), request({ sessionId: 's1' }));
    m.remember(decision('accept', 'file'), request({ sessionId: 's2' }));
    m.remember(decision('accept', 'one'), request({ sessionId: 's3' }));
    m.clearSession('claude', 's1');
    assert.equal(m.lookup('claude', 's1', '/w/app.py', 'x'), undefined);
    assert.equal(m.lookup('claude', 's2', '/w/app.py', 'x'), 'accept');
    const h = hunkHashOf(request().hunksByPath['/w/app.py'][0]);
    assert.equal(m.lookup('claude', 's3', '/w/app.py', h), 'accept');
    m.clearAll();
    assert.equal(m.lookup('claude', 's2', '/w/app.py', 'x'), undefined);
    assert.equal(m.lookup('claude', 's3', '/w/app.py', h), undefined);
    assert.deepEqual(m.size(), { sessions: 0, files: 0, hunks: 0 });
  });

  test('clearSession does not confuse "s1" with "s10"', () => {
    const m = createDecisionMemory();
    m.remember(decision('accept', 'session'), request({ sessionId: 's1' }));
    m.remember(decision('accept', 'session'), request({ sessionId: 's10' }));
    m.clearSession('claude', 's1');
    assert.equal(m.lookup('claude', 's10', '/w/x', 'y'), 'accept');
  });

  test('a request without a session id gets no memory at all: nothing remembered, nothing found (F3)', () => {
    const m = createDecisionMemory();
    for (const sessionId of ['', '   ', '\t']) {
      m.remember(decision('accept', 'session'), request({ sessionId }));
      m.remember(decision('accept', 'file'), request({ sessionId }));
      m.remember(decision('accept', 'one'), request({ sessionId }));
    }
    assert.deepEqual(m.size(), { sessions: 0, files: 0, hunks: 0 });
    // A real session's acceptance is never visible to a request without an id, and never to another id.
    m.remember(decision('accept', 'session'), request({ sessionId: 's1' }));
    for (const sessionId of ['', '  ', undefined as unknown as string, 'unknown-session']) {
      assert.equal(m.lookup('claude', sessionId, '/w/app.py', 'h1'), undefined, JSON.stringify(sessionId));
    }
    assert.equal(m.lookup('claude', 's1', '/w/app.py', 'h1'), 'accept');
    assert.equal(hasSessionId('s1'), true);
    assert.equal(hasSessionId(''), false);
    assert.equal(hasSessionId(' '), false);
    assert.equal(hasSessionId(undefined), false);
    assert.equal(hasSessionId(42), false);
  });

  test('session and file acceptances expire after 30 minutes without use; a hit refreshes them (F3)', () => {
    let now = 1_000_000_000;
    const m = createDecisionMemory({ now: () => now });
    assert.equal(INACTIVITY_TTL_MS, 30 * 60_000);
    m.remember(decision('accept', 'session'), request({ sessionId: 's1' }));
    m.remember(decision('accept', 'file'), request({ sessionId: 's2' }));
    now += INACTIVITY_TTL_MS - 1000;
    assert.equal(m.lookup('claude', 's1', '/w/any.py', 'x'), 'accept');
    assert.equal(m.lookup('claude', 's2', '/w/app.py', 'x'), 'accept');
    // Used just before the deadline: the clock restarts from that use.
    now += INACTIVITY_TTL_MS - 1000;
    assert.equal(m.lookup('claude', 's1', '/w/any.py', 'x'), 'accept');
    assert.equal(m.lookup('claude', 's2', '/w/app.py', 'x'), 'accept');
    // Left alone for longer than the window: gone, and a review is needed again.
    now += INACTIVITY_TTL_MS + 1;
    assert.equal(m.lookup('claude', 's1', '/w/any.py', 'x'), undefined);
    assert.equal(m.lookup('claude', 's2', '/w/app.py', 'x'), undefined);
    const size = m.size();
    assert.equal(size.sessions, 0);
    assert.equal(size.files, 0);
    assert.equal(size.hunks, 4, 'the exact hunks the file-wide accept covered stay known (2 hunks, by hash and by id)');
    // Remembering again after expiry works as a fresh acceptance.
    m.remember(decision('accept', 'session'), request({ sessionId: 's1' }));
    assert.equal(m.lookup('claude', 's1', '/w/any.py', 'x'), 'accept');
  });

  test('the inactivity window is configurable for tests; hunk-hash memory does not time out', () => {
    let now = 0;
    const m = createDecisionMemory({ now: () => now, ttlMs: 100 });
    const req = request({ sessionId: 's1' });
    m.remember(decision('accept', 'one'), req);
    m.remember(decision('accept', 'session'), req);
    m.remember(decision('accept', 'file'), request({ sessionId: 's3' }));
    now = 101;
    assert.equal(m.lookup('claude', 's1', '/w/other.py', 'zz'), undefined, 'session acceptance expired');
    assert.equal(m.lookup('claude', 's3', '/w/app.py', 'zz'), undefined, 'file acceptance expired');
    const h = hunkHashOf(req.hunksByPath['/w/app.py'][0]);
    assert.equal(m.lookup('claude', 's1', '/w/app.py', h), 'accept', 'the exact accepted hunk is still known');
    assert.equal(m.lookup('claude', 's3', '/w/app.py', 'h1'), 'accept', 'and so are the hunks a file-wide accept covered');
  });

  test('hunk memory is capped so a long session cannot grow without bound', () => {
    const m = createDecisionMemory();
    for (let i = 0; i < 5200; i++) {
      const req = request({ hunksByPath: { '/w/app.py': [hunk('h' + i, 'before' + i, 'after' + i)] } });
      m.remember(decision('accept', 'one'), req);
    }
    assert.ok(m.size().hunks <= 10000);
    // Newest survives, oldest was evicted.
    assert.equal(m.lookup('claude', 's1', '/w/app.py', hunkHashOf({ beforeText: 'before5199', afterText: 'after5199' })), 'accept');
    assert.equal(m.lookup('claude', 's1', '/w/app.py', hunkHashOf({ beforeText: 'before0', afterText: 'after0' })), undefined);
  });
});
