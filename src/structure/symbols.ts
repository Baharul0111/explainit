/**
 * vscode glue for the primary source: `vscode.executeDocumentSymbolProvider` with the readiness
 * retry (REQ-002). Only documents whose language plausibly has a symbol provider are retried, so a
 * language nobody outlines (no extension installed) falls through to tree-sitter without waiting.
 */
import * as vscode from 'vscode';
import { withTimeout } from '../core/cancel';
import type { CancelToken } from '../core/interfaces';
import type { Logger } from '../core/log';
import { isNonTrivialText } from './pure/normalize';
import { withReadinessRetry } from './pure/retry';
import type { SymbolLike } from './pure/symbols';

/** Languages whose symbol providers ship inside VS Code itself (always present, even with --disable-extensions). */
const BUILTIN_SYMBOL_LANGUAGES = new Set([
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'json',
  'jsonc',
  'html',
  'css',
  'scss',
  'less',
  'markdown',
]);
const PLAUSIBILITY_TTL_MS = 60_000;
/**
 * After a full retry sequence found no provider for a language, single attempts only for this long.
 * Every call still asks once, so a provider that starts later is picked up immediately; the memory
 * only stops the 5 s wait from repeating on every file of a language nobody outlines.
 */
const NO_PROVIDER_TTL_MS = 5 * 60_000;
const PER_CALL_TIMEOUT_MS = 4000;

export interface SymbolFetchResult {
  symbols: SymbolLike[] | undefined;
  attempts: number;
  elapsedMs: number;
}

export interface SymbolSource {
  fetch(uri: vscode.Uri, languageId: string, text: string, token?: CancelToken): Promise<SymbolFetchResult>;
  /** True when some installed extension (or VS Code itself) plausibly outlines this language. */
  isPlausible(languageId: string): boolean;
}

export interface SymbolSourceOptions {
  execute?: (uri: vscode.Uri) => Thenable<unknown>;
  extensions?: () => readonly { id: string; packageJSON: unknown }[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createSymbolSource(log: Logger, opts: SymbolSourceOptions = {}): SymbolSource {
  const now = opts.now ?? Date.now;
  const execute = opts.execute ?? ((uri: vscode.Uri) => vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri));
  const extensions = opts.extensions ?? (() => vscode.extensions.all);
  const plausibleCache = new Map<string, { value: boolean; until: number }>();
  const noProviderUntil = new Map<string, number>();

  const computePlausible = (languageId: string): boolean => {
    if (BUILTIN_SYMBOL_LANGUAGES.has(languageId)) return true;
    try {
      for (const ext of extensions()) {
        // Built-in "language basics" extensions only contribute grammars, never symbol providers.
        if (ext.id.startsWith('vscode.')) continue;
        const pj = ext.packageJSON as { contributes?: { languages?: { id?: string }[] }; activationEvents?: string[] } | undefined;
        const langs = pj?.contributes?.languages;
        if (Array.isArray(langs) && langs.some((l) => l && l.id === languageId)) return true;
        const events = pj?.activationEvents;
        if (Array.isArray(events) && events.includes(`onLanguage:${languageId}`)) return true;
      }
    } catch (e) {
      log.debug('could not inspect installed extensions', e);
    }
    return false;
  };

  const isPlausible = (languageId: string): boolean => {
    const cached = plausibleCache.get(languageId);
    if (cached && cached.until > now()) return cached.value;
    const value = computePlausible(languageId);
    plausibleCache.set(languageId, { value, until: now() + PLAUSIBILITY_TTL_MS });
    return value;
  };

  const fetch = async (uri: vscode.Uri, languageId: string, text: string, token?: CancelToken): Promise<SymbolFetchResult> => {
    const plausible = isPlausible(languageId);
    const shouldRetry = plausible && isNonTrivialText(text) && (noProviderUntil.get(languageId) ?? 0) < now();
    const attempt = async (remainingMs: number): Promise<SymbolLike[] | undefined> => {
      if (token?.isCancellationRequested) return undefined;
      const budget = Math.max(250, Math.min(PER_CALL_TIMEOUT_MS, remainingMs));
      try {
        const result = await withTimeout(Promise.resolve(execute(uri)), budget, 'document symbols', token);
        return Array.isArray(result) ? (result as SymbolLike[]) : undefined;
      } catch (e) {
        log.debug(`symbol provider call failed for ${languageId}: ${(e as Error).message}`);
        return undefined;
      }
    };
    const res = await withReadinessRetry(attempt, {
      isReady: (r) => Array.isArray(r) && r.length > 0,
      shouldRetry,
      token,
      now,
      sleep: opts.sleep,
    });
    if (res.result && res.result.length) noProviderUntil.delete(languageId);
    else if (shouldRetry && res.gaveUp && !token?.isCancellationRequested) noProviderUntil.set(languageId, now() + NO_PROVIDER_TTL_MS);
    log.debug(`symbols for ${languageId}: ${res.result ? res.result.length : 'none'} after ${res.attempts} attempt(s) in ${res.elapsedMs}ms`);
    return { symbols: res.result, attempts: res.attempts, elapsedMs: res.elapsedMs };
  };

  return { fetch, isPlausible };
}
