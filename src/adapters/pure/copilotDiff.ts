/**
 * Pure helpers for the Copilot review overlay: which functions changed between two snapshots of a
 * file, and how to word the CodeLens title while the explanation streams in.
 */
import type { FunctionMap, FunctionRecord } from '../../core/types';
import { normalizeNewlines } from '../../core/hash';

export type FunctionChangeType = 'added' | 'removed' | 'modified';

export interface FunctionChange {
  name: string;
  changeType: FunctionChangeType;
  /** 0-based first line of the function in the CURRENT text (undefined for removed functions). */
  line?: number;
  beforeText: string;
  afterText: string;
}

/** Full-line text of a function's range (0-based inclusive lines). */
export function functionText(text: string, rec: Pick<FunctionRecord, 'range'>): string {
  const lines = normalizeNewlines(text).split('\n');
  const start = Math.max(0, rec.range.startLine);
  const end = Math.min(lines.length - 1, rec.range.endLine);
  if (end < start) return '';
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Compares two function maps by name. Duplicate names are compared by position order within the
 * duplicate set. Functions whose contentHash is equal are unchanged (moved code is not a change).
 */
export function diffFunctionMaps(before: FunctionMap, beforeText: string, after: FunctionMap, afterText: string): FunctionChange[] {
  const byName = (m: FunctionMap): Map<string, FunctionRecord[]> => {
    const out = new Map<string, FunctionRecord[]>();
    for (const f of m.functions) {
      const list = out.get(f.name) ?? [];
      list.push(f);
      out.set(f.name, list);
    }
    return out;
  };
  const b = byName(before);
  const a = byName(after);
  const changes: FunctionChange[] = [];
  for (const [name, afterList] of a) {
    const beforeList = b.get(name) ?? [];
    afterList.forEach((rec, i) => {
      const prev = beforeList[i];
      if (!prev) {
        changes.push({ name, changeType: 'added', line: rec.range.startLine, beforeText: '', afterText: functionText(afterText, rec) });
      } else if (prev.contentHash !== rec.contentHash) {
        changes.push({ name, changeType: 'modified', line: rec.range.startLine, beforeText: functionText(beforeText, prev), afterText: functionText(afterText, rec) });
      }
    });
  }
  for (const [name, beforeList] of b) {
    const afterCount = (a.get(name) ?? []).length;
    for (let i = afterCount; i < beforeList.length; i++) {
      changes.push({ name, changeType: 'removed', beforeText: functionText(beforeText, beforeList[i]), afterText: '' });
    }
  }
  changes.sort((x, y) => (x.line ?? Number.MAX_SAFE_INTEGER) - (y.line ?? Number.MAX_SAFE_INTEGER));
  return changes;
}

export interface LensState {
  name: string;
  changeType: FunctionChangeType;
  /** Text received so far, or the final one-sentence "what changed". */
  summary?: string;
  status: 'pending' | 'streaming' | 'done' | 'error';
  error?: string;
}

const MAX_TITLE = 90;

/** One-line CodeLens title: "ExplainIT: what changed — <summary>" with streaming/empty/error states. */
export function lensTitle(s: LensState): string {
  const prefix = 'ExplainIT: what changed — ';
  let body: string;
  if (s.status === 'pending') body = `${s.name} (${s.changeType}) · explaining…`;
  else if (s.status === 'error') body = `${s.name} (${s.changeType}) · ${s.error || 'no explanation available'}`;
  else {
    const text = (s.summary || '').replace(/\s+/g, ' ').trim();
    body = text ? text : `${s.name} (${s.changeType})`;
    if (s.status === 'streaming') body += '…';
  }
  if (body.length > MAX_TITLE) body = body.slice(0, MAX_TITLE - 1).trimEnd() + '…';
  return prefix + body;
}

/** Small files only: the overlay skips anything above this size. */
export const MAX_WATCHED_BYTES = 500 * 1024;

export function shouldWatchPath(fsPath: string, isTwin: (p: string) => boolean): boolean {
  if (isTwin(fsPath)) return false;
  const norm = fsPath.replace(/\\/g, '/');
  if (/\/(node_modules|\.git|dist|out|build)\//.test(norm)) return false;
  return true;
}
