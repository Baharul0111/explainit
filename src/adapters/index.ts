/**
 * Factory for the AdapterManager (Claude Code, Codex, Copilot) plus the Copilot watcher.
 * This is the only file in src/adapters that touches `vscode` for host lookups.
 */
import * as vscode from 'vscode';
import { withTimeout } from '../core/cancel';
import type { AdapterManager, ArmResult, CoreDeps, DetectResult, Disposable, GateSessionInfo, InstallResult, IntegrityReport } from '../core/interfaces';
import type { StateStore } from '../core/state';
import type { AdapterState, AgentKind } from '../core/types';
import { ensureArmedWith } from './arm';
import { ClaudeAdapter } from './claude';
import { CodexAdapter } from './codex';
import { detectCopilot } from './copilotDetect';
import { HookAgentBase, installedScriptPath, makeAdapterEnv, type AdapterEnv, type HostProbe, type IntegrityCheck } from './installer';

export { createCopilotWatcher } from './copilotWatcher';

function vscodeProbe(): HostProbe {
  return {
    findExtension: (id) => {
      const e = vscode.extensions.getExtension(id);
      return e ? { path: e.extensionPath, version: String((e.packageJSON as { version?: string })?.version ?? '') } : undefined;
    },
    copilotModelCount: async () => {
      try {
        const models = await withTimeout(Promise.resolve(vscode.lm.selectChatModels({ vendor: 'copilot' })), 5000, 'listing Copilot models');
        return models.length;
      } catch {
        return undefined;
      }
    },
  };
}

export interface AdapterManagerDeps extends CoreDeps {
  state: StateStore;
  gateInfo: () => GateSessionInfo | undefined;
  disposables: Disposable[];
  /** Whether the person has granted permission to use their assistants; ensureArmed() does nothing without it. */
  consentGranted?: () => boolean;
  /** Test seam: overrides for the environment (user home, platform, probe). */
  envOverrides?: Partial<AdapterEnv>;
}

export function createAdapterManager(deps: AdapterManagerDeps): AdapterManager {
  const logger = deps.logger.child('adapters');
  const env = makeAdapterEnv({ logger, settings: deps.settings, extensionPath: deps.extensionPath, version: deps.version }, deps.state, deps.envOverrides?.probe ?? vscodeProbe(), deps.envOverrides);
  const claude = new ClaudeAdapter(env);
  const codex = new CodexAdapter(env);
  const byAgent: Record<'claude' | 'codex', HookAgentBase> = { claude, codex };

  const copilotInstall = async (install: boolean): Promise<InstallResult> => {
    await deps.state.update((s) => {
      s.adapters = s.adapters ?? {};
      if (install) s.adapters.copilot = { ...(s.adapters.copilot ?? {}), installedAt: s.adapters.copilot?.installedAt ?? new Date().toISOString() };
      else delete s.adapters.copilot;
    });
    return {
      agent: 'copilot',
      ok: true,
      changed: true,
      nextSteps: install
        ? [
            'Copilot has no way for other extensions to stop its writes. ExplainIT reviews each change right after it lands and shows "what changed" above every changed function; use Copilot\'s own Keep/Undo to decide.',
            'Run "ExplainIT: Update assistant instructions" so .github/copilot-instructions.md steers Copilot to work one function at a time.',
          ]
        : ['The Copilot review overlay is off. Turn it back on with "ExplainIT: Connect Copilot".'],
      detail: install ? 'Copilot review overlay enabled (review after landing, not a pre-write block).' : 'Copilot review overlay disabled.',
    };
  };

  const verifyIntegrity = async (): Promise<IntegrityReport> => {
    const started = Date.now();
    const checks: IntegrityCheck[] = [];
    for (const a of [claude, codex]) {
      try {
        checks.push(...a.verify());
      } catch (e) {
        checks.push({ name: `${a.agent} hook`, ok: false, fixable: false, detail: `Integrity check crashed: ${(e as Error).message}` });
      }
    }
    const report = { ok: checks.every((c) => c.ok), checks };
    logger.debug(`integrity check took ${Date.now() - started} ms`, { ok: report.ok, failing: checks.filter((c) => !c.ok).map((c) => c.name) });
    return report;
  };

  const manager: AdapterManager = {
    async detect(): Promise<DetectResult[]> {
      const safe = async (agent: AgentKind, run: () => Promise<DetectResult>): Promise<DetectResult> => {
        try {
          return await withTimeout(run(), 30_000, `${agent} detection`);
        } catch (e) {
          logger.warn(`${agent} detection failed`, e);
          return { agent, present: false, detail: `Detection failed: ${(e as Error).message}. Run "ExplainIT: Doctor" for details.` };
        }
      };
      return Promise.all([safe('claude', () => claude.detect()), safe('codex', () => codex.detect()), safe('copilot', () => detectCopilot(env))]);
    },
    install(agent) {
      if (agent === 'copilot') return copilotInstall(true);
      return byAgent[agent].install();
    },
    uninstall(agent) {
      if (agent === 'copilot') return copilotInstall(false);
      return byAgent[agent].uninstall();
    },
    verifyIntegrity,
    async rearm() {
      for (const a of [claude, codex]) {
        try {
          const changed = await a.rearm();
          if (changed) logger.info(`${a.agent} hook re-armed`);
        } catch (e) {
          logger.error(`${a.agent} rearm failed`, e);
        }
      }
      return verifyIntegrity();
    },
    async states(): Promise<AdapterState[]> {
      const gateUp = !!deps.gateInfo();
      const out: AdapterState[] = [];
      for (const a of [claude, codex]) {
        const rec = a.record();
        const installed = a.isInstalled();
        const checks = installed ? a.verify() : [];
        const failing = checks.filter((c) => !c.ok);
        out.push({
          agent: a.agent,
          installed,
          armed: installed && failing.length === 0 && gateUp,
          configHash: rec?.configHash,
          scriptHash: rec?.scriptHash,
          lastHeartbeat: gateUp ? new Date().toISOString() : undefined,
          notes: [...failing.map((c) => c.detail ?? c.name), ...(installed && !gateUp ? ['The ExplainIT checkpoint is not listening in this window.'] : [])],
        });
      }
      const cop = deps.state.read().adapters?.copilot;
      out.push({ agent: 'copilot', installed: !!cop?.installedAt, armed: false, notes: ['Copilot changes are reviewed after they land (Keep/Undo), never blocked before.'] });
      return out;
    },
    hookScriptPath: () => installedScriptPath(env),
    // Goal item 7 on a fresh machine: the checkpoint must be armed without an extra click per
    // assistant, otherwise a person who dismissed the setup list is left unprotected.
    ensureArmed: (): Promise<ArmResult> =>
      ensureArmedWith({ agents: [claude, codex], detect: () => manager.detect(), consentGranted: () => (deps.consentGranted ? deps.consentGranted() : true), logger }),
  };
  return manager;
}
