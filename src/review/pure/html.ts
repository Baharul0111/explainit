/**
 * Pure HTML helpers for the review panel: escaping, diff rendering and the card models the webview
 * renders. Everything here is deterministic and unit-tested; no `vscode` import.
 *
 * Security note: every string that originates from an agent (code, file names, function names,
 * explanations) goes through `escapeHtml` before it reaches the webview, so `<script>` inside a
 * proposed change is shown as text, never executed.
 */
import * as Diff from 'diff';
import type { FunctionHunk, GateRequest, HunkChangeType } from '../../core/types';
import { normalizeNewlines } from '../../core/hash';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Alphanumeric-only id fragment so agent text can never break out of an attribute. */
export function safeId(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, '_');
}

export type DiffRowKind = 'add' | 'remove' | 'ctx';

export interface DiffRow {
  kind: DiffRowKind;
  /** 1-based line number in the before text (undefined for added lines). */
  oldLine?: number;
  /** 1-based line number in the after text (undefined for removed lines). */
  newLine?: number;
  text: string;
}

/**
 * Above this many lines (before + after) the LCS diff is skipped: it is quadratic in the worst case
 * and a hunk that large is read in the editor anyway. The rows then show every old line removed and
 * every new line added, so nothing is hidden, only un-aligned.
 */
export const MAX_DIFF_LINES = 4000;

/** Line diff of before/after text computed host-side with jsdiff (`diffLines`). */
export function diffRows(beforeText: string, afterText: string, maxLines = MAX_DIFF_LINES): DiffRow[] {
  const before = normalizeNewlines(beforeText ?? '');
  const after = normalizeNewlines(afterText ?? '');
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  if (beforeLines.length + afterLines.length > maxLines) {
    for (const text of beforeLines) rows.push({ kind: 'remove', oldLine: oldLine++, text });
    for (const text of afterLines) rows.push({ kind: 'add', newLine: newLine++, text });
    return rows;
  }
  for (const part of Diff.diffLines(before, after)) {
    const lines = splitLines(part.value);
    for (const text of lines) {
      if (part.added) rows.push({ kind: 'add', newLine: newLine++, text });
      else if (part.removed) rows.push({ kind: 'remove', oldLine: oldLine++, text });
      else rows.push({ kind: 'ctx', oldLine: oldLine++, newLine: newLine++, text });
    }
  }
  return rows;
}

function splitLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  // A chunk that ends with "\n" produces a trailing empty string that is not a real line.
  if (lines.length && lines[lines.length - 1] === '' && value.endsWith('\n')) lines.pop();
  return lines;
}

/** Rows beyond this many are hidden behind a "Show all" button so huge hunks stay readable. */
export const COLLAPSE_AFTER_ROWS = 60;
/** Rows beyond this many are not put into the webview at all (a note says how many were left out). */
export const MAX_RENDERED_ROWS = 2000;

export interface DiffHtml {
  html: string;
  /** Total rows of the diff (including any that were not rendered). */
  rows: number;
  collapsed: boolean;
  /** Rows left out of the HTML because the hunk is enormous. */
  truncated: number;
}

/**
 * Escaped HTML table for a hunk diff. Row classes: `add`, `remove`, `ctx`; rows past
 * `collapseAfter` get the extra class `more` and are revealed by the webview's "Show all" button.
 */
export function diffToHtml(
  beforeText: string,
  afterText: string,
  collapseAfter = COLLAPSE_AFTER_ROWS,
  maxRendered = MAX_RENDERED_ROWS,
): DiffHtml {
  const rows = diffRows(beforeText, afterText);
  if (rows.length === 0) {
    return { html: '<div class="diff-empty">No line differences.</div>', rows: 0, collapsed: false, truncated: 0 };
  }
  const collapsed = rows.length > collapseAfter;
  const truncated = Math.max(0, rows.length - maxRendered);
  const out: string[] = [];
  out.push('<table class="diff" role="presentation">');
  rows.slice(0, maxRendered).forEach((r, i) => {
    const hidden = collapsed && i >= collapseAfter ? ' more' : '';
    const sign = r.kind === 'add' ? '+' : r.kind === 'remove' ? '-' : ' ';
    out.push(
      `<tr class="${r.kind}${hidden}">` +
        `<td class="ln">${r.oldLine ?? ''}</td>` +
        `<td class="ln">${r.newLine ?? ''}</td>` +
        `<td class="sign">${sign}</td>` +
        `<td class="code">${escapeHtml(r.text)}</td>` +
        '</tr>',
    );
  });
  if (truncated > 0) {
    out.push(
      `<tr class="truncated${collapsed ? ' more' : ''}"><td class="ln"></td><td class="ln"></td><td class="sign"></td>` +
        `<td class="code">… ${truncated} more line${truncated === 1 ? '' : 's'} not shown here. Open the file in the editor to read all of it.</td></tr>`,
    );
  }
  out.push('</table>');
  return { html: out.join(''), rows: rows.length, collapsed, truncated };
}

// ---------------------------------------------------------------------------------------------
// Card models
// ---------------------------------------------------------------------------------------------

export type CardKind = 'function' | 'other' | 'trivial';

export interface CardModel {
  /** Stable per request: `card-<n>`. */
  id: string;
  kind: CardKind;
  /** Plain text title, e.g. "Function 1 of 3: load_config (modified)". */
  title: string;
  path: string;
  /** Hunk ids covered by this card (several for the batched trivial card). */
  hunkIds: string[];
  changeType: HunkChangeType;
  functionName?: string;
  /** Escaped, ready-to-insert diff HTML. */
  diffHtml: string;
  diffRows: number;
  diffCollapsed: boolean;
  /** Rows left out of `diffHtml` because the hunk is enormous (0 normally). */
  diffTruncated: number;
  /** For the trivial card: plain-text description lines of each batched hunk. */
  trivialItems?: string[];
  /** True when the card needs no assistant call (trivial changes explain themselves). */
  selfExplained: boolean;
}

const CHANGE_WORD: Record<HunkChangeType, string> = { added: 'added', removed: 'removed', modified: 'modified' };

export function describeTrivialHunk(h: FunctionHunk): string {
  const where = h.functionName ? `in ${h.functionName}` : 'outside any function';
  const lines = countChangedLines(h);
  return `${where}: ${lines} line${lines === 1 ? '' : 's'} changed (whitespace or comments only)`;
}

function countChangedLines(h: FunctionHunk): number {
  return diffRows(h.beforeText, h.afterText).filter((r) => r.kind !== 'ctx').length;
}

/**
 * One card per hunk in order; trivial hunks are batched into one card at the position of the first
 * trivial hunk when `batchTrivial` is on. Cards keep the order of `request.writes`.
 */
export function buildCards(request: GateRequest, opts: { batchTrivial: boolean }): CardModel[] {
  const ordered: { path: string; hunk: FunctionHunk }[] = [];
  const seen = new Set<string>();
  const pathsInOrder = [...request.writes.map((w) => w.path), ...Object.keys(request.hunksByPath ?? {})];
  for (const p of pathsInOrder) {
    if (seen.has(p)) continue;
    seen.add(p);
    for (const hunk of request.hunksByPath?.[p] ?? []) ordered.push({ path: p, hunk });
  }

  const trivial = opts.batchTrivial ? ordered.filter((o) => o.hunk.trivial) : [];
  const singles = opts.batchTrivial ? ordered.filter((o) => !o.hunk.trivial) : ordered;
  const isFunctionHunk = (h: FunctionHunk): boolean => h.kind === 'function' || !!h.functionName;
  const functionTotal = singles.filter((o) => isFunctionHunk(o.hunk)).length;

  const cards: CardModel[] = [];
  let n = 0;
  let functionIndex = 0;
  let trivialInserted = false;
  const firstTrivialIdx = ordered.findIndex((o) => o.hunk.trivial);

  const pushTrivial = (): void => {
    if (trivialInserted || trivial.length === 0) return;
    trivialInserted = true;
    n++;
    const before = trivial.map((t) => t.hunk.beforeText).join('\n');
    const after = trivial.map((t) => t.hunk.afterText).join('\n');
    const d = diffToHtml(before, after);
    cards.push({
      id: `card-${n}`,
      kind: 'trivial',
      title: `Whitespace and comment-only changes (${trivial.length})`,
      path: trivial[0].path,
      hunkIds: trivial.map((t) => t.hunk.id),
      changeType: 'modified',
      diffHtml: d.html,
      diffRows: d.rows,
      diffCollapsed: d.collapsed,
      diffTruncated: d.truncated,
      trivialItems: trivial.map((t) => describeTrivialHunk(t.hunk)),
      selfExplained: true,
    });
  };

  ordered.forEach((o, idx) => {
    if (opts.batchTrivial && o.hunk.trivial) {
      if (idx === firstTrivialIdx) pushTrivial();
      return;
    }
    n++;
    const d = diffToHtml(o.hunk.beforeText, o.hunk.afterText);
    const isFn = isFunctionHunk(o.hunk);
    let title: string;
    if (isFn) {
      functionIndex++;
      title = `Function ${functionIndex} of ${functionTotal}: ${o.hunk.functionName ?? 'unnamed'} (${CHANGE_WORD[o.hunk.changeType]})`;
    } else {
      title = `Lines outside any function (${CHANGE_WORD[o.hunk.changeType]})`;
    }
    cards.push({
      id: `card-${n}`,
      kind: isFn ? 'function' : 'other',
      title,
      path: o.path,
      hunkIds: [o.hunk.id],
      changeType: o.hunk.changeType,
      functionName: o.hunk.functionName,
      diffHtml: d.html,
      diffRows: d.rows,
      diffCollapsed: d.collapsed,
      diffTruncated: d.truncated,
      selfExplained: false,
    });
  });
  pushTrivial();
  return cards;
}

/** Fixed, credit-free explanation shown for the batched trivial card. */
export function trivialExplanationText(items: string[]): { whatChanged: string; whyItMatters: string[] } {
  return {
    whatChanged: `Only spacing, blank lines or comments changed in ${items.length} place${items.length === 1 ? '' : 's'}.`,
    whyItMatters: ['The code will behave exactly as before.', 'Nothing here needs a careful read; accept if the formatting looks right.'],
  };
}

/** Plain-English label for the agent shown in the header. */
export function agentLabel(agent: string): string {
  switch (agent) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'copilot':
      return 'Copilot';
    default:
      return agent;
  }
}

/** Short display form of an absolute path: last two segments. */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

/** Random nonce for the webview CSP; alphanumeric only. */
export function makeNonce(random: () => number = Math.random): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(random() * chars.length)];
  return out;
}
