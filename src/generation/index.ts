/**
 * Generation module entry point (REQ-005..009). Loadable in plain Node: nothing here, or in what
 * it imports at top level, requires `vscode`. The Copilot channel requires it lazily and reports
 * "unavailable" when absent.
 */
import type { ConsentStore, CoreDeps, Disposable, ExplanationCache, GenerationRouter } from '../core/interfaces';
import type { StateStore } from '../core/state';
import { createClaudeChannel } from './channels/claude';
import { createCodexChannel } from './channels/codex';
import { createLmChannel } from './channels/lm';
import { createFileCache as createFileCachePure } from './pure/cache';
import { createConsentStore as createConsentStorePure } from './pure/consent';
import { createRouter } from './router';

export { ChannelError, isChannelError, type GenerationChannel, type ChannelRequest, type ChannelResult } from './channels/types';
export { resolveCli, runCli, findOnPath, findExtensionBinary, type CliSpec } from './channels/cli';
export { promptHash, buildExplainPrompt, buildChangePrompt, buildSegmentPrompt, FENCE_RULE, BANNED_JARGON } from './pure/prompts';
export { createRouter, type RouterDeps } from './router';

export function createGenerationRouter(deps: CoreDeps & { cache: ExplanationCache; consent: ConsentStore; disposables: Disposable[] }): GenerationRouter {
  const base = { logger: deps.logger, settings: deps.settings };
  const channels = [
    createLmChannel({ ...base, consent: deps.consent, disposables: deps.disposables }),
    createClaudeChannel(base),
    createCodexChannel(base),
  ];
  return createRouter({ ...deps, channels });
}

/** JSON file cache, debounced flush, LRU capped at 20k entries. */
export function createFileCache(file: string): ExplanationCache {
  return createFileCachePure(file);
}

/** Consent flag backed by <home>/state.json. */
export function createConsentStore(state: StateStore): ConsentStore {
  return createConsentStorePure(state);
}
