/**
 * Result records and the text table printed at the end of a run. Pure.
 */
import type { ChannelScore, EvalChannelName } from './baseline';

export interface ProblemResult {
  taskId: string;
  entryPoint: string;
  /** The explanation the channel produced (absent when the explain step failed). */
  explanation?: { summary: string; steps: string[]; warnings?: string[]; uncertainty?: string };
  explainMs: number;
  explainError?: string;
  styleOk: boolean;
  styleProblems: string[];
  /** Code the channel wrote from the explanation alone (absent when resynth failed). */
  resynthCode?: string;
  resynthMs: number;
  resynthError?: string;
  /** HumanEval tests passed. */
  passed: boolean;
  testMs: number;
  /** Tail of the Python stderr when the tests failed. */
  testError?: string;
}

export interface RunSummary {
  channel: EvalChannelName;
  promptHash: string;
  ranAt: string;
  n: number;
  passAt1: number;
  style: number;
  explainFailures: number;
  resynthFailures: number;
  totalMs: number;
  results: ProblemResult[];
  /** Where the explain/resynth calls actually went (CLI path, source). Never a token. */
  channelDetail?: string;
}

export function summarize(channel: EvalChannelName, promptHash: string, ranAt: string, results: ProblemResult[], totalMs: number, channelDetail?: string): RunSummary {
  const n = results.length;
  const passed = results.filter((r) => r.passed).length;
  const styled = results.filter((r) => r.styleOk).length;
  return {
    channel,
    promptHash,
    ranAt,
    n,
    passAt1: n ? passed / n : 0,
    style: n ? styled / n : 0,
    explainFailures: results.filter((r) => !!r.explainError).length,
    resynthFailures: results.filter((r) => !!r.resynthError).length,
    totalMs,
    results,
    channelDetail,
  };
}

export function toChannelScore(summary: RunSummary): ChannelScore {
  return { passAt1: summary.passAt1, style: summary.style, n: summary.n, ranAt: summary.ranAt };
}

export function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function ms(v: number): string {
  if (!Number.isFinite(v) || v < 0) return '-';
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

function pad(s: string, w: number, right = false): string {
  const t = s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s;
  return right ? t.padStart(w) : t.padEnd(w);
}

/** A fixed-width table for the terminal (plain ASCII apart from the ellipsis). */
export function formatTable(summary: RunSummary): string {
  const cols: { title: string; width: number; right?: boolean; cell: (r: ProblemResult) => string }[] = [
    { title: 'task', width: 14, cell: (r) => r.taskId },
    { title: 'function', width: 26, cell: (r) => r.entryPoint },
    { title: 'explain', width: 8, cell: (r) => (r.explainError ? 'error' : 'ok') },
    { title: 'style', width: 6, cell: (r) => (r.styleOk ? 'ok' : 'no') },
    { title: 'resynth', width: 8, cell: (r) => (r.resynthError ? 'error' : r.resynthCode ? 'ok' : '-') },
    { title: 'tests', width: 6, cell: (r) => (r.passed ? 'pass' : 'FAIL') },
    { title: 'time', width: 8, right: true, cell: (r) => ms(r.explainMs + r.resynthMs + r.testMs) },
  ];
  const header = cols.map((c) => pad(c.title, c.width, c.right)).join('  ');
  const rule = cols.map((c) => '-'.repeat(c.width)).join('  ');
  const rows = summary.results.map((r) => cols.map((c) => pad(c.cell(r), c.width, c.right)).join('  '));
  const lines = [header, rule, ...rows, rule];
  if (!summary.results.length) lines.push('(no problems were run)');
  lines.push(`channel: ${summary.channel}   n: ${summary.n}   pass@1: ${pct(summary.passAt1)}   style: ${pct(summary.style)}   total: ${ms(summary.totalMs)}`);
  if (summary.explainFailures || summary.resynthFailures) {
    lines.push(`errors: ${summary.explainFailures} explain, ${summary.resynthFailures} resynth (each counts as a failed problem)`);
  }
  lines.push(`prompt hash: ${summary.promptHash.slice(0, 12)}…   ran at: ${summary.ranAt}`);
  return lines.join('\n');
}

/** Short per-problem notes for the lines under the table (why something failed). */
export function formatProblems(summary: RunSummary): string {
  const out: string[] = [];
  for (const r of summary.results) {
    const notes: string[] = [];
    if (r.explainError) notes.push(`explain: ${r.explainError}`);
    if (!r.styleOk && r.styleProblems.length) notes.push(`style: ${r.styleProblems.join(' ')}`);
    if (r.resynthError) notes.push(`resynth: ${r.resynthError}`);
    if (!r.passed && r.testError) notes.push(`tests: ${r.testError}`);
    if (notes.length) out.push(`${r.taskId} (${r.entryPoint})\n  ${notes.join('\n  ')}`);
  }
  return out.join('\n');
}

/** File-name safe timestamp: 2026-09-02T08-30-15Z (Windows forbids ':'). */
export function fileStamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}
