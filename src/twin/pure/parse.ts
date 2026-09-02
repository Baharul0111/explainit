/**
 * Parses a twin file back into sections by its `N. name` headers (inverse of render.ts).
 * Tolerant of CRLF and of light hand edits; whatever it cannot classify is kept as `extra` lines.
 */
import {
  HEADER_PREFIX,
  HOW_LINE,
  NO_FUNCTIONS_LINE,
  PENDING_TEXT,
  STALE_LINE,
  STEP_PREFIX,
  UNAVAILABLE_TEXT,
  WATCH_PREFIX,
  WHAT_PREFIX,
  type SectionContent,
  type SectionState,
} from './render';

export interface ParsedSection {
  /** The number in front of the name (as written in the file). */
  index: number;
  name: string;
  /** 0-based inclusive line range inside the twin text (header line .. last non-blank line). */
  startLine: number;
  endLine: number;
  stale: boolean;
  state: SectionState;
  /** Present only when the section holds a real explanation. */
  content?: SectionContent;
}

export interface ParsedTwin {
  /** Source file name from the header, when the header is intact. */
  sourceName?: string;
  sections: ParsedSection[];
  /** True when the file carries the "no functions" line. */
  noFunctions: boolean;
}

const HEADER_RE = /^(\d+)\. (.*\S)\s*$/;

export function parseTwin(text: string): ParsedTwin {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sourceName = lines[0]?.startsWith(HEADER_PREFIX) ? lines[0].slice(HEADER_PREFIX.length).trim() || undefined : undefined;
  const noFunctions = lines.some((l) => l.trim() === NO_FUNCTIONS_LINE);

  const starts: { line: number; index: number; name: string }[] = [];
  lines.forEach((l, i) => {
    if (i < 2) return; // header lines never start a section
    const m = HEADER_RE.exec(l);
    if (m) starts.push({ line: i, index: Number(m[1]), name: m[2] });
  });

  const sections: ParsedSection[] = starts.map((s, k) => {
    const limit = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    let endLine = limit - 1;
    while (endLine > s.line && lines[endLine].trim() === '') endLine--;
    const body = lines.slice(s.line + 1, endLine + 1);
    let stale = false;
    let summary: string | undefined;
    let state: SectionState = 'unavailable';
    const steps: string[] = [];
    const warnings: string[] = [];
    for (const raw of body) {
      const line = raw.trimEnd();
      if (line === STALE_LINE) stale = true;
      else if (line.startsWith(WHAT_PREFIX)) {
        const rest = line.slice(WHAT_PREFIX.length).trim();
        if (rest === PENDING_TEXT) state = 'pending';
        else if (rest === UNAVAILABLE_TEXT) state = 'unavailable';
        else if (rest) {
          summary = rest;
          state = 'explained';
        }
      } else if (line === HOW_LINE) {
        /* structural */
      } else if (line.startsWith(STEP_PREFIX)) steps.push(line.slice(STEP_PREFIX.length).trim());
      else if (line.startsWith(WATCH_PREFIX)) warnings.push(line.slice(WATCH_PREFIX.length).trim());
    }
    const section: ParsedSection = { index: s.index, name: s.name, startLine: s.line, endLine, stale, state };
    if (state === 'explained' && summary) {
      section.content = { summary, steps, ...(warnings.length ? { warnings } : {}) };
    }
    return section;
  });

  return { sourceName, sections, noFunctions };
}

/**
 * True when every section holds a real explanation (a "no functions" twin counts as complete).
 * The fast path must not reuse a twin that still shows "(explaining...)" or "(not explained yet ...)":
 * those placeholders are left behind by a failed assistant call, a paused backfill or a crash, and the
 * next open should try again instead of showing them forever.
 */
export function isFullyExplained(parsed: ParsedTwin): boolean {
  if (parsed.sections.length === 0) return parsed.noFunctions;
  return parsed.sections.every((s) => s.state === 'explained');
}

/** Which section (1-based index in file order) contains a given twin line, else undefined. */
export function sectionAtLine(sections: readonly { startLine: number; endLine: number }[], line: number): number | undefined {
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (line >= s.startLine && line <= s.endLine) return i;
  }
  // Blank separator lines belong to the section above them.
  let last: number | undefined;
  for (let i = 0; i < sections.length; i++) if (sections[i].startLine <= line) last = i;
  return last;
}
