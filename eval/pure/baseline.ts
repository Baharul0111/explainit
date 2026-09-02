/**
 * Baseline lock logic (REQ-020): the shape of eval/baseline.json, how a run is folded into it, and
 * the regression comparison the CI test performs. Pure: no I/O.
 *
 *   {
 *     promptHash: "<sha256 of every prompt template>",
 *     scores:  { claude: {passAt1, style, n, ranAt}, codex: {...}, fake: {...} },   latest per channel
 *     history: [ {ranAt, channel, promptHash, scores: {...snapshot of `scores` after that run}}, ... ]  newest last
 *   }
 *
 * Every history entry is a snapshot of all channels' latest scores, so "newest vs previous" compares
 * each channel against its own last recorded value even when the runs were made one channel at a time.
 */

export type EvalChannelName = 'claude' | 'codex' | 'copilot' | 'fake';

export interface ChannelScore {
  /** Fraction 0..1 of problems whose resynthesized code passed the HumanEval tests. */
  passAt1: number;
  /** Fraction 0..1 of explanations that passed the deterministic style check. */
  style: number;
  /** Problems attempted. */
  n: number;
  ranAt: string;
}

export type ScoreMap = Partial<Record<EvalChannelName, ChannelScore>>;

export interface HistoryEntry {
  ranAt: string;
  /** Channel whose run produced this entry. */
  channel: EvalChannelName;
  promptHash: string;
  scores: ScoreMap;
}

export interface Baseline {
  promptHash: string;
  scores: ScoreMap;
  history: HistoryEntry[];
}

export const MAX_HISTORY = 200;
const EPSILON = 1e-9;

/** Message used by the CI test when the prompts changed and nobody re-ran the eval. */
export function promptChangedMessage(channels: string[]): string {
  const c = channels.length ? channels.join(' / ') : '<c>';
  return `Prompts changed without re-running the eval: run npm run eval -- --channel ${c} --update-baseline`;
}

export function emptyBaseline(promptHash: string): Baseline {
  return { promptHash, scores: {}, history: [] };
}

/** Parse the text of eval/baseline.json; a plain-English `error` when it cannot be used as it is. */
export function parseBaselineText(raw: string): { baseline?: Baseline; error?: string } {
  if (!raw.trim()) return { error: 'eval/baseline.json is empty.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `eval/baseline.json is not valid JSON: ${(e as Error).message}` };
  }
  const problems = validateBaseline(parsed);
  if (problems.length) return { error: problems.join(' ') };
  return { baseline: parsed as Baseline };
}

/** Validate a parsed baseline file; returns plain-English problems (empty = usable). */
export function validateBaseline(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== 'object') return ['eval/baseline.json is not a JSON object.'];
  const b = value as Partial<Baseline>;
  if (typeof b.promptHash !== 'string' || !/^[0-9a-f]{64}$/.test(b.promptHash)) problems.push('eval/baseline.json has no valid "promptHash".');
  if (!b.scores || typeof b.scores !== 'object') problems.push('eval/baseline.json has no "scores" object.');
  if (!Array.isArray(b.history)) problems.push('eval/baseline.json has no "history" array.');
  else {
    b.history.forEach((h, i) => {
      if (!h || typeof h !== 'object' || typeof (h as HistoryEntry).ranAt !== 'string' || !(h as HistoryEntry).scores || typeof (h as HistoryEntry).scores !== 'object') {
        problems.push(`History entry ${i} in eval/baseline.json is malformed.`);
      }
    });
  }
  return problems;
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Fold one run's score into the baseline: update `scores[channel]`, set the prompt hash, and push a
 * snapshot onto history (newest last, capped). Returns a new object; the input is not mutated.
 */
export function updateBaseline(existing: Baseline | undefined, channel: EvalChannelName, score: ChannelScore, promptHash: string): Baseline {
  const base = existing ?? emptyBaseline(promptHash);
  const cleaned: ChannelScore = { passAt1: round(score.passAt1), style: round(score.style), n: score.n, ranAt: score.ranAt };
  const scores: ScoreMap = { ...base.scores, [channel]: cleaned };
  const entry: HistoryEntry = { ranAt: score.ranAt, channel, promptHash, scores: { ...scores } };
  const history = [...base.history, entry].slice(-MAX_HISTORY);
  return { promptHash, scores, history };
}

export interface RegressionReport {
  ok: boolean;
  /** One message per regression, in the exact wording the CI test prints. */
  problems: string[];
  /** Channels compared (present in both the newest and the previous entry). */
  compared: EvalChannelName[];
}

/**
 * Newest history entry versus the one before it: for every channel present in both, passAt1 and
 * style must not have dropped. Fewer than two entries, or no shared channel, is a pass.
 */
export function compareNewestToPrevious(history: HistoryEntry[]): RegressionReport {
  if (!Array.isArray(history) || history.length < 2) return { ok: true, problems: [], compared: [] };
  const newest = history[history.length - 1];
  const previous = history[history.length - 2];
  const problems: string[] = [];
  const compared: EvalChannelName[] = [];
  for (const channel of Object.keys(newest.scores ?? {}) as EvalChannelName[]) {
    const now = newest.scores[channel];
    const before = previous.scores?.[channel];
    if (!now || !before) continue;
    compared.push(channel);
    const drops: string[] = [];
    if (now.passAt1 + EPSILON < before.passAt1) drops.push(`pass@1 fell from ${fmt(before.passAt1)} to ${fmt(now.passAt1)}`);
    if (now.style + EPSILON < before.style) drops.push(`style conformance fell from ${fmt(before.style)} to ${fmt(now.style)}`);
    if (drops.length) {
      problems.push(`Explanation quality dropped for ${channel}: ${drops.join('; ')} (previous run ${before.ranAt}, newest run ${now.ranAt}); refusing this prompt change.`);
    }
  }
  return { ok: problems.length === 0, problems, compared };
}

/**
 * Newest history entry versus the BEST score ever recorded under the same prompt hash: for every
 * channel in the newest entry, passAt1 and style must be at least the highest value any earlier
 * entry with that prompt hash recorded for that channel. This closes the gap the previous-run check
 * leaves open: a drop followed by a smaller recovery (1.0 -> 0.83 -> 0.92) or a drop repeated in two
 * runs passes "newest >= previous" but still sits below what the prompts have already proven they
 * can do. Entries measured with other prompts are ignored (a prompt change legitimately resets the bar).
 * Fewer than two entries under the current hash, or no shared channel, is a pass.
 */
export function compareNewestToBest(history: HistoryEntry[]): RegressionReport {
  if (!Array.isArray(history) || history.length < 2) return { ok: true, problems: [], compared: [] };
  const newest = history[history.length - 1];
  const earlier = history.slice(0, -1).filter((h) => h && h.promptHash === newest.promptHash && h.scores && typeof h.scores === 'object');
  const problems: string[] = [];
  const compared: EvalChannelName[] = [];
  for (const channel of Object.keys(newest.scores ?? {}) as EvalChannelName[]) {
    const now = newest.scores[channel];
    if (!now) continue;
    let bestPass: ChannelScore | undefined;
    let bestStyle: ChannelScore | undefined;
    for (const h of earlier) {
      const s = h.scores[channel];
      if (!s) continue;
      if (!bestPass || s.passAt1 > bestPass.passAt1) bestPass = s;
      if (!bestStyle || s.style > bestStyle.style) bestStyle = s;
    }
    if (!bestPass || !bestStyle) continue;
    compared.push(channel);
    const drops: string[] = [];
    if (now.passAt1 + EPSILON < bestPass.passAt1) drops.push(`pass@1 is ${fmt(now.passAt1)}, below the best run's ${fmt(bestPass.passAt1)} (${bestPass.ranAt})`);
    if (now.style + EPSILON < bestStyle.style) drops.push(`style conformance is ${fmt(now.style)}, below the best run's ${fmt(bestStyle.style)} (${bestStyle.ranAt})`);
    if (drops.length) {
      problems.push(`Explanation quality for ${channel} is below the best run with these prompts: ${drops.join('; ')} (newest run ${now.ranAt}); refusing this prompt change.`);
    }
  }
  return { ok: problems.length === 0, problems, compared };
}

/** Both regression checks together: newest versus previous, and newest versus the best run under the current prompts. */
export function compareNewest(history: HistoryEntry[]): RegressionReport {
  const previous = compareNewestToPrevious(history);
  const best = compareNewestToBest(history);
  const compared = [...previous.compared];
  for (const c of best.compared) if (!compared.includes(c)) compared.push(c);
  return { ok: previous.ok && best.ok, problems: [...previous.problems, ...best.problems], compared };
}

/** Would folding `score` into the baseline pass both regression checks? (used by --update-baseline to warn) */
export function previewRegression(existing: Baseline | undefined, channel: EvalChannelName, score: ChannelScore, promptHash: string): RegressionReport {
  return compareNewest(updateBaseline(existing, channel, score, promptHash).history);
}

export interface StaleChannel {
  channel: EvalChannelName;
  /** Prompt hash the channel's newest run was measured with (undefined when no run is recorded). */
  measuredWith?: string;
}

/**
 * Channels whose scores were measured with different prompts than `baseline.promptHash`: a prompt
 * change followed by re-running only one channel leaves the others' scores meaningless until they
 * are re-run too. The scripted `fake` channel says nothing about the prompts and is exempt. The
 * run that produced a score is the oldest history entry carrying that score's `ranAt`.
 */
export function staleChannels(baseline: Baseline): StaleChannel[] {
  const out: StaleChannel[] = [];
  for (const [name, score] of Object.entries(baseline.scores ?? {}) as [EvalChannelName, ChannelScore | undefined][]) {
    if (name === 'fake' || !score) continue;
    const run = (baseline.history ?? []).find((h) => h?.scores?.[name]?.ranAt === score.ranAt);
    if (!run || run.promptHash !== baseline.promptHash) out.push({ channel: name, measuredWith: run?.promptHash });
  }
  return out;
}

/** The CI wording for stale channels: which ones to re-run and why. */
export function staleChannelsMessage(stale: StaleChannel[], currentHash: string): string {
  const why = stale.map((s) => `${s.channel} was measured with prompt hash ${s.measuredWith ? s.measuredWith.slice(0, 12) + '…' : '(unknown)'}`).join(', ');
  return `${promptChangedMessage(stale.map((s) => s.channel))} (${why}; the current prompts hash to ${currentHash.slice(0, 12)}…)`;
}

export function fmt(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}
