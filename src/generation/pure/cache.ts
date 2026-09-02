/**
 * Content-hash explanation cache (REQ-008): one JSON file, contentHash -> Explanation.
 *  - loaded lazily on first access; a missing or corrupt file starts empty (never throws)
 *  - writes are debounced (500 ms) and `flush()` is awaitable for deactivate / tests
 *  - LRU capped at MAX_ENTRIES: a Map keeps insertion order, `get` re-inserts to mark recent use
 *  - the file is written atomically (tmp + rename) so a crash mid-write never corrupts it
 * No `vscode` import.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Explanation } from '../../core/types';
import type { ExplanationCache } from '../../core/interfaces';

export const CACHE_MAX_ENTRIES = 20_000;
export const CACHE_FLUSH_DEBOUNCE_MS = 500;
const CACHE_VERSION = 1;

interface CacheFileShape {
  version: number;
  entries: Record<string, Explanation>;
}

function looksLikeExplanation(v: unknown): v is Explanation {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.summary === 'string' && Array.isArray(o.steps) && o.steps.every((s) => typeof s === 'string');
}

export interface FileCacheOptions {
  maxEntries?: number;
  debounceMs?: number;
  /** Called when a corrupt file is ignored (router logs it). */
  onWarning?: (msg: string) => void;
}

export function createFileCache(file: string, opts: FileCacheOptions = {}): ExplanationCache & { dispose(): void; readonly file: string } {
  const maxEntries = Math.max(1, opts.maxEntries ?? CACHE_MAX_ENTRIES);
  const debounceMs = opts.debounceMs ?? CACHE_FLUSH_DEBOUNCE_MS;
  let map: Map<string, Explanation> | undefined;
  let dirty = false;
  let timer: NodeJS.Timeout | undefined;
  let writing: Promise<void> = Promise.resolve();

  const load = (): Map<string, Explanation> => {
    if (map) return map;
    map = new Map();
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CacheFileShape>;
      const entries = parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : undefined;
      if (!entries) {
        if (raw.trim()) opts.onWarning?.(`Explanation cache at ${file} had an unexpected shape and was reset.`);
        return map;
      }
      for (const [hash, exp] of Object.entries(entries)) {
        if (typeof hash === 'string' && looksLikeExplanation(exp)) map.set(hash, exp);
      }
      // A file that grew past the cap under an older build is trimmed to the most recent entries.
      while (map.size > maxEntries) map.delete(map.keys().next().value as string);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        opts.onWarning?.(`Explanation cache at ${file} could not be read and was reset: ${(e as Error).message}`);
      }
    }
    return map;
  };

  const writeNow = async (): Promise<void> => {
    if (!dirty) return;
    dirty = false;
    const m = load();
    const shape: CacheFileShape = { version: CACHE_VERSION, entries: Object.fromEntries(m) };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(shape), 'utf8');
    try {
      await fs.promises.rename(tmp, file);
    } catch (e) {
      // Windows can refuse rename over a file another process is reading; fall back to a direct write.
      try {
        await fs.promises.writeFile(file, JSON.stringify(shape), 'utf8');
      } finally {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      }
      if (!(e as NodeJS.ErrnoException).code) throw e;
    }
  };

  const schedule = (): void => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      writing = writing.then(writeNow).catch((e) => opts.onWarning?.(`Explanation cache could not be saved: ${(e as Error).message}`));
    }, debounceMs);
    timer.unref?.();
  };

  const api = {
    file,
    get(hash: string): Explanation | undefined {
      const m = load();
      const v = m.get(hash);
      if (v === undefined) return undefined;
      // LRU touch: move to the end.
      m.delete(hash);
      m.set(hash, v);
      return v;
    },
    has(hash: string): boolean {
      return load().has(hash);
    },
    set(hash: string, explanation: Explanation): void {
      if (!hash || !looksLikeExplanation(explanation)) return;
      const m = load();
      m.delete(hash);
      m.set(hash, explanation);
      while (m.size > maxEntries) m.delete(m.keys().next().value as string);
      schedule();
    },
    size(): number {
      return load().size;
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      writing = writing.then(writeNow).catch((e) => {
        opts.onWarning?.(`Explanation cache could not be saved: ${(e as Error).message}`);
        throw e;
      });
      try {
        await writing;
      } finally {
        writing = writing.catch(() => undefined);
      }
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      void api.flush().catch(() => undefined);
    },
  };
  return api;
}
