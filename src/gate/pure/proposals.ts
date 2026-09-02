/**
 * Turn an agent tool call into ProposedWrite[] (what the file looks like before and after). Pure:
 * the caller supplies file reading and path resolution.
 *
 * Claude: Write (create/modify), Edit (old_string -> new_string, replace_all), MultiEdit
 * (sequential). NotebookEdit is answered 'ask' by the controller and never reaches here.
 * Codex: apply_patch via applyPatch.ts; Write/Edit like Claude.
 */
import type { ProposedWrite } from '../../core/types';
import { applyUpdateChunks, extractPatchText, parsePatch } from './applyPatch';
import { detectEol, withEol } from './text';

export interface ProposalIo {
  /** Current on-disk content, or null when the file does not exist. */
  readFile(canonicalPath: string): string | null;
  /** Resolve an agent-supplied path (possibly relative to cwd) to a canonical absolute path. */
  resolve(rawPath: string): string;
}

export type ProposalResult =
  | { ok: true; writes: ProposedWrite[] }
  | { ok: false; kind: 'not-found' | 'invalid'; error: string };

export interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export type EditResult = { ok: true; after: string } | { ok: false; error: string };

function countOccurrences(hay: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j < 0) return n;
    n++;
    i = j + needle.length;
  }
}

/**
 * Claude's Edit semantics: `old_string` must occur; without `replace_all` it must be unique.
 * When the file uses CRLF and the agent sent LF text, we retry on LF-normalised text and restore CRLF.
 */
export function applyEdit(before: string, edit: EditSpec): EditResult {
  const tryApply = (text: string): EditResult => {
    if (edit.old_string === '') {
      // Claude treats an empty old_string as "create/overwrite with new_string" only for new files.
      return text === '' ? { ok: true, after: edit.new_string } : { ok: false, error: 'old_string is empty but the file already has content' };
    }
    const n = countOccurrences(text, edit.old_string);
    if (n === 0) return { ok: false, error: 'old_string was not found in the file' };
    if (n > 1 && !edit.replace_all) return { ok: false, error: `old_string appears ${n} times; it must be unique unless replace_all is set` };
    const after = edit.replace_all ? text.split(edit.old_string).join(edit.new_string) : text.replace(edit.old_string, () => edit.new_string);
    return { ok: true, after };
  };
  const direct = tryApply(before);
  if (direct.ok || !before.includes('\r\n')) return direct;
  const eol = detectEol(before);
  const retry = tryApply(withEol(before, '\n'));
  if (!retry.ok) return direct;
  return { ok: true, after: withEol(retry.after, eol) };
}

/** MultiEdit: apply edits in order, each on the result of the previous one. */
export function applyEdits(before: string, edits: EditSpec[]): EditResult {
  let text = before;
  for (let i = 0; i < edits.length; i++) {
    const r = applyEdit(text, edits[i]);
    if (!r.ok) return { ok: false, error: `edit ${i + 1} of ${edits.length}: ${r.error}` };
    text = r.after;
  }
  return { ok: true, after: text };
}

export function buildClaudeWrites(toolName: string, toolInput: Record<string, unknown>, io: ProposalIo): ProposalResult {
  const raw = toolInput.file_path;
  if (typeof raw !== 'string' || !raw) return { ok: false, kind: 'invalid', error: 'file_path is missing' };
  const p = io.resolve(raw);
  const before = io.readFile(p);
  switch (toolName) {
    case 'Write': {
      const content = String(toolInput.content ?? '');
      return { ok: true, writes: [{ kind: before === null ? 'create' : 'modify', path: p, before, after: content }] };
    }
    case 'Edit': {
      const edit: EditSpec = {
        old_string: String(toolInput.old_string ?? ''),
        new_string: String(toolInput.new_string ?? ''),
        replace_all: toolInput.replace_all === true,
      };
      if (before === null && edit.old_string !== '') return { ok: false, kind: 'not-found', error: `${p} does not exist` };
      const r = applyEdit(before ?? '', edit);
      if (!r.ok) return { ok: false, kind: 'not-found', error: r.error };
      return { ok: true, writes: [{ kind: before === null ? 'create' : 'modify', path: p, before, after: r.after }] };
    }
    case 'MultiEdit': {
      const edits = Array.isArray(toolInput.edits) ? (toolInput.edits as EditSpec[]) : [];
      if (edits.length === 0) return { ok: false, kind: 'invalid', error: 'edits is empty' };
      if (before === null && edits[0].old_string !== '') return { ok: false, kind: 'not-found', error: `${p} does not exist` };
      const r = applyEdits(before ?? '', edits);
      if (!r.ok) return { ok: false, kind: 'not-found', error: r.error };
      return { ok: true, writes: [{ kind: before === null ? 'create' : 'modify', path: p, before, after: r.after }] };
    }
    default:
      return { ok: false, kind: 'invalid', error: `unsupported tool ${toolName}` };
  }
}

/** Codex apply_patch -> one ProposedWrite per file hunk. */
export function buildPatchWrites(toolInput: Record<string, unknown>, io: ProposalIo): ProposalResult {
  const text = extractPatchText(toolInput);
  if (!text) return { ok: false, kind: 'invalid', error: 'no apply_patch text found in tool_input' };
  const parsed = parsePatch(text);
  if (!parsed.ok) return { ok: false, kind: 'invalid', error: parsed.error };
  const writes: ProposedWrite[] = [];
  for (const h of parsed.hunks) {
    const p = io.resolve(h.path);
    const before = io.readFile(p);
    if (h.kind === 'add') {
      writes.push({ kind: before === null ? 'create' : 'modify', path: p, before, after: h.contents });
      continue;
    }
    if (h.kind === 'delete') {
      if (before === null) return { ok: false, kind: 'not-found', error: `${p} does not exist, so it cannot be deleted` };
      writes.push({ kind: 'delete', path: p, before, after: null });
      continue;
    }
    if (before === null) return { ok: false, kind: 'not-found', error: `${p} does not exist, so it cannot be updated` };
    // Chunks are matched on LF text; the original line-ending style is restored afterwards.
    const eol = detectEol(before);
    const r = applyUpdateChunks(withEol(before, '\n'), h.chunks, h.path);
    if (!r.ok) return { ok: false, kind: 'not-found', error: r.error };
    const after = withEol(r.after, eol);
    if (h.moveTo) {
      writes.push({ kind: 'move', path: p, newPath: io.resolve(h.moveTo), before, after });
    } else {
      writes.push({ kind: 'modify', path: p, before, after });
    }
  }
  return { ok: true, writes };
}

/**
 * Bytes the review would have to handle (for the 2 MB cap): per write the larger side of the
 * change, so a delete or a shrink of a huge file counts as much as writing it.
 */
export function proposalSize(writes: ProposedWrite[]): number {
  let n = 0;
  for (const w of writes) n += Math.max(Buffer.byteLength(w.after ?? '', 'utf8'), Buffer.byteLength(w.before ?? '', 'utf8'));
  return n;
}
