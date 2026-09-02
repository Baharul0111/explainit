import * as assert from 'node:assert/strict';
import { createDecisionMemory, hunkHashOf } from '../../../src/review/pure/memory';
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
