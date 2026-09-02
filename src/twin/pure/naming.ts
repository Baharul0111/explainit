/**
 * Twin file naming (REQ-003). Pure: no vscode, no fs.
 *
 * Rule (docs/dev/CONTRACTS.md "Twin file contract"):
 *   `<stem>_explain.txt` beside the source (`app.py` -> `app_explain.txt`).
 *   If any sibling file in the same folder shares the stem (`index.ts` + `index.css`) those files use the
 *   full form `<filename>_explain.txt` (`index.ts_explain.txt`) so the twins never collide.
 */
import * as path from 'node:path';

export const TWIN_SUFFIX = '_explain.txt';

/** Stem = file name without its last extension. Dotfiles (`.env`) keep their whole name as the stem. */
export function stemOf(fileName: string): string {
  const base = path.basename(fileName);
  const parsed = path.parse(base);
  return parsed.name === '' ? base : parsed.name;
}

/** True when the basename ends with `_explain.txt`. */
export function isTwinPath(p: string): boolean {
  const base = path.basename(p);
  return base.length > TWIN_SUFFIX.length && base.endsWith(TWIN_SUFFIX);
}

/**
 * Twin file NAME (not path) for a source file, given the names of every sibling in the same folder.
 * The source itself, twin files and hidden helper entries are ignored when looking for stem collisions.
 */
export function twinNameFor(sourceName: string, siblingNames: readonly string[]): string {
  const base = path.basename(sourceName);
  const stem = stemOf(base);
  const collides = siblingNames.some((s) => {
    const sb = path.basename(s);
    if (sb === base) return false;
    if (isTwinPath(sb)) return false;
    return stemOf(sb) === stem;
  });
  return (collides ? base : stem) + TWIN_SUFFIX;
}

/** Full twin path for an absolute source path. */
export function twinPathFrom(sourcePath: string, siblingNames: readonly string[]): string {
  return path.join(path.dirname(sourcePath), twinNameFor(sourcePath, siblingNames));
}

/**
 * Inverse lookup: which sibling would produce this twin name? Deterministic because it re-runs the
 * forward rule for every candidate. Returns the sibling NAME or undefined.
 */
export function sourceNameForTwin(twinName: string, siblingNames: readonly string[]): string | undefined {
  const base = path.basename(twinName);
  if (!isTwinPath(base)) return undefined;
  const candidates = siblingNames.map((s) => path.basename(s)).filter((s) => !isTwinPath(s));
  // Prefer the full-form match (exact filename) so `index.ts_explain.txt` resolves to `index.ts`
  // even though `index.ts` could in theory be a stem of `index.ts.bak`.
  const full = base.slice(0, -TWIN_SUFFIX.length);
  const exact = candidates.find((c) => c === full && twinNameFor(c, candidates) === base);
  if (exact) return exact;
  return candidates.find((c) => twinNameFor(c, candidates) === base);
}
