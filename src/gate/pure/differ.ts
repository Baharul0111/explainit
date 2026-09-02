/**
 * Per-function hunks (REQ-014) and exact reconstruction for partial acceptance. Pure.
 *
 * Approach: the leaf functions (records that contain no other record) of the before and after maps
 * are matched by id in order (longest common subsequence). Every matched pair whose text differs is
 * a `function` hunk with the full function text on both sides. Between consecutive matched pairs
 * lies a "region": unmatched after-functions become `added` hunks, unmatched before-functions
 * `removed` hunks, and the remaining gap lines are line-diffed (jsdiff `diffLines`) into `other`
 * hunks, one per contiguous changed block. After-ranges of all hunks are disjoint and the
 * before-ranges tile the before text in the same order, so `reconstruct` is exact by construction:
 * rejecting every hunk gives back the before text, accepting every hunk gives the after text.
 *
 * Texts are handled as lines: every non-empty text is treated as ending with a newline.
 */
import * as Diff from 'diff';
import type { FunctionHunk, FunctionMap, FunctionRecord, HunkChangeType, LineRange } from '../../core/types';
import { sha256, normalizeNewlines } from '../../core/hash';
import { isTrivialChange } from './trivial';
import { splitLines } from './text';

interface Leaf {
  rec: FunctionRecord;
  start: number; // inclusive
  end: number; // exclusive
}

/** Leaf function records sorted by start line, clipped to the text and de-overlapped. */
function leaves(map: FunctionMap | undefined, lineCount: number): Leaf[] {
  if (!map) return [];
  const recs: Leaf[] = map.functions
    .filter((f) => f.range.endLine >= f.range.startLine && f.range.startLine >= 0 && f.range.startLine < lineCount)
    .map((f) => ({ rec: f, start: f.range.startLine, end: Math.min(lineCount, f.range.endLine + 1) }));
  const isLeaf = (a: Leaf): boolean =>
    !recs.some((b) => b !== a && b.start >= a.start && b.end <= a.end && b.end - b.start < a.end - a.start);
  const sorted = recs.filter(isLeaf).sort((a, b) => a.start - b.start || a.end - b.end);
  // Drop any record that still overlaps its predecessor (bad ranges from a provider).
  const clean: Leaf[] = [];
  for (const l of sorted) {
    const prev = clean[clean.length - 1];
    if (prev && l.start < prev.end) continue;
    clean.push(l);
  }
  return clean;
}

/** Name of the innermost record (e.g. a class) containing the line, used as a hint on `other` hunks. */
function enclosingName(map: FunctionMap | undefined, line: number): string | undefined {
  if (!map) return undefined;
  let best: FunctionRecord | undefined;
  for (const f of map.functions) {
    if (f.range.startLine <= line && line <= f.range.endLine) {
      if (!best || f.range.endLine - f.range.startLine < best.range.endLine - best.range.startLine) best = f;
    }
  }
  return best?.name;
}

/** Longest common subsequence of leaf ids, returned as index pairs. */
function lcsPairs(a: Leaf[], b: Leaf[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].rec.id === b[j].rec.id ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].rec.id === b[j].rec.id) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function textOf(lines: string[], start: number, end: number): string {
  if (end <= start) return '';
  return lines.slice(start, end).join('\n') + '\n';
}

/** Empty ranges are encoded as endLine = startLine - 1 (an insertion point). */
function range(start: number, end: number): LineRange {
  return { startLine: start, endLine: end - 1 };
}

export interface HunkBuildOptions {
  languageId: string;
}

interface Draft {
  kind: FunctionHunk['kind'];
  functionName?: string;
  functionId?: string;
  changeType: HunkChangeType;
  beforeRange: LineRange;
  afterRange: LineRange;
  beforeText: string;
  afterText: string;
}

type Gap = { start: number; end: number };
type Item = { type: 'gap'; gap: Gap } | { type: 'fn'; leaf: Leaf };

/** [gap, fn, gap, fn, ..., gap] for the leaves in [fromLeaf, toLeaf) between cursor and stop. */
function regionItems(leafList: Leaf[], fromLeaf: number, toLeaf: number, cursor: number, stop: number): Item[] {
  const out: Item[] = [];
  let c = cursor;
  for (let x = fromLeaf; x < toLeaf; x++) {
    const l = leafList[x];
    out.push({ type: 'gap', gap: { start: c, end: Math.max(c, l.start) } });
    out.push({ type: 'fn', leaf: l });
    c = l.end;
  }
  out.push({ type: 'gap', gap: { start: c, end: Math.max(c, stop) } });
  return out;
}

/**
 * Build hunks for one file. `before`/`after` may be null for create/delete. Ranges refer to LF
 * normalised text. The returned order matters to `reconstruct` (hunks sharing an insertion point
 * are inserted in this order), so pass the array back unchanged.
 */
export function computeHunks(
  filePath: string,
  before: string | null,
  after: string | null,
  beforeMap: FunctionMap | undefined,
  afterMap: FunctionMap | undefined,
  opts: HunkBuildOptions,
): FunctionHunk[] {
  const bText = normalizeNewlines(before ?? '');
  const aText = normalizeNewlines(after ?? '');
  if (bText === aText) return [];
  const bLines = splitLines(bText);
  const aLines = splitLines(aText);
  const bLeaves = leaves(beforeMap, bLines.length);
  const aLeaves = leaves(afterMap, aLines.length);
  const pairs = lcsPairs(bLeaves, aLeaves);
  const drafts: Draft[] = [];

  let bi = 0; // next unconsumed before-leaf
  let ai = 0;
  let bCursor = 0; // next unconsumed before line
  let aCursor = 0;

  for (let k = 0; k <= pairs.length; k++) {
    const matched = k < pairs.length ? pairs[k] : undefined;
    const bStop = matched ? bLeaves[matched[0]].start : bLines.length;
    const aStop = matched ? aLeaves[matched[1]].start : aLines.length;
    const bLeafStop = matched ? matched[0] : bLeaves.length;
    const aLeafStop = matched ? matched[1] : aLeaves.length;

    const bItems = regionItems(bLeaves, bi, bLeafStop, bCursor, bStop);
    const aItems = regionItems(aLeaves, ai, aLeafStop, aCursor, aStop);
    const nGaps = Math.max((bItems.length + 1) / 2, (aItems.length + 1) / 2);

    // Gap g sits at index 2g, the function that follows it at 2g+1. Gaps are paired by index;
    // a side that runs out of items contributes an empty range at its current position.
    let aPos = aCursor;
    let bPos = bCursor;
    for (let g = 0; g < nGaps; g++) {
      const bGapItem = bItems[2 * g];
      const aGapItem = aItems[2 * g];
      const bGap = bGapItem?.type === 'gap' ? bGapItem.gap : { start: bPos, end: bPos };
      const aGap = aGapItem?.type === 'gap' ? aGapItem.gap : { start: aPos, end: aPos };
      drafts.push(...gapHunks(bLines, aLines, bGap, aGap, afterMap ?? beforeMap));
      bPos = bGap.end;
      aPos = aGap.end;
      const bFn = bItems[2 * g + 1];
      const aFn = aItems[2 * g + 1];
      if (bFn?.type === 'fn') {
        drafts.push({
          kind: 'function',
          functionName: bFn.leaf.rec.name,
          functionId: bFn.leaf.rec.id,
          changeType: 'removed',
          beforeRange: range(bFn.leaf.start, bFn.leaf.end),
          afterRange: range(aPos, aPos),
          beforeText: textOf(bLines, bFn.leaf.start, bFn.leaf.end),
          afterText: '',
        });
        bPos = bFn.leaf.end;
      }
      if (aFn?.type === 'fn') {
        drafts.push({
          kind: 'function',
          functionName: aFn.leaf.rec.name,
          functionId: aFn.leaf.rec.id,
          changeType: 'added',
          beforeRange: range(bPos, bPos),
          afterRange: range(aFn.leaf.start, aFn.leaf.end),
          beforeText: '',
          afterText: textOf(aLines, aFn.leaf.start, aFn.leaf.end),
        });
        aPos = aFn.leaf.end;
      }
    }

    if (matched) {
      const bl = bLeaves[matched[0]];
      const al = aLeaves[matched[1]];
      const bt = textOf(bLines, bl.start, bl.end);
      const at = textOf(aLines, al.start, al.end);
      if (bt !== at) {
        drafts.push({
          kind: 'function',
          functionName: al.rec.name,
          functionId: al.rec.id,
          changeType: 'modified',
          beforeRange: range(bl.start, bl.end),
          afterRange: range(al.start, al.end),
          beforeText: bt,
          afterText: at,
        });
      }
      bi = matched[0] + 1;
      ai = matched[1] + 1;
      bCursor = bl.end;
      aCursor = al.end;
    }
  }

  const seen = new Map<string, number>();
  return drafts.map((d) => {
    const trivial = isTrivialChange(d.beforeText, d.afterText, opts.languageId);
    const base = sha256(filePath + '\0' + (d.functionName ?? '') + '\0' + d.afterText);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      id: n === 1 ? base : `${base}-${n}`,
      kind: trivial ? 'trivial' : d.kind,
      functionName: d.functionName,
      functionId: d.functionId,
      changeType: d.changeType,
      beforeRange: d.beforeRange,
      afterRange: d.afterRange,
      beforeText: d.beforeText,
      afterText: d.afterText,
      trivial,
    };
  });
}

/** Line-diff a gap pair into `other` hunks, one per contiguous changed block. */
function gapHunks(bLines: string[], aLines: string[], bGap: Gap, aGap: Gap, hintMap: FunctionMap | undefined): Draft[] {
  const bt = textOf(bLines, bGap.start, bGap.end);
  const at = textOf(aLines, aGap.start, aGap.end);
  if (bt === at) return [];
  const out: Draft[] = [];
  let b = bGap.start;
  let a = aGap.start;
  let block: { bs: number; as: number; be: number; ae: number } | undefined;
  const flush = (): void => {
    if (!block) return;
    out.push({
      kind: 'other',
      // A hint (e.g. the enclosing class) only makes sense when the block has lines in the after text;
      // an insertion point may sit on the first line of the next function.
      functionName: block.ae > block.as ? enclosingName(hintMap, block.as) : undefined,
      changeType: block.be === block.bs ? 'added' : block.ae === block.as ? 'removed' : 'modified',
      beforeRange: range(block.bs, block.be),
      afterRange: range(block.as, block.ae),
      beforeText: textOf(bLines, block.bs, block.be),
      afterText: textOf(aLines, block.as, block.ae),
    });
    block = undefined;
  };
  for (const part of Diff.diffLines(bt, at)) {
    const n = part.count ?? splitLines(part.value).length;
    if (part.added) {
      block = block ?? { bs: b, as: a, be: b, ae: a };
      a += n;
      block.ae = a;
    } else if (part.removed) {
      block = block ?? { bs: b, as: a, be: b, ae: a };
      b += n;
      block.be = b;
    } else {
      flush();
      b += n;
      a += n;
    }
  }
  flush();
  return out;
}

/**
 * The after text with every rejected hunk reverted to its before text. Works on LF text (callers
 * restore the line-ending style); non-empty results end with a newline. Hunks must be passed in
 * the order `computeHunks` returned them. Hunks without an afterRange are ignored.
 */
export function reconstruct(after: string, hunks: FunctionHunk[], verdicts: Record<string, 'accept' | 'reject'>): string {
  const lines = splitLines(normalizeNewlines(after));
  const rejected = hunks
    .map((h, index) => ({ h, index }))
    .filter(({ h }) => verdicts[h.id] === 'reject' && h.afterRange)
    // Bottom-up so earlier indices stay valid; for equal start lines the later hunk goes first so the
    // earlier one ends up above it.
    .sort((x, y) => y.h.afterRange!.startLine - x.h.afterRange!.startLine || y.index - x.index);
  for (const { h } of rejected) {
    const start = h.afterRange!.startLine;
    const len = Math.max(0, h.afterRange!.endLine - start + 1);
    lines.splice(start, len, ...splitLines(h.beforeText));
  }
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

/** Ids of every hunk (helper for decision memory checks). */
export function hunkIds(hunks: FunctionHunk[]): string[] {
  return hunks.map((h) => h.id);
}
