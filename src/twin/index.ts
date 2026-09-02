/**
 * Twin engine factory (docs/dev/CONTRACTS.md "Factories"). Wires auto-open, scroll sync, staleness and
 * backfill around the engine core; every vscode disposable lands in deps.disposables.
 */
import type { CoreDeps, Disposable, GenerationRouter, StructureEngine, TwinEngine } from '../core/interfaces';
import { registerAutoOpen } from './autoOpen';
import { createBackfillController } from './backfill';
import { TwinEngineImpl } from './engine';
import { registerScrollSync } from './scrollSync';
import { registerStaleWatch } from './staleWatch';

export function createTwinEngine(deps: CoreDeps & { structure: StructureEngine; router: GenerationRouter; workspaceFolders: () => string[]; disposables: Disposable[] }): TwinEngine {
  const engine = new TwinEngineImpl(deps);
  engine.backfill = createBackfillController(engine, deps);
  registerAutoOpen(engine, deps);
  registerScrollSync(engine, deps);
  registerStaleWatch(engine, deps);
  deps.disposables.push({ dispose: () => engine.dispose() });
  return engine;
}

export { STALE_LINE, NO_FUNCTIONS_LINE, UNAVAILABLE_LINE, PENDING_LINE } from './pure/render';
export { isTwinPath, twinNameFor } from './pure/naming';
export { parseTwin } from './pure/parse';
