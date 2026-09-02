import * as assert from 'node:assert';
import { MAX_HISTORY, compareNewest, compareNewestToBest, compareNewestToPrevious, emptyBaseline, fmt, parseBaselineText, previewRegression, promptChangedMessage, staleChannels, staleChannelsMessage, updateBaseline, validateBaseline, type Baseline, type ChannelScore, type HistoryEntry } from './pure/baseline';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

function score(passAt1: number, style: number, ranAt = '2026-09-02T08:00:00.000Z', n = 12): ChannelScore {
  return { passAt1, style, n, ranAt };
}

function entry(scores: HistoryEntry['scores'], ranAt = '2026-09-02T08:00:00.000Z', channel: HistoryEntry['channel'] = 'claude'): HistoryEntry {
  return { ranAt, channel, promptHash: H1, scores };
}

suite('eval/pure/baseline: compareNewestToPrevious', () => {
  test('fewer than two entries passes', () => {
    assert.deepStrictEqual(compareNewestToPrevious([]), { ok: true, problems: [], compared: [] });
    assert.deepStrictEqual(compareNewestToPrevious([entry({ claude: score(0.5, 0.5) })]), { ok: true, problems: [], compared: [] });
    assert.ok(compareNewestToPrevious(undefined as never).ok);
  });

  test('equal or better scores pass', () => {
    const h = [entry({ claude: score(0.75, 0.9) }), entry({ claude: score(0.75, 1.0) })];
    const r = compareNewestToPrevious(h);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.compared, ['claude']);
  });

  test('a pass@1 drop fails with the exact wording', () => {
    const h = [entry({ claude: score(0.8333, 1) }, '2026-09-01T00:00:00.000Z'), entry({ claude: score(0.75, 1, '2026-09-02T00:00:00.000Z') }, '2026-09-02T00:00:00.000Z')];
    const r = compareNewestToPrevious(h);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problems.length, 1);
    assert.ok(r.problems[0].startsWith('Explanation quality dropped for claude: pass@1 fell from 83.3% to 75%'), r.problems[0]);
    assert.ok(r.problems[0].endsWith('refusing this prompt change.'), r.problems[0]);
  });

  test('a style drop fails, and both drops are listed together', () => {
    const h = [entry({ codex: score(0.5, 1) }), entry({ codex: score(0.4, 0.9) })];
    const r = compareNewestToPrevious(h);
    assert.strictEqual(r.ok, false);
    assert.ok(/pass@1 fell/.test(r.problems[0]) && /style conformance fell from 100% to 90%/.test(r.problems[0]));
    assert.ok(/dropped for codex/.test(r.problems[0]));
  });

  test('only channels present in both entries are compared', () => {
    const h = [entry({ claude: score(0.9, 1) }), entry({ claude: score(0.9, 1), codex: score(0.1, 0.1) })];
    const r = compareNewestToPrevious(h);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.compared, ['claude']);
    // A channel dropping from the previous entry is not a regression either.
    assert.ok(compareNewestToPrevious([entry({ claude: score(1, 1), codex: score(1, 1) }), entry({ claude: score(1, 1) })]).ok);
  });

  test('only the two newest entries matter', () => {
    const h = [entry({ claude: score(1, 1) }), entry({ claude: score(0.2, 0.2) }), entry({ claude: score(0.3, 0.3) })];
    assert.ok(compareNewestToPrevious(h).ok);
  });

  test('floating point noise is not a drop', () => {
    const h = [entry({ claude: score(0.1 + 0.2, 1) }), entry({ claude: score(0.3, 1) })];
    assert.ok(compareNewestToPrevious(h).ok);
  });

  test('several channels can regress at once', () => {
    const h = [entry({ claude: score(1, 1), codex: score(1, 1), fake: score(1, 1) }), entry({ claude: score(0.5, 1), codex: score(1, 0.5), fake: score(1, 1) })];
    const r = compareNewestToPrevious(h);
    assert.strictEqual(r.problems.length, 2);
    assert.deepStrictEqual(r.compared, ['claude', 'codex', 'fake']);
  });
});

suite('eval/pure/baseline: compareNewestToBest', () => {
  const at = (day: number): string => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const run = (scores: HistoryEntry['scores'], day: number, promptHash = H1, channel: HistoryEntry['channel'] = 'claude'): HistoryEntry => ({ ranAt: at(day), channel, promptHash, scores });

  test('fewer than two entries, or no earlier entry under the same prompt hash, passes', () => {
    assert.deepStrictEqual(compareNewestToBest([]), { ok: true, problems: [], compared: [] });
    assert.deepStrictEqual(compareNewestToBest([run({ claude: score(0.5, 0.5) }, 1)]), { ok: true, problems: [], compared: [] });
    assert.ok(compareNewestToBest(undefined as never).ok);
    // The old prompts' best run does not bind a run made with new prompts.
    const r = compareNewestToBest([run({ claude: score(1, 1, at(1)) }, 1, H1), run({ claude: score(0.5, 1, at(2)) }, 2, H2)]);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.compared, []);
  });

  test('a sequence of small drops is refused against the best run', () => {
    // 12/12 -> 11/12 -> 11/12: the newest run equals the previous one (the previous-run check is happy)
    // but is still below the best the prompts achieved.
    const equalAfterDrop = [run({ claude: score(1, 1, at(1)) }, 1), run({ claude: score(0.9167, 1, at(2)) }, 2), run({ claude: score(0.9167, 1, at(3)) }, 3)];
    assert.ok(compareNewestToPrevious(equalAfterDrop).ok, 'previous-run check alone lets it through');
    const r = compareNewestToBest(equalAfterDrop);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.compared, ['claude']);
    assert.strictEqual(r.problems.length, 1);
    assert.ok(r.problems[0].startsWith('Explanation quality for claude is below the best run with these prompts: pass@1 is 91.7%, below the best run\'s 100% (2026-09-01T00:00:00.000Z)'), r.problems[0]);
    assert.ok(r.problems[0].endsWith('refusing this prompt change.'), r.problems[0]);

    // 12/12 -> 10/12 -> 11/12: a partial recovery is a rise for the previous-run check, still a drop against the best.
    const partialRecovery = [run({ claude: score(1, 1, at(1)) }, 1), run({ claude: score(0.8333, 1, at(2)) }, 2), run({ claude: score(0.9167, 1, at(3)) }, 3)];
    assert.ok(compareNewestToPrevious(partialRecovery).ok);
    assert.strictEqual(compareNewestToBest(partialRecovery).ok, false);

    // Both checks together refuse it, and the combined report keeps both wordings when both apply.
    assert.strictEqual(compareNewest(partialRecovery).ok, false);
    const both = compareNewest([run({ claude: score(1, 1, at(1)) }, 1), run({ claude: score(0.9, 1, at(2)) }, 2), run({ claude: score(0.8, 1, at(3)) }, 3)]);
    assert.strictEqual(both.problems.length, 2);
    assert.ok(/dropped for claude: pass@1 fell from 90% to 80%/.test(both.problems[0]));
    assert.ok(/below the best run's 100%/.test(both.problems[1]));
    assert.deepStrictEqual(both.compared, ['claude']);
  });

  test('equal to the best passes; style is compared to its own best independently of pass@1', () => {
    const h = [run({ claude: score(0.9, 1, at(1)) }, 1), run({ claude: score(1, 0.9, at(2)) }, 2), run({ claude: score(1, 1, at(3)) }, 3)];
    assert.ok(compareNewestToBest(h).ok);
    const styleDrop = [...h, run({ claude: score(1, 0.95, at(4)) }, 4)];
    const r = compareNewestToBest(styleDrop);
    assert.strictEqual(r.ok, false);
    assert.ok(/style conformance is 95%, below the best run's 100% \(2026-09-01T00:00:00.000Z\)/.test(r.problems[0]), r.problems[0]);
    assert.ok(!/pass@1/.test(r.problems[0]));
  });

  test('only channels with an earlier score under the current prompts are compared; floating point noise is not a drop', () => {
    const h = [run({ claude: score(1, 1, at(1)) }, 1), run({ claude: score(1, 1, at(1)), codex: score(0.1, 0.1, at(2)) }, 2, H1, 'codex')];
    const r = compareNewestToBest(h);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.compared, ['claude']);
    assert.ok(compareNewestToBest([run({ fake: score(0.1 + 0.2, 1) }, 1), run({ fake: score(0.3, 1) }, 2)]).ok);
    // A malformed earlier entry is skipped rather than crashing the check.
    assert.ok(compareNewestToBest([{ ranAt: at(1), channel: 'claude', promptHash: H1, scores: undefined as never }, run({ claude: score(1, 1) }, 2)]).ok);
  });

  test('the committed-shape history (one channel at a time, snapshots carried forward) passes when nothing dropped', () => {
    let b = updateBaseline(undefined, 'fake', score(0.9167, 1, at(1)), H1);
    b = updateBaseline(b, 'claude', score(1, 1, at(2)), H1);
    b = updateBaseline(b, 'codex', score(1, 1, at(3)), H1);
    assert.ok(compareNewestToBest(b.history).ok);
    b = updateBaseline(b, 'fake', score(0.8333, 1, at(4)), H1);
    assert.strictEqual(compareNewestToBest(b.history).ok, false, 'fake dropped below its best 91.7%');
    // previewRegression now covers the best-run check too.
    const good = updateBaseline(undefined, 'claude', score(1, 1, at(1)), H1);
    const dipped = updateBaseline(good, 'claude', score(0.8333, 1, at(2)), H1);
    assert.strictEqual(previewRegression(dipped, 'claude', score(0.9167, 1, at(3)), H1).ok, false, 'a partial recovery is still below the best');
  });
});

suite('eval/pure/baseline: updateBaseline', () => {
  test('creates a baseline from nothing', () => {
    const b = updateBaseline(undefined, 'claude', score(0.83333333, 1), H1);
    assert.strictEqual(b.promptHash, H1);
    assert.deepStrictEqual(b.scores.claude, score(0.8333, 1));
    assert.strictEqual(b.history.length, 1);
    assert.strictEqual(b.history[0].channel, 'claude');
    assert.strictEqual(b.history[0].promptHash, H1);
    assert.deepStrictEqual(b.history[0].scores, b.scores);
  });

  test('keeps other channels, appends history newest last, never mutates the input', () => {
    const b1 = updateBaseline(undefined, 'claude', score(0.9, 1, '2026-09-01T00:00:00.000Z'), H1);
    const frozen = JSON.stringify(b1);
    const b2 = updateBaseline(b1, 'codex', score(0.7, 0.9, '2026-09-02T00:00:00.000Z'), H1);
    assert.strictEqual(JSON.stringify(b1), frozen);
    assert.deepStrictEqual(Object.keys(b2.scores).sort(), ['claude', 'codex']);
    assert.strictEqual(b2.history.length, 2);
    assert.strictEqual(b2.history[1].channel, 'codex');
    assert.deepStrictEqual(b2.history[1].scores.claude, b1.scores.claude, 'snapshot carries the other channel forward');
    // One channel at a time: the snapshot approach means the comparison passes for the unchanged channel.
    assert.ok(compareNewestToPrevious(b2.history).ok);
    const b3 = updateBaseline(b2, 'claude', score(0.8, 1, '2026-09-03T00:00:00.000Z'), H1);
    assert.strictEqual(compareNewestToPrevious(b3.history).ok, false, 'claude dropped 0.9 -> 0.8');
  });

  test('a new prompt hash replaces the old one', () => {
    const b1 = updateBaseline(undefined, 'claude', score(0.9, 1), H1);
    const b2 = updateBaseline(b1, 'claude', score(0.9, 1), H2);
    assert.strictEqual(b2.promptHash, H2);
    assert.strictEqual(b2.history[0].promptHash, H1);
    assert.strictEqual(b2.history[1].promptHash, H2);
  });

  test('history is capped', () => {
    let b: Baseline | undefined;
    for (let i = 0; i < MAX_HISTORY + 5; i++) b = updateBaseline(b, 'fake', score(1, 1, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`), H1);
    assert.strictEqual(b!.history.length, MAX_HISTORY);
  });

  test('previewRegression reports what the fold would do', () => {
    const b1 = updateBaseline(undefined, 'claude', score(0.9, 1), H1);
    assert.ok(previewRegression(b1, 'claude', score(0.9, 1), H1).ok);
    assert.strictEqual(previewRegression(b1, 'claude', score(0.5, 1), H1).ok, false);
  });
});

suite('eval/pure/baseline: validation and messages', () => {
  test('validateBaseline', () => {
    assert.deepStrictEqual(validateBaseline(emptyBaseline(H1)), []);
    assert.ok(validateBaseline(null).length);
    assert.ok(validateBaseline({ promptHash: 'short', scores: {}, history: [] }).some((p) => /promptHash/.test(p)));
    assert.ok(validateBaseline({ promptHash: H1, history: [] }).some((p) => /scores/.test(p)));
    assert.ok(validateBaseline({ promptHash: H1, scores: {} }).some((p) => /history/.test(p)));
    assert.ok(validateBaseline({ promptHash: H1, scores: {}, history: [{ nope: true }] }).some((p) => /History entry 0/.test(p)));
  });

  test('promptChangedMessage', () => {
    assert.strictEqual(promptChangedMessage(['claude']), 'Prompts changed without re-running the eval: run npm run eval -- --channel claude --update-baseline');
    assert.ok(promptChangedMessage([]).includes('--channel <c> --update-baseline'));
  });

  test('fmt', () => {
    assert.strictEqual(fmt(0.8333), '83.3%');
    assert.strictEqual(fmt(1), '100%');
    assert.strictEqual(fmt(0), '0%');
  });
});

suite('eval/pure/baseline: stale channels after a prompt change', () => {
  test('all channels measured with the current prompts -> nothing is stale', () => {
    let b = updateBaseline(undefined, 'claude', score(1, 1, '2026-09-01T00:00:00.000Z'), H1);
    b = updateBaseline(b, 'codex', score(1, 1, '2026-09-02T00:00:00.000Z'), H1);
    b = updateBaseline(b, 'fake', score(0.9, 1, '2026-09-03T00:00:00.000Z'), H1);
    assert.deepStrictEqual(staleChannels(b), []);
  });

  test('re-running only one channel after a prompt change leaves the others stale (fake is exempt)', () => {
    let b = updateBaseline(undefined, 'claude', score(1, 1, '2026-09-01T00:00:00.000Z'), H1);
    b = updateBaseline(b, 'codex', score(1, 1, '2026-09-02T00:00:00.000Z'), H1);
    b = updateBaseline(b, 'fake', score(0.9, 1, '2026-09-03T00:00:00.000Z'), H1);
    b = updateBaseline(b, 'claude', score(1, 1, '2026-09-04T00:00:00.000Z'), H2);
    assert.deepStrictEqual(staleChannels(b), [{ channel: 'codex', measuredWith: H1 }]);
    const msg = staleChannelsMessage(staleChannels(b), H2);
    assert.ok(msg.startsWith('Prompts changed without re-running the eval: run npm run eval -- --channel codex --update-baseline'), msg);
    assert.ok(msg.includes(`codex was measured with prompt hash ${H1.slice(0, 12)}…`), msg);
    // Re-running codex clears it.
    b = updateBaseline(b, 'codex', score(1, 1, '2026-09-05T00:00:00.000Z'), H2);
    assert.deepStrictEqual(staleChannels(b), []);
  });

  test('a score with no matching history run is reported as stale with an unknown hash', () => {
    const b: Baseline = { promptHash: H1, scores: { claude: score(1, 1) }, history: [] };
    assert.deepStrictEqual(staleChannels(b), [{ channel: 'claude', measuredWith: undefined }]);
    assert.ok(staleChannelsMessage(staleChannels(b), H1).includes('(unknown)'));
  });
});

suite('eval/pure/baseline: parseBaselineText (corrupt or empty files)', () => {
  test('empty, whitespace-only and truncated files give plain-English errors, never a throw', () => {
    assert.strictEqual(parseBaselineText('').error, 'eval/baseline.json is empty.');
    assert.strictEqual(parseBaselineText('   \n').error, 'eval/baseline.json is empty.');
    const truncated = JSON.stringify(emptyBaseline(H1)).slice(0, 20);
    assert.match(parseBaselineText(truncated).error!, /^eval\/baseline\.json is not valid JSON: /);
    assert.match(parseBaselineText('[]').error!, /promptHash/);
    assert.match(parseBaselineText('"a string"').error!, /not a JSON object/);
  });

  test('a good file parses', () => {
    const b = updateBaseline(undefined, 'fake', score(1, 1), H1);
    const r = parseBaselineText(JSON.stringify(b, null, 2) + '\n');
    assert.strictEqual(r.error, undefined);
    assert.deepStrictEqual(r.baseline, b);
  });
});
