/**
 * Structure engine (REQ-002, REQ-012): finds every function in a document.
 * Order per call: DocumentSymbol provider (with readiness retry) -> tree-sitter WASM -> heuristics
 * -> AI segmentation (only when the caller allows it). `FunctionMap.source` says which one answered.
 */
import * as vscode from 'vscode';
import { withTimeout } from '../core/cancel';
import type { CoreDeps, Disposable, GenerationRouter, StructureEngine, StructureOptions, TextDocumentLike } from '../core/interfaces';
import type { FunctionMap, StructureSource } from '../core/types';
import { aiSegmentsToRaw } from './pure/ai';
import { heuristicFunctions } from './pure/heuristic';
import { buildFunctionMap, emptyFunctionMap, hintBasename, isNonTrivialText, splitLines, type RawFunction } from './pure/normalize';
import { symbolsToRaw, type SymbolLike } from './pure/symbols';
import { resolveWasmDir, TreeSitterService } from './pure/treeSitter';
import { createProposedDocuments } from './proposedDocs';
import { createSymbolSource } from './symbols';

export { expandToFullLines, sliceLines, functionText, splitLines, buildFunctionMap, emptyFunctionMap, textHashOf, hintBasename } from './pure/normalize';
export type { RawFunction } from './pure/normalize';
export { heuristicFunctions } from './pure/heuristic';
export { symbolsToRaw, looksLikeFunctionValue, containerLabel, SymbolKindNum } from './pure/symbols';
export { GRAMMAR_BY_LANGUAGE, DEFAULT_MAX_TEXT_CHARS, resolveWasmDir, TreeSitterService, extractFunctions } from './pure/treeSitter';
export { READINESS_DELAYS_MS, READINESS_CAP_MS, withReadinessRetry } from './pure/retry';
export { aiSegmentsToRaw } from './pure/ai';
export { PROPOSED_SCHEME } from './proposedDocs';

export interface StructureDeps extends CoreDeps {
  router?: () => GenerationRouter | undefined;
  disposables: Disposable[];
}

/** Extra handles for integration tests (not part of the StructureEngine contract). */
export interface StructureTestHooks {
  proposedCount(): number;
  isPlausible(languageId: string): boolean;
  wasmDir: string | undefined;
}

export function createStructureEngine(deps: StructureDeps): StructureEngine & { __test: StructureTestHooks } {
  const log = deps.logger.child('structure');
  const wasmDir = resolveWasmDir(deps.extensionPath);
  if (!wasmDir) log.warn('tree-sitter grammars were not found (dist/wasm is missing); languages without a symbol provider will use heuristics only');
  const treeSitter = wasmDir ? new TreeSitterService({ wasmDir, logger: log }) : undefined;
  const symbols = createSymbolSource(log);
  const proposed = createProposedDocuments(deps.disposables, log);
  let disposed = false;

  const checkCancelled = (opts?: StructureOptions): void => {
    if (opts?.token?.isCancellationRequested) throw new Error('Finding functions was cancelled before it finished.');
  };

  /** Shared pipeline. `fetchSymbols` is undefined when the symbol provider cannot be consulted. */
  const outline = async (
    text: string,
    languageId: string,
    fileUri: string,
    opts: StructureOptions | undefined,
    fetchSymbols: (() => Promise<SymbolLike[] | undefined>) | undefined,
  ): Promise<FunctionMap> => {
    const build = (source: StructureSource, raws: RawFunction[]): FunctionMap => buildFunctionMap(text, languageId, fileUri, source, raws);
    if (!text.trim().length) return emptyFunctionMap(text, languageId, fileUri, 'none');
    const started = Date.now();
    const finish = (map: FunctionMap): FunctionMap => {
      log.debug(`${map.source}: ${map.functions.length} functions for ${languageId} in ${Date.now() - started}ms`);
      return map;
    };

    // 1. Symbol provider.
    let providerAnswered = false;
    if (fetchSymbols) {
      let found: SymbolLike[] | undefined;
      try {
        found = await fetchSymbols();
      } catch (e) {
        log.debug(`symbol provider unavailable for ${languageId}: ${(e as Error).message}`);
      }
      checkCancelled(opts);
      if (found && found.length) {
        providerAnswered = true;
        let raws: RawFunction[] = [];
        try {
          raws = symbolsToRaw(found, { text });
        } catch (e) {
          // Provider output is untrusted; a broken symbol tree must not stop the fallbacks.
          log.warn(`could not read the symbols reported for ${languageId}: ${(e as Error).message}`);
        }
        if (raws.length) return finish(build('symbols', raws));
      }
    }

    // 2. tree-sitter. When the provider answered with symbols but none were functions, tree-sitter
    //    gets a chance (some providers only outline classes); an error-free empty parse confirms "no functions".
    if (treeSitter?.supports(languageId)) {
      let parsed: Awaited<ReturnType<TreeSitterService['parseFunctions']>>;
      try {
        parsed = await treeSitter.parseFunctions(text, languageId, opts?.token);
      } catch (e) {
        // parseFunctions never rejects by contract; this guard keeps the heuristics reachable regardless.
        log.warn(`tree-sitter failed for ${languageId}: ${(e as Error).message}`);
        parsed = undefined;
      }
      checkCancelled(opts);
      if (parsed) {
        if (parsed.functions.length) return finish(build('tree-sitter', parsed.functions));
        if (!parsed.hasError) return finish(build(providerAnswered ? 'symbols' : 'tree-sitter', []));
      }
    } else if (providerAnswered) {
      return finish(build('symbols', []));
    }

    // 3. Heuristics (any language).
    const heuristics = heuristicFunctions(text, languageId);
    if (heuristics.length) return finish(build('heuristic', heuristics));

    // 4. AI segmentation, only on request (it spends the person's assistant credits).
    if (opts?.allowAi && isNonTrivialText(text)) {
      const router = deps.router?.();
      if (router) {
        const timeoutMs = Math.max(10, deps.settings.get('generationTimeoutSeconds')) * 1000;
        try {
          const fileName = hintBasename(fileUri);
          const segments = await withTimeout(
            router.segmentWithAi({ fileName, languageId, text }, { token: opts.token, timeoutMs }),
            timeoutMs + 5000,
            'AI segmentation',
            opts.token,
          );
          checkCancelled(opts);
          const raws = aiSegmentsToRaw(segments, splitLines(text).length);
          if (raws.length) return finish(build('ai', raws));
        } catch (e) {
          log.warn(`AI segmentation failed for ${languageId}: ${(e as Error).message}`);
        }
      } else {
        log.debug('AI segmentation requested but no assistant is connected');
      }
    }
    return finish(emptyFunctionMap(text, languageId, fileUri, 'none'));
  };

  const engine: StructureEngine & { __test: StructureTestHooks } = {
    async getFunctionMap(doc: TextDocumentLike, opts?: StructureOptions): Promise<FunctionMap> {
      if (disposed) throw new Error('ExplainIT structure engine was disposed; reload the window to use it again.');
      const text = doc.getText();
      let uri: vscode.Uri | undefined;
      try {
        uri = vscode.Uri.parse(doc.uri);
      } catch {
        uri = undefined;
      }
      const fetchSymbols = uri ? async () => (await symbols.fetch(uri, doc.languageId, text, opts?.token)).symbols : undefined;
      return outline(text, doc.languageId, doc.uri, opts, fetchSymbols);
    },

    async getFunctionMapForText(text: string, languageId: string, uriHint: string, opts?: StructureOptions): Promise<FunctionMap> {
      if (disposed) throw new Error('ExplainIT structure engine was disposed; reload the window to use it again.');
      const canUseProvider = symbols.isPlausible(languageId) && isNonTrivialText(text);
      const fetchSymbols = canUseProvider
        ? async (): Promise<SymbolLike[] | undefined> => {
            const handle = await proposed.open(text, uriHint || 'proposed.txt', languageId, opts?.token);
            try {
              return (await symbols.fetch(handle.doc.uri, languageId, text, opts?.token)).symbols;
            } finally {
              handle.release();
            }
          }
        : undefined;
      return outline(text, languageId, uriHint, opts, fetchSymbols);
    },

    treeSitterLanguages(): string[] {
      return treeSitter?.languages() ?? [];
    },

    dispose(): void {
      disposed = true;
      treeSitter?.dispose();
      proposed.dispose();
    },

    __test: {
      proposedCount: () => proposed.count(),
      isPlausible: (languageId) => symbols.isPlausible(languageId),
      wasmDir,
    },
  };
  deps.disposables.push({ dispose: () => engine.dispose() });
  return engine;
}
