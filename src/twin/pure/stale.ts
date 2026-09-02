/**
 * Sidecar merge logic (REQ-008, REQ-010): decides, for every function in the current function map,
 * whether its twin section can be reused verbatim, must be marked stale, or has to be (re)generated.
 * Pure: no vscode, no fs.
 *
 * Sidecar section semantics:
 *   contentHash = hash of the code the explanation DESCRIBES (not necessarily the current code)
 *   stale       = the function's current hash differed from contentHash when the twin was last written
 * Keeping the explained hash (instead of overwriting it) lets an undo un-stale a section without a model call.
 */
import type { TextDocumentLike } from '../../core/interfaces';
import type { FunctionMap, FunctionRecord, TwinSection } from '../../core/types';
import type { ParsedTwin } from './parse';
import type { RenderSection, SectionContent } from './render';

export interface TwinSidecar {
  sourcePath: string;
  twinPath: string;
  /** sha256 of the normalised source text the twin was last written against. */
  textHash: string;
  sections: TwinSection[];
  generatedAt: string;
}

export type GenerateMode =
  /** Generate new + changed + unexplained functions; reuse the rest (ensureTwin / updateAfterChange). */
  | { kind: 'changed' }
  /** Never call a model: reuse what exists, mark changed sections stale (markStale). */
  | { kind: 'none' }
  /** Regenerate every function (force). */
  | { kind: 'all' }
  /** Regenerate exactly one function, treat the rest like `none`. */
  | { kind: 'only'; functionId: string };

export type PlanReason = 'reuse' | 'new' | 'changed' | 'missing' | 'forced';

export interface PlanEntry {
  fn: FunctionRecord;
  /** 1-based section number in the new twin. */
  index: number;
  previous?: TwinSection;
  /** Explanation text carried over from the existing twin (when any). */
  content?: SectionContent;
  /** True when `content` describes different code than `fn` now holds. */
  stale: boolean;
  generate: boolean;
  reason: PlanReason;
}

export interface TwinPlan {
  entries: PlanEntry[];
  toGenerate: PlanEntry[];
}

/** Content of a sidecar section as found in the parsed twin (matched by number AND name). */
export function contentFor(parsed: ParsedTwin | undefined, section: TwinSection | undefined): SectionContent | undefined {
  if (!parsed || !section) return undefined;
  const hit = parsed.sections.find((p) => p.index === section.index && p.name === section.name);
  return hit?.state === 'explained' ? hit.content : undefined;
}

/**
 * Match every current function to at most one previous section:
 *   1. identical content hash (moved/renumbered code keeps its explanation),
 *   2. same function id, 3. same name.
 */
export function matchPrevious(functions: readonly FunctionRecord[], previous: readonly TwinSection[]): Map<string, TwinSection> {
  const out = new Map<string, TwinSection>();
  const free = new Set(previous);
  const claim = (fn: FunctionRecord, pick: (s: TwinSection) => boolean): void => {
    for (const s of free) {
      if (pick(s)) {
        out.set(fn.id, s);
        free.delete(s);
        return;
      }
    }
  };
  for (const fn of functions) claim(fn, (s) => s.contentHash === fn.contentHash);
  for (const fn of functions) if (!out.has(fn.id)) claim(fn, (s) => s.functionId === fn.id);
  for (const fn of functions) if (!out.has(fn.id)) claim(fn, (s) => s.name === fn.name);
  return out;
}

export function planSections(map: FunctionMap, sidecar: TwinSidecar | undefined, parsed: ParsedTwin | undefined, mode: GenerateMode): TwinPlan {
  const matches = matchPrevious(map.functions, sidecar?.sections ?? []);
  const entries: PlanEntry[] = map.functions.map((fn, i) => {
    const previous = matches.get(fn.id);
    const content = contentFor(parsed, previous);
    const changed = previous !== undefined && previous.contentHash !== fn.contentHash;
    let reason: PlanReason;
    if (!previous) reason = 'new';
    else if (!content) reason = 'missing';
    else if (changed) reason = 'changed';
    else reason = 'reuse';
    let generate: boolean;
    switch (mode.kind) {
      case 'all':
        generate = true;
        reason = 'forced';
        break;
      case 'none':
        generate = false;
        break;
      case 'only':
        generate = fn.id === mode.functionId;
        if (generate) reason = reason === 'reuse' ? 'forced' : reason;
        break;
      case 'changed':
      default:
        generate = reason !== 'reuse';
    }
    return { fn, index: i + 1, previous, content, stale: content !== undefined && changed, generate, reason };
  });
  return { entries, toGenerate: entries.filter((e) => e.generate) };
}

/** Explanations produced for this run, keyed by function id. */
export type ProducedContent = ReadonlyMap<string, SectionContent>;

/**
 * Turn a plan into render sections. `pendingIds` are functions still being explained (provisional twin);
 * a generating entry without a fresh explanation falls back to its old content (kept stale) or a placeholder.
 */
export function toRenderSections(plan: TwinPlan, produced: ProducedContent, pendingIds: ReadonlySet<string> = new Set()): RenderSection[] {
  return plan.entries.map((e) => {
    const fresh = produced.get(e.fn.id);
    if (fresh) return { name: e.fn.name, content: fresh, stale: false };
    if (pendingIds.has(e.fn.id)) return { name: e.fn.name, state: 'pending' };
    if (e.content) return { name: e.fn.name, content: e.content, stale: e.stale };
    return { name: e.fn.name, state: 'unavailable' };
  });
}

/** Sidecar sections for a rendered twin (line ranges come from the renderer). */
export function toSidecarSections(
  plan: TwinPlan,
  produced: ProducedContent,
  ranges: readonly { index: number; startLine: number; endLine: number }[],
): TwinSection[] {
  return plan.entries.map((e, i) => {
    const range = ranges[i];
    const fresh = produced.get(e.fn.id);
    const reused = !fresh && e.content !== undefined && e.previous !== undefined;
    return {
      index: e.index,
      functionId: e.fn.id,
      name: e.fn.name,
      // What the section describes: fresh -> current code; reused -> whatever the old section described;
      // placeholder -> current code (nothing to be out of date about).
      contentHash: fresh ? e.fn.contentHash : reused ? e.previous!.contentHash : e.fn.contentHash,
      startLine: range?.startLine ?? 0,
      endLine: range?.endLine ?? 0,
      stale: !fresh && reused && e.stale,
    };
  });
}

/**
 * A frozen copy of a document: `getText()` always returns the text captured now. One generation run
 * must plan, slice function bodies and hash against ONE version of the source, even when the person
 * keeps typing while the assistant answers (otherwise new text gets sliced with old line ranges and
 * cached under the old hash).
 */
export function snapshotDocument(doc: TextDocumentLike): TextDocumentLike {
  const text = doc.getText();
  return { uri: doc.uri, fsPath: doc.fsPath, languageId: doc.languageId, version: doc.version, getText: () => text };
}

/** Full-line text of one function inside the source (ranges are 0-based inclusive). */
export function functionText(sourceText: string, fn: FunctionRecord): string {
  const lines = sourceText.replace(/\r\n?/g, '\n').split('\n');
  const start = Math.max(0, Math.min(fn.range.startLine, lines.length - 1));
  const end = Math.max(start, Math.min(fn.range.endLine, lines.length - 1));
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Minimal file summary for thrift mode: the lines before the first function (imports, top comment),
 * capped at 20 lines / 1500 characters. Never the whole file.
 */
export function fileSummaryOf(sourceText: string, functions: readonly FunctionRecord[], maxLines = 20, maxChars = 1500): string | undefined {
  const lines = sourceText.replace(/\r\n?/g, '\n').split('\n');
  const firstStart = functions.reduce((m, f) => Math.min(m, f.range.startLine), lines.length);
  const head = lines
    .slice(0, Math.min(firstStart, maxLines))
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  if (!head.length) return undefined;
  const text = head.join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Index (0-based) of the function containing `line`, else the last one starting above it, else undefined. */
export function functionAtLine(functions: readonly FunctionRecord[], line: number): number | undefined {
  for (let i = 0; i < functions.length; i++) {
    const r = functions[i].range;
    if (line >= r.startLine && line <= r.endLine) return i;
  }
  let last: number | undefined;
  for (let i = 0; i < functions.length; i++) if (functions[i].range.startLine <= line) last = i;
  return last;
}
