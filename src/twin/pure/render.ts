/**
 * Renders the twin file in the EXACT format from docs/dev/CONTRACTS.md "Twin file contract".
 * Pure: no vscode. Tests compare whole strings, so every character here is part of the contract.
 */
import * as path from 'node:path';

export const HEADER_PREFIX = 'ExplainIT — plain-English twin of ';
export const HEADER_LINE2 = 'Written by ExplainIT. Not committed to git. Right-click a section for "Regenerate this section".';
export const STALE_LINE = '(Out of date — the code changed. Right-click here and choose "ExplainIT: Regenerate this section".)';
export const NO_FUNCTIONS_LINE = 'This file has no functions to explain.';
export const WHAT_PREFIX = 'What it does: ';
export const HOW_LINE = 'How it works:';
export const STEP_PREFIX = '- ';
export const WATCH_PREFIX = 'Watch out: ';
export const UNAVAILABLE_TEXT = '(not explained yet — connect an assistant and run "ExplainIT: Regenerate this section")';
export const PENDING_TEXT = '(explaining...)';
export const UNAVAILABLE_LINE = WHAT_PREFIX + UNAVAILABLE_TEXT;
export const PENDING_LINE = WHAT_PREFIX + PENDING_TEXT;

/** The explanation text of one section (what the model produced, or what was parsed back from disk). */
export interface SectionContent {
  summary: string;
  steps: string[];
  warnings?: string[];
}

export type SectionState = 'explained' | 'pending' | 'unavailable';

export interface RenderSection {
  name: string;
  /** Inserts the stale line directly under the `N. name` line. */
  stale?: boolean;
  /** When present the section is rendered as explained; otherwise `state` decides the placeholder. */
  content?: SectionContent;
  /** Placeholder when there is no content: `pending` = "(explaining...)", default `unavailable`. */
  state?: SectionState;
}

export interface RenderedSectionRange {
  index: number;
  name: string;
  startLine: number;
  endLine: number;
}

export interface RenderedTwin {
  text: string;
  sections: RenderedSectionRange[];
}

/** Collapse a model/user string to one clean line. */
export function oneLine(s: string): string {
  return s.replace(/\s*\r?\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

export function headerLines(sourceName: string): string[] {
  return [HEADER_PREFIX + path.basename(sourceName), HEADER_LINE2];
}

/** Lines of one section without the surrounding blank lines. */
export function renderSectionLines(index: number, section: RenderSection): string[] {
  const lines: string[] = [`${index}. ${oneLine(section.name)}`];
  if (section.stale) lines.push(STALE_LINE);
  const c = section.content;
  if (c && oneLine(c.summary)) {
    lines.push(WHAT_PREFIX + oneLine(c.summary));
    const steps = c.steps.map(oneLine).filter((s) => s.length > 0);
    if (steps.length) {
      lines.push(HOW_LINE);
      for (const s of steps) lines.push(STEP_PREFIX + s);
    }
    const warnings = (c.warnings ?? []).map(oneLine).filter((w) => w.length > 0);
    for (const w of warnings) lines.push(WATCH_PREFIX + w);
  } else if (section.state === 'pending') {
    lines.push(PENDING_LINE);
  } else {
    lines.push(UNAVAILABLE_LINE);
  }
  return lines;
}

/**
 * Render the whole twin. Header (2 lines), blank line, sections separated by one blank line,
 * final newline. Files without functions get the single "no functions" line instead.
 */
export function renderTwin(sourceName: string, sections: readonly RenderSection[]): RenderedTwin {
  const out: string[] = [...headerLines(sourceName), ''];
  const ranges: RenderedSectionRange[] = [];
  if (sections.length === 0) {
    out.push(NO_FUNCTIONS_LINE);
    return { text: out.join('\n') + '\n', sections: [] };
  }
  sections.forEach((section, i) => {
    if (i > 0) out.push('');
    const index = i + 1;
    const startLine = out.length;
    const lines = renderSectionLines(index, section);
    out.push(...lines);
    ranges.push({ index, name: oneLine(section.name), startLine, endLine: out.length - 1 });
  });
  return { text: out.join('\n') + '\n', sections: ranges };
}
