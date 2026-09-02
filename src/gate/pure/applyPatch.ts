/**
 * Codex `apply_patch` format, mirrored from codex-rs/apply-patch (parser.rs, streaming_parser.rs,
 * seek_sequence.rs, file_update.rs). We only *compute* the resulting text per file; the agent or the
 * gate does the writing after review.
 *
 * Grammar (lenient about surrounding whitespace, CR stripped):
 *   *** Begin Patch
 *   *** Add File: <path>        followed by lines starting with '+'
 *   *** Delete File: <path>
 *   *** Update File: <path>     optional "*** Move to: <path>", then chunks
 *       @@ [context]            chunk header; lines ' ' context, '-' removed, '+' added, '' context
 *       *** End of File         marks the previous chunk as anchored to the end of the file
 *   *** End Patch
 */

export interface PatchChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

export type PatchHunk =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; chunks: PatchChunk[] };

export type PatchParseResult = { ok: true; hunks: PatchHunk[] } | { ok: false; error: string };

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DEL = '*** Delete File: ';
const UPD = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARK = '*** End of File';

/**
 * Pull the patch text out of a Codex tool_input. Accepts `{patch}`, `{input}`, `{command: string}` and
 * `{command: ['apply_patch', '<patch>']}`, and unwraps the `<<'EOF' ... EOF` heredoc form used by some
 * models (see ParseMode::Lenient in parser.rs).
 */
export function extractPatchText(toolInput: Record<string, unknown>): string | undefined {
  const candidates: string[] = [];
  for (const k of ['patch', 'input']) if (typeof toolInput[k] === 'string') candidates.push(toolInput[k] as string);
  const c = toolInput.command ?? toolInput.cmd;
  if (typeof c === 'string') candidates.push(c);
  else if (Array.isArray(c)) for (const x of c) if (typeof x === 'string') candidates.push(x);
  for (const text of candidates) {
    const idx = text.indexOf(BEGIN);
    if (idx < 0) continue;
    let body = text.slice(idx);
    const endIdx = body.lastIndexOf(END);
    if (endIdx >= 0) body = body.slice(0, endIdx + END.length);
    return body;
  }
  return undefined;
}

export function parsePatch(text: string): PatchParseResult {
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n');
  if (lines.length === 0 || lines[0].trim() !== BEGIN) {
    return { ok: false, error: "The first line of the patch must be '*** Begin Patch'" };
  }
  if (lines[lines.length - 1].trim() !== END) {
    return { ok: false, error: "The last line of the patch must be '*** End Patch'" };
  }
  const hunks: PatchHunk[] = [];
  let mode: 'start' | 'add' | 'delete' | 'update' = 'start';
  const fail = (message: string, lineNo: number): PatchParseResult => ({ ok: false, error: `invalid hunk at line ${lineNo}, ${message}` });

  const lastUpdate = (): Extract<PatchHunk, { kind: 'update' }> | undefined => {
    const h = hunks[hunks.length - 1];
    return h && h.kind === 'update' ? h : undefined;
  };
  const ensureUpdateNotEmpty = (lineNo: number): PatchParseResult | undefined => {
    const u = lastUpdate();
    if (!u || mode !== 'update') return undefined;
    if (u.chunks.length === 0) return fail(`Update file hunk for path '${u.path}' is empty`, lineNo);
    const last = u.chunks[u.chunks.length - 1];
    if (last.oldLines.length === 0 && last.newLines.length === 0) return fail('Update hunk does not contain any lines', lineNo);
    return undefined;
  };

  for (let i = 1; i < lines.length - 1; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    const trimmed = line.trim();

    // Hunk headers are recognised in every mode.
    if (trimmed.startsWith(ADD)) {
      const err = ensureUpdateNotEmpty(lineNo);
      if (err) return err;
      hunks.push({ kind: 'add', path: trimmed.slice(ADD.length).trim(), contents: '' });
      mode = 'add';
      continue;
    }
    if (trimmed.startsWith(DEL)) {
      const err = ensureUpdateNotEmpty(lineNo);
      if (err) return err;
      hunks.push({ kind: 'delete', path: trimmed.slice(DEL.length).trim() });
      mode = 'delete';
      continue;
    }
    if (trimmed.startsWith(UPD)) {
      const err = ensureUpdateNotEmpty(lineNo);
      if (err) return err;
      hunks.push({ kind: 'update', path: trimmed.slice(UPD.length).trim(), chunks: [] });
      mode = 'update';
      continue;
    }

    if (mode === 'start' || mode === 'delete') {
      if (mode === 'start' && trimmed.startsWith('*** Environment ID:')) continue;
      return fail(`'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`, lineNo);
    }

    if (mode === 'add') {
      const h = hunks[hunks.length - 1] as Extract<PatchHunk, { kind: 'add' }>;
      if (line.startsWith('+')) {
        h.contents += line.slice(1) + '\n';
        continue;
      }
      return fail(`'${trimmed}' is not a valid line in an Add File hunk (every line must start with '+')`, lineNo);
    }

    // mode === 'update'
    const u = lastUpdate()!;
    const updateLine = line.replace(/\s+$/, '');
    const lastChunk = u.chunks[u.chunks.length - 1];
    if (lastChunk?.isEndOfFile) {
      if (updateLine === '') continue;
      if (updateLine !== '@@' && !updateLine.startsWith('@@ ')) {
        return fail(`Expected update hunk to start with a @@ context marker, got: '${line}'`, lineNo);
      }
    }
    if (u.chunks.length === 0 && !u.moveTo && updateLine.startsWith(MOVE)) {
      u.moveTo = updateLine.slice(MOVE.length).trim();
      continue;
    }
    const isCtxHeader = updateLine === '@@' || updateLine.startsWith('@@ ');
    if (isCtxHeader && lastChunk && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
      return fail(`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`, lineNo);
    }
    if (updateLine === '@@') {
      u.chunks.push({ oldLines: [], newLines: [], isEndOfFile: false });
      continue;
    }
    if (updateLine.startsWith('@@ ')) {
      u.chunks.push({ changeContext: updateLine.slice(3), oldLines: [], newLines: [], isEndOfFile: false });
      continue;
    }
    if (updateLine === EOF_MARK) {
      if (!lastChunk || (lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0)) {
        return fail('Update hunk does not contain any lines', lineNo);
      }
      lastChunk.isEndOfFile = true;
      continue;
    }
    const chunk = (): PatchChunk => {
      if (u.chunks.length === 0) u.chunks.push({ oldLines: [], newLines: [], isEndOfFile: false });
      return u.chunks[u.chunks.length - 1];
    };
    if (line === '') {
      const c = chunk();
      c.oldLines.push('');
      c.newLines.push('');
      continue;
    }
    if (line.startsWith(' ')) {
      const c = chunk();
      c.oldLines.push(line.slice(1));
      c.newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('+')) {
      chunk().newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith('-')) {
      chunk().oldLines.push(line.slice(1));
      continue;
    }
    if (lastChunk && (lastChunk.oldLines.length > 0 || lastChunk.newLines.length > 0)) {
      return fail(`Expected update hunk to start with a @@ context marker, got: '${line}'`, lineNo);
    }
    return fail(`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`, lineNo);
  }
  const err = ensureUpdateNotEmpty(lines.length);
  if (err) return err;
  return { ok: true, hunks };
}

/** Unicode punctuation folded to ASCII for the most lenient matching pass (mirrors seek_sequence.rs). */
function normalise(s: string): string {
  return s
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

/**
 * Find `pattern` in `lines` at or after `start`, trying exact, trailing-whitespace-insensitive,
 * fully trimmed, then Unicode-normalised comparisons. `eof` starts the search at the end first.
 */
export function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;
  const searchStart = eof ? lines.length - pattern.length : start;
  const last = lines.length - pattern.length;
  const passes: ((a: string, b: string) => boolean)[] = [
    (a, b) => a === b,
    (a, b) => a.replace(/\s+$/, '') === b.replace(/\s+$/, ''),
    (a, b) => a.trim() === b.trim(),
    (a, b) => normalise(a) === normalise(b),
  ];
  for (const eq of passes) {
    for (let i = searchStart; i <= last; i++) {
      let ok = true;
      for (let p = 0; p < pattern.length; p++) {
        if (!eq(lines[i + p], pattern[p])) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return undefined;
}

export type ApplyChunksResult = { ok: true; after: string } | { ok: false; error: string };

/**
 * Apply update chunks to the original text (NormalizeToLf semantics from file_update.rs):
 * split on '\n', drop the trailing empty element, locate each chunk in order, replace, then make
 * sure the result ends with a newline. CRLF input is handled by the caller (see proposals.ts).
 */
export function applyUpdateChunks(original: string, chunks: PatchChunk[], displayPath = 'file'): ApplyChunksResult {
  const originalLines = original.split('\n');
  if (originalLines.length && originalLines[originalLines.length - 1] === '') originalLines.pop();

  const replacements: { start: number; oldLen: number; newLines: string[]; order: number }[] = [];
  let lineIndex = 0;
  let order = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const idx = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (idx === undefined) return { ok: false, error: `Failed to find context '${chunk.changeContext}' in ${displayPath}` };
      lineIndex = idx + 1;
    }
    if (chunk.oldLines.length === 0) {
      // Pure insertion: appended at the end of the file (legacy behaviour kept by codex).
      const insertionIdx = originalLines.length && originalLines[originalLines.length - 1] === '' ? originalLines.length - 1 : originalLines.length;
      replacements.push({ start: insertionIdx, oldLen: 0, newLines: [...chunk.newLines], order: order++ });
      continue;
    }
    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    if (found === undefined && pattern[pattern.length - 1] === '') {
      // A trailing empty line stands for the file's final newline; retry without it.
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === '') newSlice = newSlice.slice(0, -1);
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (found === undefined) {
      return { ok: false, error: `Failed to find expected lines in ${displayPath}:\n${chunk.oldLines.join('\n')}` };
    }
    replacements.push({ start: found, oldLen: pattern.length, newLines: [...newSlice], order: order++ });
    lineIndex = found + pattern.length;
  }
  // Apply from the bottom up so earlier indices stay valid; equal starts keep patch order.
  replacements.sort((a, b) => a.start - b.start || a.order - b.order);
  const lines = originalLines.slice();
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    lines.splice(r.start, Math.min(r.oldLen, Math.max(0, lines.length - r.start)), ...r.newLines);
  }
  if (lines.length === 0 || lines[lines.length - 1] !== '') lines.push('');
  return { ok: true, after: lines.join('\n') };
}

/** Every path a patch touches (source paths and move destinations), in order. */
export function patchPaths(hunks: PatchHunk[]): string[] {
  const out: string[] = [];
  for (const h of hunks) {
    out.push(h.path);
    if (h.kind === 'update' && h.moveTo) out.push(h.moveTo);
  }
  return out;
}
