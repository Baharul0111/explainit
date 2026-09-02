/**
 * Plain-English labels for journal entries and restore points (used by the tree view and the
 * restore quick pick). Pure: no `vscode` import, injectable clock.
 */
import * as path from 'node:path';
import type { AgentKind, Checkpoint, JournalEntry } from '../../core/types';

export function agentName(agent?: AgentKind | null): string {
  switch (agent) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'copilot':
      return 'Copilot';
    default:
      return 'an assistant';
  }
}

/** "just now", "5 minutes ago", "yesterday", "on 2026-09-02" — never throws on a bad timestamp. */
export function timeAgo(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'at an unknown time';
  const diff = Math.max(0, nowMs - t);
  const sec = Math.round(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return min === 1 ? '1 minute ago' : `${min} minutes ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 2) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return `on ${new Date(t).toISOString().slice(0, 10)}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The verb phrase for an entry, e.g. "accepted by you", "proposed by Claude Code". */
export function verdictPhrase(entry: JournalEntry): string {
  switch (entry.kind) {
    case 'proposed':
      return `proposed by ${agentName(entry.agent)}`;
    case 'decided': {
      const d = entry.decision;
      if (!d) return 'decided';
      switch (d.verdict) {
        case 'accept':
          return d.scope === 'session' ? 'accepted by you (rest of session)' : d.scope === 'file' ? 'accepted by you (rest of file)' : 'accepted by you';
        case 'reject':
          return d.reason ? `rejected by you: ${d.reason}` : 'rejected by you';
        case 'partial':
          return 'partly accepted by you';
        case 'auto':
          return d.scope === 'session' ? 'accepted automatically (rest of session)' : d.scope === 'file' ? 'accepted automatically (rest of file)' : 'accepted automatically (remembered decision)';
        case 'deny-protected':
          return 'refused: protected file';
        case 'paused':
          return 'let through (checkpoint paused)';
        case 'ask':
          return "handed to the assistant's own prompt";
        default:
          return String(d.verdict);
      }
    }
    case 'applied':
      return entry.agent ? `written to disk for ${agentName(entry.agent)}` : 'written to disk';
    case 'restored':
      return 'restored by you from a restore point';
    case 'system':
      return entry.note ? `ExplainIT: ${entry.note}` : 'ExplainIT note';
    default:
      return String(entry.kind);
  }
}

/** "accepted by you · 2 minutes ago" */
export function describeEntry(entry: JournalEntry, nowMs: number = Date.now()): string {
  return `${verdictPhrase(entry)} · ${timeAgo(entry.ts, nowMs)}`;
}

/** Multi-line detail for tooltips. */
export function entryTooltip(entry: JournalEntry): string {
  const lines = [`#${entry.seq} ${entry.kind} — ${verdictPhrase(entry)}`, `When: ${entry.ts}`];
  if (entry.path) lines.push(`File: ${entry.path}`);
  if (entry.agent) lines.push(`Assistant: ${agentName(entry.agent)}`);
  if (entry.requestId) lines.push(`Request: ${entry.requestId}`);
  if (entry.beforeHash !== undefined) lines.push(`Before: ${entry.beforeHash === null ? '(file did not exist)' : entry.beforeHash.slice(0, 12)}`);
  if (entry.afterHash !== undefined) lines.push(`After: ${entry.afterHash === null ? '(file removed)' : entry.afterHash.slice(0, 12)}`);
  if (entry.checkpointId) lines.push(`Restore point: ${entry.checkpointId}`);
  if (entry.note && entry.kind !== 'system') lines.push(`Note: ${entry.note}`);
  lines.push(`Entry hash: ${entry.hash.slice(0, 16)}…`);
  return lines.join('\n');
}

/** Label + description for a restore point: "Restore point · 2 minutes ago", "1.2 KB · before a change by Claude Code". */
export function describeCheckpoint(cp: Checkpoint, nowMs: number = Date.now()): { label: string; description: string; tooltip: string } {
  const by = cp.agent ? `before a change by ${agentName(cp.agent)}` : 'saved by ExplainIT';
  return {
    label: `Restore point · ${timeAgo(cp.ts, nowMs)}`,
    description: `${formatBytes(cp.size)} · ${by}`,
    tooltip: [`Restore point ${cp.id}`, `File: ${cp.path}`, `Saved: ${cp.ts}`, `Size: ${formatBytes(cp.size)}`, `Content hash: ${cp.contentHash.slice(0, 16)}…`, cp.requestId ? `Request: ${cp.requestId}` : '', 'Click to compare with the current file. Use the restore button to bring this version back.'].filter(Boolean).join('\n'),
  };
}

export interface PathGroup {
  /** '' for entries without a file (system notes). */
  path: string;
  /** Newest first. */
  entries: JournalEntry[];
}

/** Group entries by file, most recently active file first, newest entry first inside each group. */
export function groupEntriesByPath(entries: JournalEntry[]): PathGroup[] {
  const groups = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const key = e.kind === 'system' ? '' : (e.path ?? '');
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const out: PathGroup[] = [];
  for (const [p, list] of groups) {
    list.sort((a, b) => b.seq - a.seq);
    out.push({ path: p, entries: list });
  }
  out.sort((a, b) => (b.entries[0]?.seq ?? 0) - (a.entries[0]?.seq ?? 0));
  return out;
}

/** Path shown in the tree: relative to the workspace folder when inside it, else the full path. */
export function displayPath(folder: string | undefined, p: string): string {
  if (!p) return 'ExplainIT notes';
  if (folder) {
    const rel = path.relative(folder, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return p;
}
