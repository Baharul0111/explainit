/**
 * CI baseline lock (REQ-020, goal item 13): the real router's prompt hash must equal the one the
 * eval was last run with, and the newest eval scores must not be lower than the previous ones.
 * Runs in plain Node (npm run test:unit); no model is called.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Disposable, ExplanationCache } from '../src/core/interfaces';
import { createLogger } from '../src/core/log';
import { inMemorySettings } from '../src/core/settings';
import { createGenerationRouter } from '../src/generation';
import { EVAL_PATHS, repoRoot } from './paths';
import { compareNewestToPrevious, parseBaselineText, promptChangedMessage, staleChannels, staleChannelsMessage, type Baseline } from './pure/baseline';

function memoryCache(): ExplanationCache {
  const m = new Map();
  return { get: (h) => m.get(h), set: (h, e) => void m.set(h, e), has: (h) => m.has(h), size: () => m.size, flush: async () => undefined };
}

/** Load eval/baseline.json; a missing, empty or corrupt file fails with the plain-English fix. */
function loadBaseline(): Baseline {
  const file = EVAL_PATHS.baseline();
  const rel = path.relative(repoRoot(), file);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    assert.fail(`No eval baseline at ${rel}. ${promptChangedMessage(['claude', 'codex', 'fake'])}`);
  }
  const parsed = parseBaselineText(raw);
  assert.ok(parsed.baseline, `${rel} cannot be used: ${parsed.error} Delete it and ${promptChangedMessage(['claude', 'codex', 'fake']).replace(/^Prompts changed without re-running the eval: /, '')}`);
  return parsed.baseline;
}

suite('eval/baseline lock', () => {
  const disposables: Disposable[] = [];
  const quiet = createLogger([{ write: () => undefined }], 'baseline-test', 'error');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-baseline-test-'));

  suiteTeardown(() => {
    for (const d of disposables) d.dispose();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('the router prompts have not changed since the eval was last run', () => {
    const baseline = loadBaseline();
    const router = createGenerationRouter({
      logger: quiet,
      settings: inMemorySettings(),
      extensionPath: repoRoot(),
      version: '0.0.0-test',
      cache: memoryCache(),
      consent: { granted: () => false, setGranted: async () => undefined },
      disposables,
    });
    const channels = Object.keys(baseline.scores).filter((c) => c !== 'fake');
    assert.strictEqual(router.promptHash(), baseline.promptHash, promptChangedMessage(channels.length ? channels : ['claude', 'codex']));
  });

  test('every real channel was measured with the current prompts (no channel left behind after a prompt change)', () => {
    const baseline = loadBaseline();
    const stale = staleChannels(baseline);
    assert.deepStrictEqual(stale, [], staleChannelsMessage(stale, baseline.promptHash));
  });

  test('explanation quality did not drop between the two newest eval runs', () => {
    const baseline = loadBaseline();
    assert.ok(baseline.history.length >= 1, 'the baseline has no history; run npm run eval -- --channel <c> --update-baseline');
    const newest = baseline.history[baseline.history.length - 1];
    assert.strictEqual(newest.promptHash, baseline.promptHash, 'the newest history entry was recorded with a different prompt hash than the baseline');
    const report = compareNewestToPrevious(baseline.history);
    assert.ok(report.ok, report.problems.join('\n'));
  });

  test('the recorded scores are sane', () => {
    const baseline = loadBaseline();
    const entries = Object.entries(baseline.scores);
    assert.ok(entries.length >= 1, 'no channel has scores yet');
    for (const [channel, score] of entries) {
      assert.ok(score.passAt1 >= 0 && score.passAt1 <= 1, `${channel}.passAt1 out of range`);
      assert.ok(score.style >= 0 && score.style <= 1, `${channel}.style out of range`);
      assert.ok(Number.isInteger(score.n) && score.n >= 1, `${channel}.n must be a positive whole number`);
      assert.ok(!Number.isNaN(Date.parse(score.ranAt)), `${channel}.ranAt is not a date`);
    }
  });
});
