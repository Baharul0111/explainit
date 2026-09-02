/**
 * JSON schema + sentence-shape validation for model replies (REQ-005, REQ-009).
 * ajv checks structure; `checkSentenceShape` enforces the parts a schema cannot express well
 * (word counts, trailing period, suspicious one-word replies such as "PWNED" or "approved").
 */
import Ajv, { type ValidateFunction } from 'ajv';
import { STEPS_MAX, STEPS_MIN, STEP_MAX_CHARS, SUMMARY_MAX_CHARS } from './prompts';

export const MIN_WORDS_SUMMARY = 3;
export const MIN_WORDS_STEP = 3;

/**
 * Replies that are exactly one of these (ignoring case and punctuation) are the classic signature of
 * a prompt-injection "success" or a model that answered a question instead of describing code.
 */
export const SUSPICIOUS_TOKENS: readonly string[] = [
  'pwned',
  'approved',
  'approve',
  'ok',
  'okay',
  'yes',
  'no',
  'done',
  'hacked',
  'success',
  'ignored',
  'confirmed',
  'accepted',
  'true',
  'false',
  'null',
  'undefined',
];

export interface ExplanationItemShape {
  functionId: string;
  name: string;
  summary: string;
  steps: string[];
  warnings?: string[];
  uncertainty?: string;
}

export interface ExplanationsReplyShape {
  explanations: ExplanationItemShape[];
}

export interface ChangeReplyShape {
  whatChanged: string;
  whyItMatters: string[];
  risk?: string;
}

export interface SegmentsReplyShape {
  segments: { name: string; startLine: number; endLine: number }[];
}

const ajv = new Ajv({ allErrors: true, strict: false });

export const explanationItemSchema = {
  type: 'object',
  required: ['summary', 'steps'],
  properties: {
    functionId: { type: 'string', maxLength: 300 },
    name: { type: 'string', maxLength: 300 },
    summary: { type: 'string', minLength: 1, maxLength: SUMMARY_MAX_CHARS },
    steps: {
      type: 'array',
      minItems: STEPS_MIN,
      maxItems: STEPS_MAX,
      items: { type: 'string', minLength: 1, maxLength: STEP_MAX_CHARS },
    },
    warnings: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 300 } },
    uncertainty: { type: 'string', maxLength: 300 },
  },
} as const;

export const explanationsReplySchema = {
  type: 'object',
  required: ['explanations'],
  properties: {
    explanations: { type: 'array', maxItems: 40, items: explanationItemSchema },
  },
} as const;

export const changeReplySchema = {
  type: 'object',
  required: ['whatChanged', 'whyItMatters'],
  properties: {
    whatChanged: { type: 'string', minLength: 1, maxLength: 400 },
    whyItMatters: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 300 } },
    risk: { type: 'string', maxLength: 300 },
  },
} as const;

export const segmentsReplySchema = {
  type: 'object',
  required: ['segments'],
  properties: {
    segments: {
      type: 'array',
      maxItems: 2000,
      items: {
        type: 'object',
        required: ['name', 'startLine', 'endLine'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 300 },
          startLine: { type: 'integer', minimum: 0 },
          endLine: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
} as const;

const validateItemFn: ValidateFunction = ajv.compile(explanationItemSchema);
const validateReplyFn: ValidateFunction = ajv.compile(explanationsReplySchema);
const validateChangeFn: ValidateFunction = ajv.compile(changeReplySchema);
const validateSegmentsFn: ValidateFunction = ajv.compile(segmentsReplySchema);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function ajvErrors(fn: ValidateFunction): string[] {
  return (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

/** Structure only (ajv). */
export function validateExplanationsReply(value: unknown): ValidationResult {
  const ok = validateReplyFn(value) as boolean;
  return { ok, errors: ok ? [] : ajvErrors(validateReplyFn) };
}

export function validateChangeReply(value: unknown): ValidationResult {
  const ok = validateChangeFn(value) as boolean;
  return { ok, errors: ok ? [] : ajvErrors(validateChangeFn) };
}

export function validateSegmentsReply(value: unknown): ValidationResult {
  const ok = validateSegmentsFn(value) as boolean;
  return { ok, errors: ok ? [] : ajvErrors(validateSegmentsFn) };
}

export function wordCount(s: string): number {
  return s
    .trim()
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True for one-word replies and for known injection / yes-no tokens. */
export function isSuspiciousSentence(s: string): boolean {
  const norm = normalizeToken(s);
  if (!norm) return true;
  if (SUSPICIOUS_TOKENS.includes(norm)) return true;
  // "PWNED PWNED PWNED" or "ok ok ok" is still an injection echo, not a description.
  const words = norm.split(' ');
  if (words.length <= 4 && words.every((w) => SUSPICIOUS_TOKENS.includes(w))) return true;
  return false;
}

/** Sentence-shape checks the schema cannot express. Returns plain-English problems. */
export function checkSentenceShape(item: { summary: string; steps: string[] }): string[] {
  const problems: string[] = [];
  const summary = (item.summary ?? '').trim();
  if (wordCount(summary) < MIN_WORDS_SUMMARY) problems.push('summary has fewer than three words');
  if (!/[.!?]["')\]]?$/.test(summary)) problems.push('summary does not end with a period');
  if (summary.length > SUMMARY_MAX_CHARS) problems.push(`summary is longer than ${SUMMARY_MAX_CHARS} characters`);
  if (isSuspiciousSentence(summary)) problems.push('summary is a suspicious token, not a description');
  const steps = Array.isArray(item.steps) ? item.steps : [];
  if (steps.length < STEPS_MIN || steps.length > STEPS_MAX) problems.push(`needs ${STEPS_MIN} to ${STEPS_MAX} steps, got ${steps.length}`);
  steps.forEach((raw, i) => {
    const s = String(raw ?? '').trim();
    if (wordCount(s) < MIN_WORDS_STEP) problems.push(`step ${i + 1} has fewer than three words`);
    if (s.length > STEP_MAX_CHARS) problems.push(`step ${i + 1} is longer than ${STEP_MAX_CHARS} characters`);
    if (isSuspiciousSentence(s)) problems.push(`step ${i + 1} is a suspicious token, not a description`);
  });
  return problems;
}

/** Full validation of one explanation item: ajv structure + sentence shape. */
export function validateExplanationItem(value: unknown): ValidationResult {
  const ok = validateItemFn(value) as boolean;
  if (!ok) return { ok: false, errors: ajvErrors(validateItemFn) };
  const problems = checkSentenceShape(value as ExplanationItemShape);
  return { ok: problems.length === 0, errors: problems };
}

/** Sentence-shape check for the change explanation (plain English, not a token). */
export function checkChangeShape(value: ChangeReplyShape): string[] {
  const problems: string[] = [];
  if (wordCount(value.whatChanged) < MIN_WORDS_SUMMARY) problems.push('whatChanged has fewer than three words');
  if (isSuspiciousSentence(value.whatChanged)) problems.push('whatChanged is a suspicious token');
  value.whyItMatters.forEach((s, i) => {
    if (wordCount(s) < MIN_WORDS_STEP) problems.push(`whyItMatters ${i + 1} has fewer than three words`);
    if (isSuspiciousSentence(s)) problems.push(`whyItMatters ${i + 1} is a suspicious token`);
  });
  return problems;
}
