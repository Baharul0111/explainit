/**
 * Deterministic style-conformance checker for explanations (REQ-020, goal item 13).
 *
 * Mirrors the explanation contract in docs/dev/CONTRACTS.md: one plain sentence summary that ends
 * with a period and stays within 160 characters; two to five steps of at most 110 characters, each
 * one plain sentence; no backticks or code symbols; none of the banned jargon words. No model is
 * involved, so the same input always gives the same verdict — which is what lets it run in CI
 * against the recorded fixtures in eval/fixtures/explanations.json.
 *
 * Pure: no `vscode`, no I/O. The banned-word list is kept here on purpose (the checker must stay
 * usable even if the generation module is mid-refactor); eval/style.test.ts asserts it matches the
 * list the prompts use, so the two cannot drift apart silently.
 */

export const SUMMARY_MAX_CHARS = 160;
export const STEP_MAX_CHARS = 110;
export const STEPS_MIN = 2;
export const STEPS_MAX = 5;
export const MIN_WORDS = 3;

/** Same words, same order as BANNED_JARGON in src/generation/pure/prompts.ts (checked by a test). */
export const STYLE_BANNED_WORDS: readonly string[] = [
  'instantiate',
  'instantiates',
  'invoke',
  'invokes',
  'iterate',
  'iterates',
  'mutate',
  'mutates',
  'parse',
  'parses',
  'serialize',
  'serializes',
  'deserialize',
  'deserializes',
  'callback',
  'recursion',
  'recursive',
  'asynchronous',
  'asynchronously',
  'polymorphism',
  'boilerplate',
  'closure',
  'coroutine',
  'middleware',
  'singleton',
];

/** Code-looking fragments that have no place in plain English. */
const CODE_SYMBOLS: readonly string[] = ['`', '->', '=>', '==', '!=', '<=', '>=', '&&', '||', '{', '}', '();'];

export interface StyleInput {
  summary: string;
  steps: string[];
  warnings?: string[];
}

export interface StyleResult {
  ok: boolean;
  /** Plain-English problems, empty when ok. */
  problems: string[];
}

export interface StyleOptions {
  bannedWords?: readonly string[];
}

/** Count sentences: pieces separated by ". ", "! " or "? " (or a terminator at the very end). */
export function countSentences(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  // Decimal numbers like 2.5 and dotted names like a.b are not sentence breaks.
  const pieces = t.split(/[.!?]+(?=\s|$)/).map((p) => p.trim()).filter(Boolean);
  return pieces.length;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Banned words found in the text (whole words, case-insensitive), in the order of the list. */
export function findBannedWords(text: string, banned: readonly string[] = STYLE_BANNED_WORDS): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const w of banned) {
    const re = new RegExp(`(^|[^a-z0-9_])${escapeRe(w.toLowerCase())}(?=$|[^a-z0-9_])`);
    if (re.test(lower)) found.push(w);
  }
  return found;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkSentence(label: string, text: unknown, maxChars: number, problems: string[]): string | undefined {
  if (typeof text !== 'string') {
    problems.push(`${label} is missing.`);
    return undefined;
  }
  const t = text.trim();
  if (!t) {
    problems.push(`${label} is empty.`);
    return undefined;
  }
  if (t.length > maxChars) problems.push(`${label} is ${t.length} characters long; the limit is ${maxChars}.`);
  if (!t.endsWith('.')) problems.push(`${label} does not end with a period.`);
  const sentences = countSentences(t);
  if (sentences > 1) problems.push(`${label} has ${sentences} sentences; it must be exactly one.`);
  if (wordCount(t) < MIN_WORDS) problems.push(`${label} is too short to be a sentence.`);
  if (/[\r\n]/.test(t)) problems.push(`${label} spans more than one line.`);
  const symbols = CODE_SYMBOLS.filter((s) => t.includes(s));
  if (symbols.length) problems.push(`${label} contains code symbols (${symbols.join(' ')}).`);
  return t;
}

/**
 * Check one explanation against the style rules. Never throws: malformed input is reported as
 * problems so a bad model reply counts as a style failure rather than a crash.
 */
export function checkStyle(input: StyleInput | null | undefined, opts: StyleOptions = {}): StyleResult {
  const problems: string[] = [];
  const banned = opts.bannedWords ?? STYLE_BANNED_WORDS;
  if (!input || typeof input !== 'object') return { ok: false, problems: ['The explanation is missing.'] };

  const texts: string[] = [];
  const summary = checkSentence('The summary', input.summary, SUMMARY_MAX_CHARS, problems);
  if (summary) texts.push(summary);

  if (!Array.isArray(input.steps)) {
    problems.push('The steps are missing.');
  } else {
    if (input.steps.length < STEPS_MIN || input.steps.length > STEPS_MAX) {
      problems.push(`There are ${input.steps.length} steps; there must be ${STEPS_MIN} to ${STEPS_MAX}.`);
    }
    input.steps.forEach((s, i) => {
      const t = checkSentence(`Step ${i + 1}`, s, STEP_MAX_CHARS, problems);
      if (t) texts.push(t);
    });
  }

  const jargon = findBannedWords(texts.join(' '), banned);
  if (jargon.length) problems.push(`Uses banned jargon: ${jargon.join(', ')}.`);

  return { ok: problems.length === 0, problems };
}

/** Fraction (0..1) of explanations that pass the style check; 0 for an empty list. */
export function styleScore(inputs: (StyleInput | null | undefined)[], opts: StyleOptions = {}): number {
  if (!inputs.length) return 0;
  const ok = inputs.filter((e) => checkStyle(e, opts).ok).length;
  return ok / inputs.length;
}
