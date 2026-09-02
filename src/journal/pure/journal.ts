/**
 * Append-only, hash-chained change journal (REQ-015, goal item 11). Pure Node: no `vscode` import.
 *
 * File format: `journal.jsonl`, one canonical-JSON `JournalEntry` per line, `\n` terminated.
 *   hash     = sha256(prevHash + canonicalJson(entry without `hash`))
 *   prevHash = hash of the previous entry; the very first entry uses 64 zeros (GENESIS_HASH)
 *   seq      = 1, 2, 3 ... (never reused, continues across archive files)
 *
 * Appends are serialised through an in-process queue and fsync'd, so a crash can lose at most the
 * line being written. A partial last line (no trailing newline, unparseable) is treated as an
 * interrupted write: the next append trims it and records a `system` entry saying so.
 *
 * Rotation: when the active file holds more than `maxEntries` lines, the oldest half moves to
 * `journal.<ts>.archived.jsonl` (same folder) and a `system` entry records the archive's head
 * prevHash (`beforeHash`) and tail hash (`afterHash`). The chain itself is untouched — the first
 * entry of the active file still points at the archive's last hash — so `verifyChain` walks every
 * archive in order and then the active file as one continuous chain.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalJson, sha256 } from '../../core/hash';
import type { Journal } from '../../core/interfaces';
import type { Logger } from '../../core/log';
import type { JournalEntry } from '../../core/types';

export const GENESIS_HASH = '0'.repeat(64);
/** Archive files live beside the journal and match this name. */
export const ARCHIVE_RE = /^journal\.(.+)\.archived\.jsonl$/;
const TMP_SUFFIX = '.tmp';
/** Rotation never goes below this many entries per active file, whatever the setting says. */
const MIN_MAX_ENTRIES = 2;
/** Used when the `journal.maxEntries` setting is missing or not a positive number. */
const DEFAULT_MAX_ENTRIES = 5000;

export type JournalAppendInput = Omit<JournalEntry, 'version' | 'seq' | 'ts' | 'prevHash' | 'hash'>;

export interface JournalOptions {
  /** Absolute path of journal.jsonl (HOME_LAYOUT.journal(folder)). Parent folders are created. */
  file: string;
  /** Read live so settings changes apply without restart. Default 5000. */
  maxEntries?: () => number;
  logger?: Logger;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  brokenAt?: number;
  detail?: string;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for unit tests and for the tree view)
// ---------------------------------------------------------------------------------------------

/** The hash of an entry: sha256(prevHash + canonicalJson(entry without `hash`)). */
export function hashEntry(entry: Omit<JournalEntry, 'hash'>): string {
  return sha256(entry.prevHash + canonicalJson(entry));
}

export function stripHash(entry: JournalEntry): Omit<JournalEntry, 'hash'> {
  const { hash: _hash, ...rest } = entry;
  return rest;
}

export interface ParsedLine {
  /** 1-based line number in the file. */
  lineNo: number;
  raw: string;
  entry?: JournalEntry;
  /** Set when the line is not a valid journal entry. */
  problem?: string;
}

export interface ParsedJournal {
  lines: ParsedLine[];
  /** Only the lines that parsed, in file order. */
  entries: JournalEntry[];
  /** True when the file does not end with a newline (the last write may have been interrupted). */
  partialTail: boolean;
}

function looksLikeEntry(v: unknown): v is JournalEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.hash === 'string' && typeof o.prevHash === 'string' && typeof o.seq === 'number' && typeof o.kind === 'string' && typeof o.ts === 'string';
}

/** Split journal text into lines; never throws. Blank lines and non-JSON lines are reported as problems. */
export function parseJournalText(text: string): ParsedJournal {
  const lines: ParsedLine[] = [];
  const entries: JournalEntry[] = [];
  if (text.length === 0) return { lines, entries, partialTail: false };
  const endsWithNewline = text.endsWith('\n');
  const segs = text.split('\n');
  if (endsWithNewline) segs.pop();
  segs.forEach((seg, i) => {
    const raw = seg.endsWith('\r') ? seg.slice(0, -1) : seg;
    const lineNo = i + 1;
    if (raw.trim() === '') {
      lines.push({ lineNo, raw, problem: 'the line is empty' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      lines.push({ lineNo, raw, problem: 'the line is not valid JSON' });
      return;
    }
    if (!looksLikeEntry(parsed)) {
      lines.push({ lineNo, raw, problem: 'the line is not a journal entry' });
      return;
    }
    lines.push({ lineNo, raw, entry: parsed });
    entries.push(parsed);
  });
  return { lines, entries, partialTail: !endsWithNewline };
}

export interface VerifyLinesResult {
  ok: boolean;
  count: number;
  brokenAt?: number;
  detail?: string;
  /** Hash of the last verified entry (or the starting prevHash when the file is empty). */
  tailHash: string;
  /** Expected seq of the entry that follows the last verified one. */
  nextSeq: number | undefined;
}

/**
 * Re-hash every line and check that each links to the previous one. `expectedPrev` is the hash the
 * first line must point at (GENESIS_HASH for a fresh journal, an archive's tail hash otherwise).
 */
export function verifyLines(parsed: ParsedJournal, expectedPrev: string, expectedSeq: number | undefined, fileLabel: string): VerifyLinesResult {
  let prev = expectedPrev;
  let seq = expectedSeq;
  let count = 0;
  const fail = (brokenAt: number, detail: string): VerifyLinesResult => ({ ok: false, count, brokenAt, detail, tailHash: prev, nextSeq: seq });
  for (let i = 0; i < parsed.lines.length; i++) {
    const line = parsed.lines[i];
    const isLast = i === parsed.lines.length - 1;
    if (line.problem || !line.entry) {
      if (isLast && parsed.partialTail) {
        return fail(
          line.lineNo,
          `Line ${line.lineNo} of ${fileLabel} is incomplete, most likely because a write was interrupted. Every line before it verifies. ExplainIT will trim the incomplete line and note the repair the next time it records a change.`,
        );
      }
      return fail(line.lineNo, `Line ${line.lineNo} of ${fileLabel} is not a valid journal entry (${line.problem ?? 'unreadable'}). The file may have been edited by hand or damaged.`);
    }
    const e = line.entry;
    if (hashEntry(stripHash(e)) !== e.hash) {
      return fail(line.lineNo, `Line ${line.lineNo} of ${fileLabel} was altered after it was written: its hash no longer matches its content.`);
    }
    if (e.prevHash !== prev) {
      if (count === 0 && prev === expectedPrev) {
        return fail(
          line.lineNo,
          expectedPrev === GENESIS_HASH
            ? `Line ${line.lineNo} of ${fileLabel} points at an earlier entry that does not exist: the file does not start at the beginning of the chain. An archive file may have been deleted or moved.`
            : `Line ${line.lineNo} of ${fileLabel} does not continue from the previous file: its prevHash does not match the last archived entry. An entry was changed, removed or inserted at the boundary.`,
        );
      }
      return fail(line.lineNo, `Line ${line.lineNo} of ${fileLabel} does not link to the entry before it: its prevHash does not match. An entry was changed, removed or inserted before it.`);
    }
    if (seq !== undefined && e.seq !== seq) {
      return fail(line.lineNo, `Line ${line.lineNo} of ${fileLabel} has sequence number ${e.seq} but ${seq} was expected: entries are missing, duplicated or out of order.`);
    }
    prev = e.hash;
    seq = e.seq + 1;
    count++;
  }
  return { ok: true, count, tailHash: prev, nextSeq: seq };
}

/** Compare two file paths the way the journal does (resolved; case-insensitive on Windows). */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  let x = path.resolve(a);
  let y = path.resolve(b);
  if (process.platform === 'win32') {
    x = x.toLowerCase();
    y = y.toLowerCase();
  }
  return x === y;
}

/** Windows-safe timestamp for file names: 2026-09-02T10-11-12-345Z */
export function compactTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function writeFileSynced(file: string, data: string): Promise<void> {
  const fh = await fsp.open(file, 'w');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function readTextOrEmpty(file: string): Promise<Buffer> {
  try {
    return await fsp.readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------------------------

interface TailState {
  seq: number;
  hash: string;
  /** Raw line count in the active file (drives rotation). */
  lines: number;
  /** Size in bytes when we last touched the file; a mismatch means another process appended. */
  bytes: number;
}

class FileJournal implements Journal {
  readonly file: string;
  private readonly dir: string;
  private readonly logger: Logger | undefined;
  private readonly maxEntries: () => number;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();
  private state: TailState | undefined;

  constructor(opts: JournalOptions) {
    this.file = path.resolve(opts.file);
    this.dir = path.dirname(this.file);
    this.logger = opts.logger;
    this.maxEntries = opts.maxEntries ?? (() => DEFAULT_MAX_ENTRIES);
    this.now = opts.now ?? (() => new Date());
  }

  /** Every operation runs through one queue so appends, rotation and reads never interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  append(input: JournalAppendInput): Promise<JournalEntry> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const entry = await this.writeEntry(input);
        await this.rotateIfNeeded();
        return entry;
      } catch (e) {
        // Whatever went wrong, the next append must re-read the file instead of trusting stale state.
        this.state = undefined;
        throw this.plainError('record a change in', e);
      }
    });
  }

  list(opts?: { path?: string; limit?: number }): Promise<JournalEntry[]> {
    return this.enqueue(async () => {
      let text: string;
      try {
        text = (await readTextOrEmpty(this.file)).toString('utf8');
      } catch (e) {
        throw this.plainError('read', e);
      }
      let entries = parseJournalText(text).entries;
      if (opts?.path) entries = entries.filter((e) => samePath(e.path, opts.path));
      if (opts?.limit !== undefined && opts.limit >= 0 && entries.length > opts.limit) entries = entries.slice(entries.length - opts.limit);
      return entries;
    });
  }

  verifyChain(): Promise<VerifyResult> {
    return this.enqueue(async () => {
      try {
        return await this.verifyLocked();
      } catch (e) {
        throw this.plainError('verify', e);
      }
    });
  }

  /** Errors that reach people say what happened and what to do next, and never lose the OS detail. */
  private plainError(action: string, e: unknown): Error {
    const code = (e as NodeJS.ErrnoException)?.code;
    const reason = (e as Error)?.message ?? String(e);
    const hint =
      code === 'EISDIR'
        ? `A folder is sitting where the journal file should be. Move or remove ${this.file} and try again.`
        : code === 'EACCES' || code === 'EPERM'
          ? `Check that ${this.dir} is writable by you.`
          : code === 'ENOSPC'
            ? 'The disk is full. Free some space and try again.'
            : `Check free disk space and that ${this.dir} is writable.`;
    return new Error(`ExplainIT could not ${action} its change journal at ${this.file} (${reason}). ${hint}`);
  }

  /** The active-file cap: the live setting when it is a positive number, else the default; never below MIN_MAX_ENTRIES. */
  private effectiveMaxEntries(): number {
    const raw = Number(this.maxEntries());
    const value = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_ENTRIES;
    return Math.max(MIN_MAX_ENTRIES, value);
  }

  // -- internals (always called from inside the queue) -----------------------------------------

  private async ensureLoaded(): Promise<void> {
    let size: number;
    try {
      size = (await fsp.stat(this.file)).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await fsp.mkdir(this.dir, { recursive: true });
      this.state = { seq: 0, hash: GENESIS_HASH, lines: 0, bytes: 0 };
      await this.recoverTmpArchives(undefined);
      return;
    }
    if (this.state && this.state.bytes === size) return;

    const buf = await fsp.readFile(this.file);
    const parsed = parseJournalText(buf.toString('utf8'));
    const last = parsed.entries[parsed.entries.length - 1];
    this.state = { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS_HASH, lines: parsed.lines.length, bytes: size };
    if (last === undefined && parsed.lines.length > 0) {
      this.logger?.warn(`journal ${this.file} has ${parsed.lines.length} line(s) but none is a valid entry; continuing from the start of the chain`);
    }

    if (parsed.partialTail && parsed.lines.length > 0) {
      const tail = parsed.lines[parsed.lines.length - 1];
      if (tail.problem) {
        // Interrupted write: trim the partial line (up to and including the previous newline) and say so.
        const keep = buf.lastIndexOf(0x0a) + 1;
        await fsp.truncate(this.file, keep);
        this.state.bytes = keep;
        this.state.lines = parsed.lines.length - 1;
        this.logger?.warn(`journal ${this.file}: removed an incomplete last line (${tail.raw.length} characters)`);
        await this.writeEntry({
          kind: 'system',
          note: `Removed an incomplete last line (${tail.raw.length} characters), most likely left by an interrupted write. Every entry before it is unchanged.`,
        });
      } else {
        // The entry is complete but its newline never made it to disk; finish the line.
        await this.appendRaw('\n');
      }
    }
    await this.recoverTmpArchives(parsed.entries[0]);
  }

  private async appendRaw(data: string): Promise<void> {
    const fh = await fsp.open(this.file, 'a');
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (this.state) this.state.bytes += Buffer.byteLength(data, 'utf8');
  }

  private async writeEntry(input: JournalAppendInput): Promise<JournalEntry> {
    const st = this.state!;
    // Never trust caller-supplied chain fields, even if a JournalEntry-shaped object sneaks in.
    const { version: _v, seq: _s, ts: _t, prevHash: _p, hash: _h, ...rest } = input as Partial<JournalEntry>;
    const partial: Omit<JournalEntry, 'hash'> = { ...(rest as JournalAppendInput), version: 1, seq: st.seq + 1, ts: this.now().toISOString(), prevHash: st.hash };
    const entry: JournalEntry = { ...partial, hash: hashEntry(partial) };
    await this.appendRaw(canonicalJson(entry) + '\n');
    st.seq = entry.seq;
    st.hash = entry.hash;
    st.lines += 1;
    return entry;
  }

  private async rotateIfNeeded(): Promise<void> {
    const st = this.state!;
    const max = this.effectiveMaxEntries();
    if (st.lines <= max) return;
    try {
      const buf = await fsp.readFile(this.file);
      const text = buf.toString('utf8');
      const segs = text.split('\n');
      if (segs[segs.length - 1] === '') segs.pop();
      const half = Math.floor(segs.length / 2);
      if (half < 1) return;
      const older = segs.slice(0, half);
      const newer = segs.slice(half);
      const olderParsed = parseJournalText(older.join('\n') + '\n').entries;
      const headPrev = olderParsed[0]?.prevHash ?? GENESIS_HASH;
      const tailHash = olderParsed[olderParsed.length - 1]?.hash ?? headPrev;

      const archive = await this.uniqueArchivePath();
      const archiveTmp = archive + TMP_SUFFIX;
      const activeTmp = this.file + TMP_SUFFIX;
      // Order matters for crash safety: archive copy first, then swap the active file, then commit the archive name.
      await writeFileSynced(archiveTmp, older.join('\n') + '\n');
      const newerText = newer.join('\n') + '\n';
      await writeFileSynced(activeTmp, newerText);
      await fsp.rename(activeTmp, this.file);
      await fsp.rename(archiveTmp, archive);
      st.lines = newer.length;
      st.bytes = Buffer.byteLength(newerText, 'utf8');
      this.logger?.info(`journal rotated: ${older.length} entries archived to ${path.basename(archive)}`);
      await this.writeEntry({
        kind: 'system',
        note: `Moved the oldest ${older.length} entries to ${path.basename(archive)}. The chain continues from hash ${tailHash.slice(0, 12)}.`,
        path: archive,
        beforeHash: headPrev,
        afterHash: tailHash,
      });
    } catch (e) {
      // Rotation is best effort; the journal itself stays intact and we try again after the next entry.
      this.logger?.warn('journal rotation failed; will retry after the next entry', e);
      this.state = undefined;
    }
  }

  private async uniqueArchivePath(): Promise<string> {
    const base = path.join(this.dir, `journal.${compactTimestamp(this.now())}.archived.jsonl`);
    let candidate = base;
    for (let n = 2; n < 1000; n++) {
      try {
        await fsp.access(candidate);
        candidate = base.replace(/\.archived\.jsonl$/, `-${n}.archived.jsonl`);
      } catch {
        return candidate;
      }
    }
    return candidate;
  }

  /** Finish or discard a `.archived.jsonl.tmp` left by a crash in the middle of rotation. */
  private async recoverTmpArchives(activeHead: JournalEntry | undefined): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(TMP_SUFFIX)) continue;
      const finalName = name.slice(0, -TMP_SUFFIX.length);
      if (!ARCHIVE_RE.test(finalName) && finalName !== path.basename(this.file)) continue;
      const tmp = path.join(this.dir, name);
      try {
        if (ARCHIVE_RE.test(finalName) && activeHead) {
          const parsed = parseJournalText((await fsp.readFile(tmp)).toString('utf8'));
          const tail = parsed.entries[parsed.entries.length - 1];
          if (tail && tail.hash === activeHead.prevHash) {
            await fsp.rename(tmp, path.join(this.dir, finalName));
            this.logger?.info(`journal: completed an interrupted rotation (${finalName})`);
            continue;
          }
        }
        await fsp.unlink(tmp);
        this.logger?.warn(`journal: discarded a stale temporary file ${name}`);
      } catch (e) {
        this.logger?.warn(`journal: could not clean up ${name}`, e);
      }
    }
  }

  private async listArchives(): Promise<string[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => ARCHIVE_RE.test(n))
      .sort()
      .map((n) => path.join(this.dir, n));
  }

  /**
   * Every archive, parsed and in chain order. Names carry a timestamp, but two rotations inside the
   * same millisecond get `-2`, `-3` ... suffixes that do not sort lexically, so the order comes from
   * the first entry's seq (an archive without a single valid entry goes last and fails verification
   * on its own merits).
   */
  private async loadArchives(): Promise<{ file: string; label: string; parsed: ParsedJournal }[]> {
    const loaded: { file: string; label: string; parsed: ParsedJournal }[] = [];
    for (const file of await this.listArchives()) {
      loaded.push({ file, label: path.basename(file), parsed: parseJournalText((await readTextOrEmpty(file)).toString('utf8')) });
    }
    const firstSeq = (p: ParsedJournal): number => p.entries[0]?.seq ?? Number.MAX_SAFE_INTEGER;
    return loaded.sort((a, b) => firstSeq(a.parsed) - firstSeq(b.parsed) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  }

  private async verifyLocked(): Promise<VerifyResult> {
    const archives = await this.loadArchives();
    const tails = new Map<string, string>();
    let expectedPrev = GENESIS_HASH;
    let expectedSeq: number | undefined;
    let total = 0;
    const allEntries: { entry: JournalEntry; lineNo: number; label: string }[] = [];

    for (const { label, parsed } of archives) {
      const r = verifyLines(parsed, expectedPrev, expectedSeq, label);
      if (!r.ok) return { ok: false, entries: total + r.count, brokenAt: r.brokenAt, detail: r.detail };
      expectedPrev = r.tailHash;
      expectedSeq = r.nextSeq;
      total += r.count;
      tails.set(label, r.tailHash);
      for (const l of parsed.lines) if (l.entry) allEntries.push({ entry: l.entry, lineNo: l.lineNo, label });
    }

    const activeLabel = path.basename(this.file);
    const active = parseJournalText((await readTextOrEmpty(this.file)).toString('utf8'));
    const r = verifyLines(active, expectedPrev, expectedSeq, activeLabel);
    if (!r.ok) return { ok: false, entries: total + r.count, brokenAt: r.brokenAt, detail: r.detail };
    total += r.count;
    for (const l of active.lines) if (l.entry) allEntries.push({ entry: l.entry, lineNo: l.lineNo, label: activeLabel });

    // Archive links: every rotation note must point at an archive whose last hash it recorded.
    for (const { entry, lineNo, label } of allEntries) {
      if (entry.kind !== 'system' || !entry.path || !entry.afterHash) continue;
      const name = path.basename(entry.path);
      if (!ARCHIVE_RE.test(name)) continue;
      const tail = tails.get(name);
      if (tail === undefined) {
        return { ok: false, entries: total, brokenAt: lineNo, detail: `Line ${lineNo} of ${label} records archive file ${name}, but that file is missing from ${this.dir}.` };
      }
      if (tail !== entry.afterHash) {
        return { ok: false, entries: total, brokenAt: lineNo, detail: `Line ${lineNo} of ${label} records archive file ${name} ending with hash ${entry.afterHash.slice(0, 12)}, but the archive's last entry has a different hash. The archive was altered.` };
      }
    }

    const files = archives.length + 1;
    return {
      ok: true,
      entries: total,
      detail: total === 0 ? 'The journal is empty; nothing to verify yet.' : `${total} entr${total === 1 ? 'y' : 'ies'} verified across ${files} file${files === 1 ? '' : 's'}; every hash links to the one before it.`,
    };
  }
}

export function createJournal(opts: JournalOptions): Journal {
  return new FileJournal(opts);
}
