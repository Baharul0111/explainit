/**
 * Pure helpers shared by every structure source: line splitting, full-line range expansion,
 * function text slicing and the final FunctionMap assembly (ids, ordinals, hashes, ordering).
 * No `vscode` import here so it is unit tested in plain Node.
 */
import { contentHashOf, normalizeNewlines, sha256 } from '../../core/hash';
import type { FunctionKind, FunctionMap, FunctionRecord, LineRange, StructureSource } from '../../core/types';

export interface PositionLike {
  line: number;
  character: number;
}

export interface RangeLike {
  start: PositionLike;
  end: PositionLike;
}

/** A function found by one of the sources, before ids and hashes are assigned. */
export interface RawFunction {
  /** Qualified display name ("Class.method", "outer.inner"). */
  name: string;
  kind: FunctionKind;
  range: LineRange;
}

/** Splits on \r\n, \n and lone \r so line numbers agree with VS Code and with tree-sitter (which parses normalised text). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** The line ending used by the text: \r\n when the first line break is one, else \n. */
export function detectEol(text: string): '\r\n' | '\n' {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Expands a character range (or an already line-based range) to whole lines, 0-based inclusive.
 * A range ending at column 0 of a later line (VS Code style "exclusive end") stops on the previous line.
 * When `lineCount` is given the result is clamped into the document.
 */
export function expandToFullLines(range: RangeLike | LineRange, lineCount?: number): LineRange {
  let startLine: number;
  let endLine: number;
  if (isRangeLike(range)) {
    startLine = range.start.line;
    endLine = range.end.line;
    if (range.end.character === 0 && range.end.line > range.start.line) endLine = range.end.line - 1;
  } else {
    startLine = range.startLine;
    endLine = range.endLine;
  }
  startLine = Math.max(0, Math.floor(startLine));
  endLine = Math.max(startLine, Math.floor(endLine));
  if (lineCount !== undefined && lineCount > 0) {
    startLine = Math.min(startLine, lineCount - 1);
    endLine = Math.min(endLine, lineCount - 1);
  }
  return { startLine, endLine };
}

function isRangeLike(r: RangeLike | LineRange): r is RangeLike {
  return typeof (r as RangeLike).start === 'object' && (r as RangeLike).start !== null;
}

/** The full lines of `range` joined with the text's own line ending (no trailing line break). */
export function sliceLines(text: string, range: LineRange): string {
  const lines = splitLines(text);
  const r = expandToFullLines(range, lines.length);
  return lines.slice(r.startLine, r.endLine + 1).join(detectEol(text));
}

/** The full-line text of one function record. */
export function functionText(text: string, record: Pick<FunctionRecord, 'range'>): string {
  return sliceLines(text, record.range);
}

/** Hash of the whole text after line-ending normalisation (FunctionMap.textHash). */
export function textHashOf(text: string): string {
  return sha256(normalizeNewlines(text));
}

/** Collapses whitespace and strips characters that would make an id awkward; never empty. */
export function cleanName(name: string): string {
  const cleaned = String(name ?? '')
    .replace(/\s+/g, ' ')
    .replace(/#/g, '_')
    .trim();
  return cleaned.length ? cleaned : 'anonymous';
}

export function qualify(container: string | undefined, name: string): string {
  return container && container.length ? `${container}.${name}` : name;
}

/**
 * Assembles the final map: clamps ranges, drops invalid or duplicate entries, orders by position
 * (outer before inner on ties), assigns `${name}#${ordinal}` ids (ordinal is 1-based in file order)
 * and hashes every function's full-line text.
 */
export function buildFunctionMap(
  text: string,
  languageId: string,
  fileUri: string,
  source: StructureSource,
  raws: RawFunction[],
): FunctionMap {
  const lines = splitLines(text);
  const eol = detectEol(text);
  const seen = new Set<string>();
  const cleaned: RawFunction[] = [];
  for (const raw of raws) {
    if (!raw || !raw.range || !Number.isFinite(raw.range.startLine) || !Number.isFinite(raw.range.endLine)) continue;
    if (raw.range.startLine >= lines.length || raw.range.startLine < 0) continue;
    const range = expandToFullLines(raw.range, lines.length);
    const name = cleanName(raw.name);
    const key = `${name} ${range.startLine} ${range.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({ name, kind: raw.kind, range });
  }
  cleaned.sort(
    (a, b) => a.range.startLine - b.range.startLine || b.range.endLine - a.range.endLine || a.name.localeCompare(b.name),
  );

  const ordinals = new Map<string, number>();
  const functions: FunctionRecord[] = cleaned.map((f) => {
    const ordinal = (ordinals.get(f.name) ?? 0) + 1;
    ordinals.set(f.name, ordinal);
    const body = lines.slice(f.range.startLine, f.range.endLine + 1).join(eol);
    return {
      id: `${f.name}#${ordinal}`,
      name: f.name,
      kind: f.kind,
      range: f.range,
      contentHash: contentHashOf(body),
      languageId,
      source,
    };
  });
  return { fileUri, languageId, functions, source, textHash: textHashOf(text) };
}

/** An empty map (blank file, or nothing could outline it). */
export function emptyFunctionMap(text: string, languageId: string, fileUri: string, source: StructureSource = 'none'): FunctionMap {
  return { fileUri, languageId, functions: [], source, textHash: textHashOf(text) };
}

/**
 * Basename of a uri string or a path (POSIX or Windows, on any host), sanitised for use inside a
 * virtual document path. The extension is kept so VS Code can infer the language from it. Never empty.
 */
export function hintBasename(uriHint: string, fallback = 'proposed.txt'): string {
  let candidate = '';
  const hint = typeof uriHint === 'string' ? uriHint.trim() : '';
  // A uri has a scheme (`file://...`, `untitled:Untitled-1`); a single letter before `:` is a Windows drive.
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/.exec(hint);
  if (scheme && (scheme[1].length > 1 || scheme[2].startsWith('//'))) {
    try {
      candidate = new URL(hint).pathname;
    } catch {
      candidate = scheme[2].replace(/^\/\/[^/]*/, '').replace(/[?#].*$/, '');
    }
    candidate = candidate.split('/').pop() ?? '';
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      /* keep the encoded form */
    }
  } else {
    // A plain path: either separator counts, so `C:\repo\a.ts` gives `a.ts` on macOS and Linux too.
    candidate = hint.split(/[\\/]/).pop() ?? '';
  }
  candidate = candidate.replace(/[^\w.+-]/g, '_');
  if (!candidate || /^\.+$/.test(candidate)) return fallback;
  return candidate;
}

/** Whether the text is worth asking an outliner about: at least two non-blank lines and some length. */
export function isNonTrivialText(text: string): boolean {
  if (text.trim().length < 20) return false;
  let nonBlank = 0;
  for (const line of splitLines(text)) {
    if (line.trim().length) nonBlank++;
    if (nonBlank >= 2) return true;
  }
  return false;
}
