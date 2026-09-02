/**
 * Turns raw model text into validated explanations (REQ-005, REQ-009).
 *
 *  1. `extractJson`  — finds a JSON object in the reply (whole text, ```json fences, or the first
 *     balanced {...} after leading prose).
 *  2. `parsePlainTextExplanations` — degradation parser for the twin's own shape
 *     ("N. name / What it does: / How it works: / - step").
 *  3. `matchItemsToFunctions` — maps parsed items back to the request by label (F1..Fn), by the real
 *     functionId, by name, then by position.
 *  4. Every item is validated; invalid ones are reported so the router can re-ask once and then use
 *     `fallbackExplanation` (so the twin still renders and tells the person what to do).
 */
import type { Explanation, Channel } from '../../core/types';
import type { AiSegment, ExplainFunctionInput } from '../../core/interfaces';
import {
  checkChangeShape,
  validateChangeReply,
  validateExplanationItem,
  validateSegmentsReply,
  type ChangeReplyShape,
  type ExplanationItemShape,
} from './schema';
import { functionLabel } from './prompts';

export const FALLBACK_SUMMARY = 'This function could not be explained clearly; run Regenerate to try again.';
export const FALLBACK_STEPS: readonly string[] = [
  'The assistant did not send a usable answer for this function.',
  'Right-click this section and choose Regenerate this section to ask again.',
  'If it keeps failing, run the ExplainIT Doctor to check the assistant is signed in.',
];

// ---------------------------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------------------------

/** Find the first balanced JSON object or array starting at `from`. Returns the slice or undefined. */
function balancedSlice(text: string, from: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return undefined;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Extract the first JSON value (object or array) from free text. Handles: pure JSON, markdown code
 * fences, leading/trailing prose, and a JSON string that itself contains JSON (some CLIs double-wrap).
 */
export function extractJson(raw: string): unknown | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  const direct = tryParse(text);
  if (direct !== undefined) {
    if (typeof direct === 'string') return extractJson(direct) ?? direct;
    return direct;
  }
  // ```json ... ``` (or ``` ... ```)
  const fenceRe = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) {
    const inner = m[1].trim();
    const v = tryParse(inner);
    if (v !== undefined) return v;
    const nested = scanBalanced(inner);
    if (nested !== undefined) return nested;
  }
  return scanBalanced(text);
}

function scanBalanced(text: string): unknown | undefined {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const slice = balancedSlice(text, i);
    if (slice) {
      const v = tryParse(slice);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Plain-text degradation parser
// ---------------------------------------------------------------------------------------------

export interface ParsedItem {
  functionId?: string;
  name?: string;
  summary: string;
  steps: string[];
  warnings?: string[];
  uncertainty?: string;
}

const HEADER_RE = /^\s*(?:#+\s*)?(?:\*\*)?(\d+)[.)]\s+(.+?)(?:\*\*)?\s*$/;
const WHAT_RE = /^\s*(?:\*\*)?what it does(?:\*\*)?\s*:\s*(.*)$/i;
const HOW_RE = /^\s*(?:\*\*)?how it works(?:\*\*)?\s*:\s*(.*)$/i;
const WATCH_RE = /^\s*(?:\*\*)?watch out(?:\*\*)?\s*:\s*(.*)$/i;
const UNSURE_RE = /^\s*(?:\*\*)?(?:uncertainty|not sure|unsure)(?:\*\*)?\s*:\s*(.*)$/i;
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;

/** Strip markdown emphasis / code ticks that models sprinkle on labels and sentences. */
function clean(s: string): string {
  return s.replace(/[`*]/g, '').trim();
}

/** Parse the twin-shaped plain text: "N. name / What it does: ... / How it works: / - step". */
export function parsePlainTextExplanations(raw: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  let cur: ParsedItem | undefined;
  let mode: 'none' | 'steps' | 'warnings' = 'none';
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const h = HEADER_RE.exec(line);
    if (h && !WHAT_RE.test(line)) {
      cur = { name: clean(h[2]), summary: '', steps: [] };
      // "1. name" inside a steps list of a previous item would be rare; headers reset state.
      items.push(cur);
      mode = 'none';
      continue;
    }
    if (!cur) continue;
    const w = WHAT_RE.exec(line);
    if (w) {
      cur.summary = clean(w[1]);
      mode = 'none';
      continue;
    }
    const hw = HOW_RE.exec(line);
    if (hw) {
      mode = 'steps';
      if (clean(hw[1])) cur.steps.push(clean(hw[1]));
      continue;
    }
    const wo = WATCH_RE.exec(line);
    if (wo) {
      mode = 'warnings';
      cur.warnings = cur.warnings ?? [];
      if (clean(wo[1])) cur.warnings.push(clean(wo[1]));
      continue;
    }
    const un = UNSURE_RE.exec(line);
    if (un) {
      cur.uncertainty = clean(un[1]);
      mode = 'none';
      continue;
    }
    const b = BULLET_RE.exec(line);
    if (b && mode === 'steps') {
      cur.steps.push(clean(b[1]));
      continue;
    }
    if (b && mode === 'warnings') {
      (cur.warnings = cur.warnings ?? []).push(clean(b[1]));
      continue;
    }
    // A bare sentence right after the header is treated as the summary when none was given.
    if (!cur.summary && clean(line) && mode === 'none') cur.summary = clean(line);
  }
  return items.filter((i) => i.summary || i.steps.length);
}

// ---------------------------------------------------------------------------------------------
// Reply -> items
// ---------------------------------------------------------------------------------------------

export interface ParsedReply {
  items: ParsedItem[];
  source: 'json' | 'text' | 'none';
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
}

function itemFromJson(v: unknown): ParsedItem | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const summary = asString(o.summary) ?? asString(o.whatItDoes) ?? asString(o.what_it_does) ?? '';
  const steps = asStringArray(o.steps) ?? asStringArray(o.howItWorks) ?? asStringArray(o.how_it_works) ?? [];
  const item: ParsedItem = { summary: summary.trim(), steps };
  const fid = asString(o.functionId) ?? asString(o.id);
  if (fid) item.functionId = fid;
  const name = asString(o.name);
  if (name) item.name = name;
  const warnings = asStringArray(o.warnings);
  if (warnings && warnings.length) item.warnings = warnings;
  const unc = asString(o.uncertainty);
  if (unc && unc.trim()) item.uncertainty = unc.trim();
  return item;
}

/** JSON first, then plain-text degradation. */
export function parseExplanationsReply(raw: string): ParsedReply {
  const json = extractJson(raw);
  if (json && typeof json === 'object') {
    const arr = Array.isArray(json) ? json : (json as Record<string, unknown>).explanations;
    if (Array.isArray(arr)) {
      const items = arr.map(itemFromJson).filter((i): i is ParsedItem => !!i);
      if (items.length) return { items, source: 'json' };
    } else {
      const single = itemFromJson(json);
      if (single && (single.summary || single.steps.length)) return { items: [single], source: 'json' };
    }
  }
  const text = parsePlainTextExplanations(raw);
  if (text.length) return { items: text, source: 'text' };
  return { items: [], source: 'none' };
}

export interface MatchedItem {
  fn: ExplainFunctionInput;
  item: ParsedItem | undefined;
  errors: string[];
}

function normName(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Map parsed items back to the request. Order of preference: label (F1..Fn) -> exact functionId ->
 * name (case/punctuation-insensitive; qualified names match on their last segment) -> position.
 * Each item is used at most once. Items that match nothing are dropped.
 */
export function matchItemsToFunctions(items: ParsedItem[], functions: ExplainFunctionInput[]): MatchedItem[] {
  const used = new Set<number>();
  const result: (ParsedItem | undefined)[] = new Array(functions.length).fill(undefined);
  const labelIndex = new Map<string, number>();
  functions.forEach((fn, i) => {
    labelIndex.set(functionLabel(i).toLowerCase(), i);
    labelIndex.set(fn.functionId.toLowerCase(), i);
  });
  // pass 1: labels / ids
  items.forEach((item, j) => {
    const key = (item.functionId ?? '').trim().toLowerCase();
    if (!key) return;
    const idx = labelIndex.get(key);
    if (idx !== undefined && result[idx] === undefined) {
      result[idx] = item;
      used.add(j);
    }
  });
  // pass 2: names
  items.forEach((item, j) => {
    if (used.has(j) || !item.name) return;
    const n = normName(item.name);
    const nLast = normName(item.name.split('.').pop());
    let idx = functions.findIndex((fn, i) => result[i] === undefined && normName(fn.name) === n);
    if (idx < 0) idx = functions.findIndex((fn, i) => result[i] === undefined && normName(fn.name.split('.').pop()) === nLast);
    if (idx >= 0) {
      result[idx] = item;
      used.add(j);
    }
  });
  // pass 3: position (only when the reply is unlabeled and the counts line up)
  const unlabeled = items.filter((it, j) => !used.has(j) && !it.functionId && !it.name);
  if (unlabeled.length && unlabeled.length === result.filter((r) => r === undefined).length) {
    let k = 0;
    for (let i = 0; i < result.length; i++) if (result[i] === undefined) result[i] = unlabeled[k++];
  }
  return functions.map((fn, i) => {
    const item = result[i];
    if (!item) return { fn, item: undefined, errors: ['no explanation in the reply'] };
    const v = validateExplanationItem({ functionId: fn.functionId, name: fn.name, summary: item.summary, steps: item.steps, warnings: item.warnings, uncertainty: item.uncertainty });
    return { fn, item, errors: v.errors };
  });
}

export function toExplanation(fn: ExplainFunctionInput, item: ParsedItem, channel: Channel, now = new Date()): Explanation {
  const exp: Explanation = {
    functionId: fn.functionId,
    name: fn.name,
    summary: item.summary.trim(),
    steps: item.steps.map((s) => s.trim()),
    modelChannel: channel,
    createdAt: now.toISOString(),
    contentHash: fn.contentHash,
  };
  if (item.warnings && item.warnings.length) exp.warnings = item.warnings;
  if (item.uncertainty) exp.uncertainty = item.uncertainty;
  return exp;
}

/** Rendered when the assistant failed twice: the twin still shows the section and says what to do. */
export function fallbackExplanation(fn: ExplainFunctionInput, channel: Channel | 'none', now = new Date()): Explanation {
  return {
    functionId: fn.functionId,
    name: fn.name,
    summary: FALLBACK_SUMMARY,
    steps: [...FALLBACK_STEPS],
    uncertainty: 'This section was not written by an assistant.',
    modelChannel: channel,
    createdAt: now.toISOString(),
    contentHash: fn.contentHash,
  };
}

export function isFallbackExplanation(e: Explanation): boolean {
  return e.summary === FALLBACK_SUMMARY;
}

// ---------------------------------------------------------------------------------------------
// Change explanation + segmentation replies
// ---------------------------------------------------------------------------------------------

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** JSON first; otherwise the first sentence is "what changed" and the next ones "why it matters". */
export function parseChangeReply(raw: string): { value?: ChangeReplyShape; errors: string[] } {
  const json = extractJson(raw);
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    const candidate: ChangeReplyShape = {
      whatChanged: (asString(o.whatChanged) ?? asString(o.what_changed) ?? '').trim(),
      whyItMatters: asStringArray(o.whyItMatters) ?? asStringArray(o.why_it_matters) ?? (asString(o.whyItMatters) ? [asString(o.whyItMatters) as string] : []),
    };
    const risk = asString(o.risk);
    if (risk && risk.trim()) candidate.risk = risk.trim();
    const v = validateChangeReply(candidate);
    const shape = v.ok ? checkChangeShape(candidate) : [];
    if (v.ok && shape.length === 0) return { value: candidate, errors: [] };
    return { errors: [...v.errors, ...shape] };
  }
  const sentences = splitSentences(String(raw ?? '').replace(/```[\s\S]*?```/g, ' '));
  if (sentences.length === 0) return { errors: ['empty reply'] };
  const candidate: ChangeReplyShape = {
    whatChanged: sentences[0],
    whyItMatters: sentences.slice(1, 4).length ? sentences.slice(1, 4) : ['The rest of the file works the same as before.'],
  };
  const v = validateChangeReply(candidate);
  const shape = v.ok ? checkChangeShape(candidate) : [];
  if (v.ok && shape.length === 0) return { value: candidate, errors: [] };
  return { errors: [...v.errors, ...shape] };
}

/**
 * Segmentation reply -> AiSegment[] (0-based inclusive lines, like LineRange). The prompt asks for
 * 1-based numbers because models count that way; conversion happens here. Segments outside the file,
 * inverted or overlapping ones are dropped; the rest are sorted by start line.
 */
export function parseSegmentsReply(raw: string, lineCount: number): { segments: AiSegment[]; errors: string[] } {
  const json = extractJson(raw);
  const value = Array.isArray(json) ? { segments: json } : json;
  const v = validateSegmentsReply(value);
  if (!v.ok) return { segments: [], errors: v.errors };
  const segs = (value as { segments: { name: string; startLine: number; endLine: number }[] }).segments
    .map((s) => ({ name: s.name.trim().slice(0, 200), startLine: s.startLine - 1, endLine: s.endLine - 1 }))
    .filter((s) => s.name && s.startLine >= 0 && s.endLine >= s.startLine && s.endLine < lineCount)
    .sort((a, b) => a.startLine - b.startLine);
  const out: AiSegment[] = [];
  let lastEnd = -1;
  for (const s of segs) {
    if (s.startLine <= lastEnd) continue; // overlap: keep the earlier one
    out.push(s);
    lastEnd = s.endLine;
  }
  return { segments: out, errors: [] };
}

export type { ExplanationItemShape };
