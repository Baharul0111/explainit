/**
 * The dependency bag `createUx` receives (see docs/dev/CONTRACTS.md "Factories").
 */
import type * as vscode from 'vscode';
import type {
  AdapterManager,
  ConsentStore,
  CopilotWatcher,
  CoreDeps,
  DecisionMemory,
  Disposable,
  GateServer,
  GenerationRouter,
  InstructionsGenerator,
  ProjectConsent,
  ReviewPresenter,
  SafetyKit,
  StructureEngine,
  TwinEngine,
} from '../core/interfaces';
import type { StateStore } from '../core/state';

export interface UxDeps extends CoreDeps {
  context: vscode.ExtensionContext;
  state: StateStore;
  structure: StructureEngine;
  router: GenerationRouter;
  twin: TwinEngine;
  gate: GateServer;
  review: ReviewPresenter;
  memory: DecisionMemory;
  safetyFor: (path: string) => SafetyKit | undefined;
  kits: () => SafetyKit[];
  adapters: AdapterManager;
  copilot: CopilotWatcher;
  instructions: InstructionsGenerator;
  consent: ConsentStore;
  /** Per-project permission store (ask once per project before explaining anything there). */
  projectConsent: ProjectConsent;
  disposables: Disposable[];
}
