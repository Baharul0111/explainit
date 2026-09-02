/**
 * Pure parts of backfill (REQ-011): the persisted progress record, chunking, and status projection.
 * The record lives at HOME_LAYOUT.backfill(folder) so a paused run survives a VS Code restart.
 */
import type { CostEstimate } from '../../core/types';
import type { BackfillStatus } from '../../core/interfaces';

export interface BackfillFileEntry {
  /** Absolute source path. */
  path: string;
  /** Functions that will be sent for this file (after cache/sidecar planning). */
  functions: number;
}

export interface BackfillRecord {
  version: 1;
  folder: string;
  files: BackfillFileEntry[];
  /** Absolute paths already completed, in completion order. */
  done: string[];
  estimate?: CostEstimate;
  startedAt: string;
  updatedAt: string;
}

export function createBackfillRecord(folder: string, files: BackfillFileEntry[], estimate?: CostEstimate, now = new Date()): BackfillRecord {
  const ts = now.toISOString();
  return { version: 1, folder, files: files.map((f) => ({ ...f })), done: [], estimate, startedAt: ts, updatedAt: ts };
}

/** Returns a new record with `file` marked done (idempotent). */
export function markFileDone(record: BackfillRecord, file: string, now = new Date()): BackfillRecord {
  if (record.done.includes(file)) return record;
  return { ...record, done: [...record.done, file], updatedAt: now.toISOString() };
}

export function remainingFiles(record: BackfillRecord): BackfillFileEntry[] {
  const done = new Set(record.done);
  return record.files.filter((f) => !done.has(f.path));
}

export function doneFunctionCount(record: BackfillRecord): number {
  const done = new Set(record.done);
  return record.files.filter((f) => done.has(f.path)).reduce((n, f) => n + f.functions, 0);
}

export function totalFunctionCount(record: BackfillRecord): number {
  return record.files.reduce((n, f) => n + f.functions, 0);
}

export function isComplete(record: BackfillRecord): boolean {
  return remainingFiles(record).length === 0;
}

export function serializeBackfillRecord(record: BackfillRecord): string {
  return JSON.stringify(record, null, 2) + '\n';
}

/** Strict parse: a malformed or foreign file yields undefined (start fresh rather than guess). */
export function parseBackfillRecord(text: string): BackfillRecord | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || typeof o.folder !== 'string' || !Array.isArray(o.files) || !Array.isArray(o.done)) return undefined;
  const files: BackfillFileEntry[] = [];
  for (const f of o.files) {
    if (!f || typeof f !== 'object') return undefined;
    const e = f as Record<string, unknown>;
    if (typeof e.path !== 'string' || typeof e.functions !== 'number') return undefined;
    files.push({ path: e.path, functions: e.functions });
  }
  if (!o.done.every((d) => typeof d === 'string')) return undefined;
  return {
    version: 1,
    folder: o.folder,
    files,
    done: o.done as string[],
    estimate: o.estimate && typeof o.estimate === 'object' ? (o.estimate as CostEstimate) : undefined,
    startedAt: typeof o.startedAt === 'string' ? o.startedAt : new Date(0).toISOString(),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : new Date(0).toISOString(),
  };
}

/** Split into batches of at most `size` (size < 1 is treated as 1). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Project a record (or several, one per folder) onto the public status shape. */
export function statusFromRecords(
  state: BackfillStatus['state'],
  records: readonly BackfillRecord[],
  extra: { currentFile?: string; error?: string; estimate?: CostEstimate } = {},
): BackfillStatus {
  const totalFiles = records.reduce((n, r) => n + r.files.length, 0);
  const doneFiles = records.reduce((n, r) => n + r.done.length, 0);
  const totalFunctions = records.reduce((n, r) => n + totalFunctionCount(r), 0);
  const doneFunctions = records.reduce((n, r) => n + doneFunctionCount(r), 0);
  const estimate = extra.estimate ?? records.find((r) => r.estimate)?.estimate;
  return { state, totalFiles, doneFiles, totalFunctions, doneFunctions, ...(extra.currentFile ? { currentFile: extra.currentFile } : {}), ...(extra.error ? { error: extra.error } : {}), ...(estimate ? { estimate } : {}) };
}

/** Human-readable estimate line shown in the confirmation dialog. */
export function describeEstimate(est: CostEstimate): string {
  const tokens = est.inputTokens + est.outputTokens;
  const channel = est.channel === 'none' ? 'no assistant' : est.channel === 'copilot' ? 'Copilot' : est.channel === 'claude' ? 'Claude Code' : 'Codex';
  return `${est.functions} function${est.functions === 1 ? '' : 's'} in ${est.files} file${est.files === 1 ? '' : 's'}, about ${est.requests} request${est.requests === 1 ? '' : 's'} and roughly ${formatTokens(tokens)} tokens, using ${channel}.`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
