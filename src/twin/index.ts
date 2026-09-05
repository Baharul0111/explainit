/**
 * Twin engine factory (docs/dev/CONTRACTS.md "Factories"). Wires auto-open, scroll sync, staleness and
 * backfill around the engine core; every vscode disposable lands in deps.disposables.
 */
import type { CoreDeps, Disposable, GenerationRouter, ProjectConsent, StructureEngine, TwinEngine } from '../core/interfaces';
import { registerAutoOpen } from './autoOpen';
import { createBackfillController } from './backfill';
import { TwinEngineImpl } from './engine';
import { createProjectGate, type ProjectGate } from './projectPermission';
import { registerScrollSync } from './scrollSync';
import { registerStaleWatch } from './staleWatch';

export interface TwinFactoryDeps extends CoreDeps {
  structure: StructureEngine;
  router: GenerationRouter;
  workspaceFolders: () => string[];
  disposables: Disposable[];
  /** Per-project permission store (ask once per project before explaining anything there). */
  projectConsent: ProjectConsent;
}

export type TwinEngineHandle = TwinEngine & { readonly projectGate: ProjectGate };

export function createTwinEngine(deps: TwinFactoryDeps): TwinEngineHandle {
  const projectGate = createProjectGate({ settings: deps.settings, consent: deps.projectConsent, workspaceFolders: deps.workspaceFolders, logger: deps.logger });
  const engine = new TwinEngineImpl({ ...deps, projectGate });
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
export { EXPLAIN_PROJECT, NOT_THIS_PROJECT, ASK_LATER, PROJECT_OFF_MESSAGE, questionFor, type ProjectGate } from './projectPermission';
