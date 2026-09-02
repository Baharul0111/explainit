/**
 * Restore points (REQ-015, goal items 11 and 12). Pure Node: no `vscode` import.
 *
 * Layout under HOME_LAYOUT.checkpoints(folder):
 *   <id>.snap        raw file content exactly as it was (utf8)
 *   index.json       Checkpoint[] (the only source of truth for what exists)
 *   self-test/       scratch files for the doctor's round-trip test; never user files
 *
 * `restore(id)` first saves a safety checkpoint of what is on disk right now (when the file exists),
 * then writes the snapshot back atomically, then records a `restored` journal entry — so a restore
 * is itself undoable and witnessed. Rotation keeps <= maxPerFile per path and <= maxTotalMB overall,
 * always deleting the oldest first.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomId, sha256, shortHash } from '../../core/hash';
import { recordLanding } from '../../core/landing';
import { canonicalPath } from '../../core/paths';
import type { CheckpointStore, Journal } from '../../core/interfaces';
import type { Logger } from '../../core/log';
import type { AgentKind, Checkpoint } from '../../core/types';
import { compactTimestamp, samePath } from './journal';

export interface CheckpointStoreOptions {
  /** HOME_LAYOUT.checkpoints(folder); created on first use. */
  dir: string;
  /** Restores are witnessed here (`restored` entries) and the self-test leaves a `system` note. */
  journal: Journal;
  /** Read live so settings changes apply without restart. Defaults 20 / 200 MB. */
  maxPerFile?: () => number;
  maxTotalMB?: () => number;
  logger?: Logger;
  now?: () => Date;
}

export const INDEX_FILE = 'index.json';
export const SNAP_EXT = '.snap';
export const SELF_TEST_DIR = 'self-test';
/** Orphaned .snap files (no index entry) younger than this are left alone: they may be mid-save. */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;
/** Used when the restore point settings are missing or not positive numbers (a broken setting must never delete restore points). */
const DEFAULT_MAX_PER_FILE = 20;
const DEFAULT_MAX_TOTAL_MB = 200;

/** A live setting when it is a positive finite number, else the default. */
export function positiveOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------------------------

/** `<ts>-<shortHash>`: sortable, Windows-safe, and stable for identical content at the same instant. */
export function checkpointId(ts: Date, filePath: string, content: string): string {
  return `${compactTimestamp(ts)}-${shortHash(filePath + '\n' + content, 10)}`;
}

/** Newest first: by timestamp, then by position in the index (later saved wins ties). */
export function sortNewestFirst(list: Checkpoint[]): Checkpoint[] {
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.ts < b.c.ts ? 1 : a.c.ts > b.c.ts ? -1 : b.i - a.i))
    .map((x) => x.c);
}

/**
 * Decide what rotation removes. Per-file cap first (oldest beyond `maxPerFile` go), then the total
 * size cap (oldest overall go until the rest fits). The newest checkpoint is always kept, even when
 * it alone exceeds the size cap: one restore point beats none.
 */
export function planRotation(index: Checkpoint[], maxPerFile: number, maxTotalBytes: number): { keep: Checkpoint[]; remove: Checkpoint[] } {
  const perFile = Math.max(1, Math.floor(maxPerFile) || 1);
  const cap = Math.max(0, maxTotalBytes);
  const newestFirst = sortNewestFirst(index);
  const remove = new Set<Checkpoint>();
  const seen = new Map<string, number>();
  for (const c of newestFirst) {
    const key = process.platform === 'win32' ? c.path.toLowerCase() : c.path;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > perFile) remove.add(c);
  }
  let kept = newestFirst.filter((c) => !remove.has(c));
  let total = kept.reduce((s, c) => s + (c.size || 0), 0);
  while (total > cap && kept.length > 1) {
    const oldest = kept[kept.length - 1];
    remove.add(oldest);
    total -= oldest.size || 0;
    kept = kept.slice(0, -1);
  }
  // Keep the original index order for `keep` so the file stays append-shaped.
  return { keep: index.filter((c) => !remove.has(c)), remove: index.filter((c) => remove.has(c)) };
}

function isCheckpoint(v: unknown): v is Checkpoint {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.path === 'string' && typeof o.ts === 'string' && typeof o.contentHash === 'string' && typeof o.size === 'number';
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

/**
 * Write via a sibling temp file and rename so readers never see a half-written file. Falls back to a
 * direct write when the rename is refused (Windows can refuse to replace a file another process holds).
 */
export async function atomicWriteFile(target: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.explainit-${randomId()}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await fsp.stat(target)).mode;
  } catch {
    /* new file */
  }
  try {
    await writeFileSynced(tmp, content);
    if (mode !== undefined) {
      try {
        await fsp.chmod(tmp, mode);
      } catch {
        /* best effort */
      }
    }
    await fsp.rename(tmp, target);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => undefined);
    if ((e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EBUSY' || (e as NodeJS.ErrnoException).code === 'EACCES') {
      await writeFileSynced(target, content);
      return;
    }
    throw e;
  }
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

class FileCheckpointStore implements CheckpointStore {
  readonly dir: string;
  private readonly indexFile: string;
  private readonly journal: Journal;
  private readonly logger: Logger | undefined;
  private readonly maxPerFile: () => number;
  private readonly maxTotalMB: () => number;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: CheckpointStoreOptions) {
    this.dir = path.resolve(opts.dir);
    this.indexFile = path.join(this.dir, INDEX_FILE);
    this.journal = opts.journal;
    this.logger = opts.logger;
    this.maxPerFile = opts.maxPerFile ?? (() => DEFAULT_MAX_PER_FILE);
    this.maxTotalMB = opts.maxTotalMB ?? (() => DEFAULT_MAX_TOTAL_MB);
    this.now = opts.now ?? (() => new Date());
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  save(p: string, content: string, meta?: { requestId?: string; agent?: AgentKind }): Promise<Checkpoint> {
    return this.enqueue(async () => {
      const cp = await this.saveLocked(p, content, meta);
      await this.rotateLocked();
      return cp;
    });
  }

  list(p?: string): Promise<Checkpoint[]> {
    return this.enqueue(async () => {
      const index = await this.readIndex();
      const target = p ? canonicalPath(p) : undefined;
      return sortNewestFirst(target ? index.filter((c) => samePath(c.path, target)) : index);
    });
  }

  read(id: string): Promise<{ checkpoint: Checkpoint; content: string } | undefined> {
    return this.enqueue(() => this.readLocked(id));
  }

  restore(id: string): Promise<{ restoredPath: string; safetyCheckpointId: string }> {
    return this.enqueue(async () => {
      const r = await this.restoreLocked(id, true);
      // The safety checkpoint is a save like any other, so the caps apply after it too (the newest
      // restore point per file is always kept, so the Undo path survives rotation).
      await this.rotateLocked().catch((e) => this.logger?.warn('rotation after restore failed', e));
      return r;
    });
  }

  rotate(): Promise<void> {
    return this.enqueue(() => this.rotateLocked());
  }

  selfTest(): Promise<{ ok: boolean; detail: string }> {
    return this.enqueue(() => this.selfTestLocked());
  }

  // -- internals (always called from inside the queue) -----------------------------------------

  private snapPath(id: string): string {
    return path.join(this.dir, id + SNAP_EXT);
  }

  private async readIndex(): Promise<Checkpoint[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.indexFile, 'utf8');
    } catch (e) {
      if (errCode(e) === 'ENOENT') return [];
      throw new Error(`ExplainIT could not read the restore point index at ${this.indexFile} (${(e as Error).message}). Check the folder's permissions.`);
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(isCheckpoint);
    } catch {
      /* fall through */
    }
    // A damaged index would hide every snapshot; move it aside so the store keeps working.
    const aside = `${this.indexFile}.corrupt-${compactTimestamp(this.now())}`;
    this.logger?.error(`restore point index ${this.indexFile} is damaged; moved it to ${aside} and started a fresh index`);
    await fsp.rename(this.indexFile, aside).catch(() => undefined);
    return [];
  }

  private async writeIndex(list: Checkpoint[]): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = `${this.indexFile}.${randomId()}.tmp`;
    try {
      await writeFileSynced(tmp, JSON.stringify(list, null, 2) + '\n');
      await fsp.rename(tmp, this.indexFile);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw new Error(`ExplainIT could not update the restore point index at ${this.indexFile} (${(e as Error).message}). Check free disk space and permissions.`);
    }
  }

  private async saveLocked(p: string, content: string, meta?: { requestId?: string; agent?: AgentKind }): Promise<Checkpoint> {
    if (typeof content !== 'string') throw new Error('ExplainIT can only save text content as a restore point.');
    const target = canonicalPath(p);
    await fsp.mkdir(this.dir, { recursive: true });
    const index = await this.readIndex();
    const ts = this.now();
    let id = checkpointId(ts, target, content);
    for (let n = 2; index.some((c) => c.id === id); n++) id = `${checkpointId(ts, target, content)}-${n}`;
    const cp: Checkpoint = {
      id,
      path: target,
      ts: ts.toISOString(),
      contentHash: sha256(content),
      size: Buffer.byteLength(content, 'utf8'),
      ...(meta?.requestId ? { requestId: meta.requestId } : {}),
      ...(meta?.agent ? { agent: meta.agent } : {}),
    };
    try {
      await writeFileSynced(this.snapPath(id), content);
    } catch (e) {
      throw new Error(`ExplainIT could not save a restore point for ${path.basename(target)} (${(e as Error).message}). Check free disk space and that ${this.dir} is writable.`);
    }
    index.push(cp);
    await this.writeIndex(index);
    this.logger?.debug(`saved restore point ${id} for ${target} (${cp.size} bytes)`);
    return cp;
  }

  private async readLocked(id: string): Promise<{ checkpoint: Checkpoint; content: string } | undefined> {
    const index = await this.readIndex();
    const checkpoint = index.find((c) => c.id === id);
    if (!checkpoint) return undefined;
    try {
      const content = await fsp.readFile(this.snapPath(id), 'utf8');
      return { checkpoint, content };
    } catch (e) {
      if (errCode(e) === 'ENOENT') {
        this.logger?.warn(`restore point ${id} is in the index but its snapshot file is missing`);
        return undefined;
      }
      throw new Error(`ExplainIT could not read restore point ${id} (${(e as Error).message}).`);
    }
  }

  private async restoreLocked(id: string, witness: boolean): Promise<{ restoredPath: string; safetyCheckpointId: string }> {
    const found = await this.readLocked(id);
    if (!found) {
      throw new Error(`Restore point ${id} was not found. It may have been removed to stay within the restore point limits. Refresh the list and choose another one.`);
    }
    const target = found.checkpoint.path;
    let before: string | null = null;
    try {
      before = await fsp.readFile(target, 'utf8');
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw new Error(`ExplainIT could not read the current content of ${target} (${(e as Error).message}), so it did not restore anything.`);
    }
    let safetyCheckpointId = '';
    if (before !== null) {
      safetyCheckpointId = (await this.saveLocked(target, before)).id;
    }
    if (found.content !== before) {
      recordLanding(target);
      try {
        await atomicWriteFile(target, found.content);
      } catch (e) {
        throw new Error(`ExplainIT could not write ${target} (${(e as Error).message}). Nothing was lost: the current content is saved as restore point ${safetyCheckpointId || '(none, the file did not exist)'}.`);
      }
    }
    if (witness) {
      const name = path.basename(target);
      await this.journal.append({
        kind: 'restored',
        path: target,
        beforeHash: before === null ? null : sha256(before),
        afterHash: found.checkpoint.contentHash,
        checkpointId: id,
        note: safetyCheckpointId
          ? `Restored ${name} from restore point ${id}; the previous content was saved as restore point ${safetyCheckpointId}.`
          : `Restored ${name} from restore point ${id}; the file did not exist before.`,
      });
    }
    this.logger?.info(`restored ${target} from ${id}${safetyCheckpointId ? ` (previous content saved as ${safetyCheckpointId})` : ''}`);
    return { restoredPath: target, safetyCheckpointId };
  }

  private async removeLocked(ids: Iterable<string>): Promise<void> {
    const gone = new Set(ids);
    if (gone.size === 0) return;
    const index = await this.readIndex();
    await this.writeIndex(index.filter((c) => !gone.has(c.id)));
    for (const id of gone) await fsp.unlink(this.snapPath(id)).catch(() => undefined);
  }

  private async rotateLocked(): Promise<void> {
    const index = await this.readIndex();
    const { keep, remove } = planRotation(index, positiveOr(this.maxPerFile(), DEFAULT_MAX_PER_FILE), positiveOr(this.maxTotalMB(), DEFAULT_MAX_TOTAL_MB) * 1024 * 1024);
    if (remove.length > 0) {
      await this.writeIndex(keep);
      for (const c of remove) await fsp.unlink(this.snapPath(c.id)).catch(() => undefined);
      this.logger?.info(`rotated restore points: removed ${remove.length}, kept ${keep.length}`);
    }
    // Snapshots without an index entry (a crash between the two writes) would leak disk space.
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    const known = new Set(keep.map((c) => c.id + SNAP_EXT));
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    for (const name of names) {
      if (!name.endsWith(SNAP_EXT) || known.has(name)) continue;
      const file = path.join(this.dir, name);
      try {
        const st = await fsp.stat(file);
        if (st.mtimeMs < cutoff) await fsp.unlink(file);
      } catch {
        /* ignore */
      }
    }
  }

  private async selfTestLocked(): Promise<{ ok: boolean; detail: string }> {
    const scratch = path.join(this.dir, SELF_TEST_DIR);
    const file = path.join(scratch, `probe-${randomId()}.txt`);
    const original = `ExplainIT restore self-test\noriginal content ${randomId()}\n`;
    const modified = `ExplainIT restore self-test\nmodified content ${randomId()}\n`;
    const created: string[] = [];
    try {
      await fsp.mkdir(scratch, { recursive: true });
      await fsp.writeFile(file, original, 'utf8');
      const cp = await this.saveLocked(file, original);
      created.push(cp.id);
      if (cp.contentHash !== sha256(original)) throw new Error('the saved restore point recorded a different hash than the file content');
      await fsp.writeFile(file, modified, 'utf8');
      const r = await this.restoreLocked(cp.id, false);
      if (r.safetyCheckpointId) created.push(r.safetyCheckpointId);
      const after = await fsp.readFile(file, 'utf8');
      if (after !== original) throw new Error('the file did not contain the restored content');
      if (sha256(after) !== cp.contentHash) throw new Error('the restored content does not match the recorded hash');
      const safety = await this.readLocked(r.safetyCheckpointId);
      if (!safety) throw new Error('no safety restore point was saved before restoring');
      if (safety.content !== modified || safety.checkpoint.contentHash !== sha256(modified)) throw new Error('the safety restore point does not hold the content that was on disk before the restore');
      await this.journal.append({ kind: 'system', note: 'Restore self-test passed: saved a restore point for a scratch file, changed the file, restored it, and verified the content and hashes.' });
      return { ok: true, detail: 'Saved a restore point for a scratch file inside the ExplainIT folder, changed the file, restored it, and verified the content and hashes match. No workspace file was touched.' };
    } catch (e) {
      this.logger?.error('restore self-test failed', e);
      return { ok: false, detail: `The restore self-test failed: ${(e as Error).message}. Check that ${this.dir} is writable and the disk has free space, then run the Doctor again.` };
    } finally {
      await this.removeLocked(created).catch(() => undefined);
      await fsp.unlink(file).catch(() => undefined);
    }
  }
}

export function createCheckpointStore(opts: CheckpointStoreOptions): CheckpointStore & { readonly dir: string } {
  return new FileCheckpointStore(opts);
}
