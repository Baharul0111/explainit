/**
 * Automatic arming (goal item 7 on a fresh machine): install the checkpoint hook for every Claude Code
 * / Codex found on this computer, without a click per assistant. Pure orchestration over the hook
 * adapters, no `vscode` import, so it is unit-tested against temp homes.
 */
import { withTimeout } from '../core/cancel';
import type { ArmResult, DetectResult, InstallResult } from '../core/interfaces';
import type { Logger } from '../core/log';
import type { AgentKind } from '../core/types';

export interface ArmableAgent {
  agent: AgentKind;
  isInstalled(): boolean;
  /** Integrity checks; a failing check that is not fixable (e.g. Codex trust, which only the person can grant) does not call for a reinstall. */
  verify(): { ok: boolean; fixable?: boolean }[];
  install(): Promise<InstallResult>;
}

/** Installed with every fixable check green: reinstalling would change nothing. */
export function isArmed(a: ArmableAgent): boolean {
  return a.isInstalled() && a.verify().every((c) => c.ok || c.fixable === false);
}

export interface ArmDeps {
  agents: ArmableAgent[];
  detect(): Promise<DetectResult[]>;
  consentGranted(): boolean;
  logger: Logger;
  installTimeoutMs?: number;
}

const LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot' };

export async function ensureArmedWith(deps: ArmDeps): Promise<ArmResult> {
  const out: ArmResult = { armed: [], alreadyArmed: [], failed: [], skipped: [], nextSteps: [] };
  if (!deps.consentGranted()) {
    out.skipped.push('Permission to use your assistants has not been given yet. Run "ExplainIT: Set up assistants".');
    return out;
  }
  let detected: DetectResult[] = [];
  try {
    detected = await deps.detect();
  } catch (e) {
    out.skipped.push(`Could not look for assistants: ${(e as Error).message}`);
    return out;
  }
  for (const a of deps.agents) {
    const found = detected.find((d) => d.agent === a.agent);
    if (!found?.present) {
      out.skipped.push(`${LABEL[a.agent]} was not found on this computer.`);
      continue;
    }
    try {
      if (isArmed(a)) {
        out.alreadyArmed.push(a.agent);
        continue;
      }
      const r = await withTimeout(a.install(), deps.installTimeoutMs ?? 20_000, `${LABEL[a.agent]} hook install`);
      if (r.ok) {
        out.armed.push(a.agent);
        out.nextSteps.push(...r.nextSteps);
        deps.logger.info(`${a.agent} checkpoint hook installed automatically`);
      } else {
        out.failed.push({ agent: a.agent, detail: r.detail ?? 'the installer reported a problem.' });
      }
    } catch (e) {
      out.failed.push({ agent: a.agent, detail: (e as Error).message });
      deps.logger.warn(`automatic ${a.agent} hook install failed`, e);
    }
  }
  if (detected.find((d) => d.agent === 'copilot')?.present) {
    out.skipped.push('Copilot cannot be stopped before it writes; ExplainIT reviews its changes after they land.');
  }
  return out;
}
