/**
 * createUx — registers every command from package.json, the status bar, the paused banner, the
 * status tree view, onboarding and the doctor. See docs/dev/CONTRACTS.md "Factories".
 */
import * as vscode from 'vscode';
import type { DoctorReport, Ux } from '../core/interfaces';
import { canonicalPath } from '../core/paths';
import { PausedBanner } from './banner';
import { registerCommands, COMMAND_IDS } from './commands';
import type { UxDeps } from './deps';
import { runDoctor as runDoctorGlue } from './doctor';
import { runOnboarding as runOnboardingGlue } from './onboarding';
import { MESSAGES } from './pure/messages';
import { Prompter } from './prompts';
import { StatusBar } from './statusBar';
import { StatusTreeProvider } from './statusView';
import { VirtualDocs } from './virtualDocs';

/** The Ux contract plus a few read-only extras used by integration tests and the status quick pick. */
export interface UxHandle extends Ux {
  /** Current status-bar text, e.g. "$(shield) ExplainIT" or "$(debug-pause) ExplainIT paused". */
  statusText(): string;
  /** The last doctor report produced in this window. */
  lastDoctorReport(): DoctorReport | undefined;
  /** Whether the person has granted permission to use their assistants (mirrors the consent store). */
  consentGranted(): boolean;
  /** Ids of the commands this module registered. */
  commandIds(): readonly string[];
  /** Whether the paused banner is currently tracked as showing. */
  bannerVisible(): boolean;
}

export { COMMAND_IDS };

export function createUx(deps: UxDeps): UxHandle {
  const logger = deps.logger.child('ux');
  const prompter = new Prompter(logger);
  const folders = (): string[] => (vscode.workspace.workspaceFolders ?? []).map((f) => canonicalPath(f.uri.fsPath));

  const virtualDocs = new VirtualDocs(logger, deps.disposables);
  const statusBar = new StatusBar({ gate: deps.gate, router: deps.router, adapters: deps.adapters, logger, disposables: deps.disposables });

  let lastReport: DoctorReport | undefined;
  let onboardingRun: Promise<void> | undefined;

  const setPaused = async (paused: boolean): Promise<void> => {
    if (!paused && !deps.settings.get('gateEnabled')) {
      // The setting would pause it again on the next start; turn it on so "resume" means resume.
      await deps.settings.set('gateEnabled', true);
      void prompter.notify(MESSAGES.resumeEnabledSetting, 'info');
    }
    await deps.state.update((s) => {
      s.checkpointPaused = paused;
    });
    // Pausing or resuming ends every "accept the rest of this file/session" (security review F3): an
    // acceptance given before the pause must not silently cover writes made after it. The gate clears
    // its own memory too; doing it here as well costs nothing and never weakens anything.
    try {
      deps.memory.clearAll();
    } catch (e) {
      logger.warn('could not clear decision memory on pause/resume', e);
    }
    deps.gate.setPaused(paused);
    banner.show(paused);
    statusBar.refresh();
    statusView.scheduleRefresh(0);
    void prompter.notify(paused ? MESSAGES.pausedConfirm : MESSAGES.resumedConfirm, paused ? 'warning' : 'info');
    logger.info(paused ? 'checkpoint paused by the person' : 'checkpoint resumed by the person');
  };

  const banner = new PausedBanner({ logger, disposables: deps.disposables, onResume: () => setPaused(false) });
  const statusView = new StatusTreeProvider({ gate: deps.gate, statusBar, kits: deps.kits, adapters: deps.adapters, logger, disposables: deps.disposables, folders });

  const runOnboarding = (opts?: { force?: boolean }): Promise<void> => {
    // Never run two onboarding flows at once (startup + command palette).
    if (onboardingRun) return onboardingRun;
    onboardingRun = runOnboardingGlue(
      { prompter, consent: deps.consent, adapters: deps.adapters, router: deps.router, instructions: deps.instructions, copilot: deps.copilot, state: deps.state, folders, logger },
      opts,
    )
      .catch((e) => logger.error('onboarding failed', e))
      .finally(() => {
        onboardingRun = undefined;
        void statusBar.refreshFacts();
      });
    return onboardingRun;
  };

  const runDoctor = async (): Promise<DoctorReport> => {
    const report = await runDoctorGlue({ ux: deps, prompter, virtualDocs, logger, folders, runOnboarding: () => runOnboarding({ force: true }), resumeCheckpoint: () => setPaused(false) });
    lastReport = report;
    return report;
  };

  registerCommands({ ux: deps, prompter, statusBar, banner, statusView, virtualDocs, logger, folders, runOnboarding, runDoctor, setPaused });

  // Keep the status bar honest when the gate is paused/resumed by someone else (settings, tests).
  deps.disposables.push(
    deps.settings.onDidChange((keys) => {
      if (keys.includes('gateEnabled') || keys.includes('channelPin')) {
        statusBar.refresh();
        void statusBar.refreshFacts();
      }
    }),
  );

  const handle: UxHandle = {
    runOnboarding,
    runDoctor,
    showPausedBanner: (paused) => {
      banner.show(paused);
      statusBar.refresh();
      statusView.scheduleRefresh(0);
    },
    setHeartbeat: (alive, pending) => statusBar.setHeartbeat(alive, pending),
    statusText: () => statusBar.text,
    lastDoctorReport: () => lastReport,
    consentGranted: () => deps.consent.granted(),
    commandIds: () => COMMAND_IDS,
    bannerVisible: () => banner.isVisible,
    dispose: () => statusBar.dispose(),
  };
  deps.disposables.push({ dispose: () => handle.dispose() });
  logger.info('ux ready');
  return handle;
}
