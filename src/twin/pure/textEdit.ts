/**
 * Minimal line-based replacement so a streaming twin rewrite touches only the lines that changed
 * (no flicker, viewport stays put). Pure; the vscode glue turns it into a Range edit.
 */
export interface LineReplace {
  /** First line to replace (0-based). */
  fromLine: number;
  /** Exclusive end line in the OLD text. */
  toLineExclusive: number;
  /** New lines that go in place of [fromLine, toLineExclusive). */
  lines: string[];
  /** Total line count of the old text (split on newlines). */
  oldLineCount: number;
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Returns undefined when the texts are identical. */
export function minimalLineReplace(oldText: string, newText: string): LineReplace | undefined {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === b.length && a.every((l, i) => l === b[i])) return undefined;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { fromLine: p, toLineExclusive: a.length - s, lines: b.slice(p, b.length - s), oldLineCount: a.length };
}

/** Apply a LineReplace to text (used by tests to prove the edit reproduces the new text). */
export function applyLineReplace(oldText: string, r: LineReplace): string {
  const a = splitLines(oldText);
  a.splice(r.fromLine, r.toLineExclusive - r.fromLine, ...r.lines);
  return a.join('\n');
}
