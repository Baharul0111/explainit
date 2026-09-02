import { createHash, randomBytes } from 'node:crypto';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function shortHash(text: string | Buffer, len = 12): string {
  return sha256(text).slice(0, len);
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Hash of a function body used for cache keys and staleness: normalised newlines, trailing whitespace trimmed per line. */
export function contentHashOf(text: string): string {
  const norm = normalizeNewlines(text)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n');
  return sha256(norm);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function randomId(prefix = ''): string {
  return prefix + randomBytes(8).toString('hex');
}

/** Deterministic JSON (sorted keys) for hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}
