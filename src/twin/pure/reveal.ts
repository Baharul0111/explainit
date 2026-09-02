/**
 * Where a programmatic "reveal at top" really lands (scroll sync, REQ-010). Pure: no vscode.
 *
 * VS Code pads every API reveal so the revealed line never hides under the sticky-scroll header:
 * `revealRange(range, AtTop)` puts the line `min(viewportLines / 2, max(cursorSurroundingLines,
 * stickyScroll.maxLineCount))` lines below the top of the viewport (with the defaults: 5 lines, see
 * `_computeScrollTopToRevealRange` in editor/browser/viewParts/viewLines). Scroll sync wants the section
 * header or the `def` line ON the top line, so it reveals that many lines further down instead.
 */
export interface RevealOptions {
  /** `editor.stickyScroll.enabled` */
  stickyScrollEnabled: boolean;
  /** `editor.stickyScroll.maxLineCount` */
  stickyMaxLineCount: number;
  /** `editor.cursorSurroundingLines` */
  cursorSurroundingLines: number;
  /** Lines the viewport shows right now (sum of the visible ranges). */
  viewportLines: number;
}

function nonNegative(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** How many lines above a revealed line VS Code keeps visible. */
export function revealPaddingLines(o: RevealOptions): number {
  const wanted = Math.max(nonNegative(o.cursorSurroundingLines), o.stickyScrollEnabled ? nonNegative(o.stickyMaxLineCount) : 0);
  const padding = Math.min(nonNegative(o.viewportLines) / 2, wanted);
  // A fractional padding still hides a whole extra line at the top.
  return Math.ceil(padding);
}

/** The line to hand to `revealRange(..., AtTop)` so that `target` becomes the top visible line. */
export function revealLineFor(target: number, padding: number, lastLine: number): number {
  const last = Math.max(0, lastLine);
  const wanted = Math.max(0, Math.min(target, last));
  return Math.min(last, wanted + Math.max(0, padding));
}
