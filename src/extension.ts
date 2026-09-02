/**
 * Composition root. Creates every module against the contracts in src/core/interfaces.ts and wires
 * them together. Keep this file boring: no business logic lives here.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Disposable, SafetyKit } from './core/interfaces';
import { createLogger, FileSink, defaultLogFile, type Logger } from './core/log';
import { vscodeSettings } from './core/settingsVscode';
import { createStateStore } from './core/state';
import { HOME_LAYOUT, canonicalPath, ensureDir, isInside } from './core/paths';
import { createStructureEngine } from './structure';
import { createGenerationRouter, createFileCache, createConsentStore } from './generation';
import { createTwinEngine } from './twin';
import { createGateServer } from './gate';
import { createReviewPresenter, createDecisionMemory } from './review';
import { createSafetyKit, registerJournalView } from './journal';
import { createAdapterManager, createCopilotWatcher } from './adapters';
import { createInstructionsGenerator } from './instructions';
import { createUx } from './ux';

let logger: Logger | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<ExplainitApi> {
  const disposables: Disposable[] = [];
  const pkg = context.extension.packageJSON as { version: string };

  ensureDir(HOME_LAYOUT.logs());
  const output = vscode.window.createOutputChannel('ExplainIT');
  const fileSink = new FileSink(defaultLogFile());
  const settings = vscodeSettings();
  logger = createLogger([{ write: (l) => output.appendLine(l) }, fileSink], 'explainit', settings.get('logLevel'));
  disposables.push(output, settings, { dispose: () => fileSink.dispose() });
  disposables.push(settings.onDidChange((keys) => keys.includes('logLevel') && logger?.setLevel(settings.get('logLevel'))));

  const core = { logger, settings, extensionPath: context.extensionPath, version: pkg.version };
  const state = createStateStore();
  const workspaceFolders = (): string[] => (vscode.workspace.workspaceFolders ?? []).map((f) => canonicalPath(f.uri.fsPath));

  // Safety kits: one per workspace folder (journal + restore points live outside the repo).
  const kits = new Map<string, SafetyKit>();
  const kitFor = (folder: string): SafetyKit => {
    const existing = kits.get(folder);
    if (existing) return existing;
    const created: SafetyKit = createSafetyKit({ ...core, folder });
    kits.set(folder, created);
    return created;
  };
  const safetyFor = (p: string): SafetyKit | undefined => {
    const folder = workspaceFolders().find((f) => isInside(f, p));
    return folder ? kitFor(folder) : undefined;
  };
  for (const f of workspaceFolders()) kitFor(f);
  disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => workspaceFolders().forEach(kitFor)));

  const consent = createConsentStore(state);
  const cacheFile = path.join(HOME_LAYOUT.workspace(workspaceFolders()[0] ?? context.globalStorageUri.fsPath), 'cache.json');
  const cache = createFileCache(cacheFile);
  disposables.push({ dispose: () => void cache.flush() });

  const routerBox: { router?: ReturnType<typeof createGenerationRouter> } = {};
  const structure = createStructureEngine({ ...core, router: () => routerBox.router, disposables });
  const router = createGenerationRouter({ ...core, cache, consent, disposables });
  routerBox.router = router;
  const twin = createTwinEngine({ ...core, structure, router, workspaceFolders, disposables });
  const review = createReviewPresenter({ ...core, extensionUri: context.extensionUri.toString(), disposables });
  const memory = createDecisionMemory();
  const gateInfoRef: { info?: () => ReturnType<typeof createGateServer>['info'] } = {};
  const adapters = createAdapterManager({ ...core, state, gateInfo: () => gateInfoRef.info?.(), disposables });
  const gate = createGateServer({
    ...core,
    structure,
    router,
    twin,
    review,
    memory,
    safety: kitFor(workspaceFolders()[0] ?? context.globalStorageUri.fsPath),
    safetyFor,
    adapters,
    workspaceFolders,
    disposables,
  });
  gateInfoRef.info = () => gate.info;
  const copilot = createCopilotWatcher({ ...core, structure, router, twin, disposables });
  const instructions = createInstructionsGenerator(core);

  const ux = createUx({
    ...core,
    context,
    state,
    structure,
    router,
    twin,
    gate,
    review,
    memory,
    safetyFor,
    kits: () => [...kits.values()],
    adapters,
    copilot,
    instructions,
    consent,
    disposables,
  });
  disposables.push(registerJournalView({ ...core, kits: () => [...kits.values()], context }));

  // Start the gate (kill switch state is persisted) and the Copilot overlay.
  try {
    gate.setPaused(state.read().checkpointPaused === true || !settings.get('gateEnabled'));
    await gate.start();
    logger.info(`gate listening on 127.0.0.1:${gate.info?.port}`);
  } catch (e) {
    logger.error('gate failed to start', e);
    void vscode.window.showErrorMessage('ExplainIT could not start its local checkpoint. Assistants will use their own prompts. Run "ExplainIT: Doctor" for details.');
  }
  if (settings.get('copilotWatcher')) copilot.start();
  ux.showPausedBanner(gate.paused);

  // Session-start integrity check and first-run onboarding, never blocking activation.
  void (async () => {
    try {
      const report = await adapters.verifyIntegrity();
      if (!report.ok) {
        const fixed = await adapters.rearm();
        logger.warn('adapter integrity problems found at startup', { before: report, after: fixed });
      }
      if (settings.get('instructionsAutoUpdate')) for (const f of workspaceFolders()) await instructions.ensure(f);
      for (const f of workspaceFolders()) await twin.ensureGitExclude(f);
      if (!state.read().onboardingDone) await ux.runOnboarding();
    } catch (e) {
      logger.error('startup tasks failed', e);
    }
  })();

  context.subscriptions.push({
    dispose: () => {
      for (const d of disposables.reverse()) {
        try {
          d.dispose();
        } catch (e) {
          logger?.error('dispose failed', e);
        }
      }
      void gate.stop();
    },
  });

  return { gate, twin, router, structure, adapters, ux, kits: () => [...kits.values()], review, memory, instructions, copilot, state, settings };
}

export async function deactivate(): Promise<void> {
  logger?.info('deactivating');
}

/** Exposed for integration tests (vscode.extensions.getExtension('BaharulIslam.explainit').exports). */
export interface ExplainitApi {
  gate: ReturnType<typeof createGateServer>;
  twin: ReturnType<typeof createTwinEngine>;
  router: ReturnType<typeof createGenerationRouter>;
  structure: ReturnType<typeof createStructureEngine>;
  adapters: ReturnType<typeof createAdapterManager>;
  ux: ReturnType<typeof createUx>;
  kits: () => SafetyKit[];
  review: ReturnType<typeof createReviewPresenter>;
  memory: ReturnType<typeof createDecisionMemory>;
  instructions: ReturnType<typeof createInstructionsGenerator>;
  copilot: ReturnType<typeof createCopilotWatcher>;
  state: ReturnType<typeof createStateStore>;
  settings: ReturnType<typeof vscodeSettings>;
}
