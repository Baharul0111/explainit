/**
 * First-use flow (goal item 1):
 *  1. permission screen with the verbatim consent sentence (Allow / Not now)
 *  2. detection: Copilot in VS Code / Claude Code CLI or extension / Codex CLI or extension
 *  3. one-click connect per found agent (installs the checkpoint hook, shows next steps)
 *  4. guidance with install links + "Check again" when nothing is found
 * Finally marks state.onboardingDone. Test mode auto-answers from EXPLAINIT_TEST_ANSWERS.
 */
import * as vscode from 'vscode';
import type { AdapterManager, ConsentStore, CopilotWatcher, GenerationRouter, InstructionsGenerator } from '../core/interfaces';
import type { AgentKind } from '../core/types';
import type { StateStore } from '../core/state';
import type { Logger } from '../core/log';
import { withTimeout } from '../core/cancel';
import { AGENT_LABEL } from './pure/doctorChecks';
import { CONSENT_SENTENCE, MESSAGES, msg, describeError } from './pure/messages';
import { detectionLines, INSTALL_LINKS, type DetectionLine } from './pure/render';
import type { Prompter } from './prompts';

export interface OnboardingDeps {
  prompter: Prompter;
  consent: ConsentStore;
  adapters: AdapterManager;
  router: GenerationRouter;
  instructions: InstructionsGenerator;
  copilot: CopilotWatcher;
  state: StateStore;
  folders: () => string[];
  logger: Logger;
  /** Detection calls are bounded so onboarding never hangs on a slow CLI. */
  detectTimeoutMs?: number;
}

export const ALLOW = 'Allow';
export const NOT_NOW = 'Not now';
export const CHECK_AGAIN = 'Check again';
export const DONE = 'Done';

export async function detectAll(deps: OnboardingDeps): Promise<DetectionLine[]> {
  const t = deps.detectTimeoutMs ?? 8000;
  const [detect, channels] = await Promise.all([
    withTimeout(deps.adapters.detect(), t, 'assistant detection').catch((e) => {
      deps.logger.warn('adapter detection failed', e);
      return [];
    }),
    withTimeout(deps.router.availableChannels(), t, 'channel detection').catch((e) => {
      deps.logger.warn('channel detection failed', e);
      return [];
    }),
  ]);
  return detectionLines(detect, channels);
}

/** Step 1: permission. Returns true when granted (now or earlier). */
export async function askConsent(deps: OnboardingDeps, force: boolean): Promise<boolean> {
  if (deps.consent.granted() && !force) return true;
  const answer = await deps.prompter.ask('consent', {
    message: MESSAGES.onboardingTitle,
    detail: MESSAGES.onboardingBody,
    items: [ALLOW, NOT_NOW],
    modal: true,
    testDefault: ALLOW,
  });
  if (answer === ALLOW) {
    await deps.consent.setGranted(true);
    deps.logger.info('consent granted');
    return true;
  }
  if (!deps.consent.granted()) void deps.prompter.notify(MESSAGES.onboardingDeclined, 'info');
  return deps.consent.granted();
}

/** Step 3 helper: connect one agent and show its next steps (Codex trust step spelled out). */
export async function connectAgent(deps: OnboardingDeps, agent: AgentKind): Promise<boolean> {
  const label = AGENT_LABEL[agent];
  if (agent === 'copilot') {
    const folders = deps.folders();
    for (const f of folders) await deps.instructions.ensure(f, { agents: ['copilot'] });
    if (!deps.copilot.running) deps.copilot.start();
    void deps.prompter.notify(MESSAGES.copilotSteeringDone, 'info');
    return true;
  }
  try {
    const r = await withTimeout(deps.adapters.install(agent), 20_000, `${label} hook install`);
    if (!r.ok) {
      void deps.prompter.notify(msg('onboardingConnectFailed', { agent: label, detail: r.detail ? describeError(r.detail) : 'the installer reported a problem.' }), 'error');
      return false;
    }
    const steps = [...r.nextSteps];
    if (agent === 'codex' && !steps.some((s) => /trust/i.test(s))) steps.push(MESSAGES.codexTrustStep);
    if (!steps.some((s) => /restart/i.test(s))) steps.push(msg('restartAgentStep', { agent: label }));
    const folders = deps.folders();
    for (const f of folders) await deps.instructions.ensure(f, { agents: [agent] }).catch((e) => deps.logger.warn('instructions ensure failed', e));
    void deps.prompter.notify(msg('onboardingConnected', { agent: label, steps: steps.map((s, i) => `${i + 1}. ${s}`).join(' ') }), 'info');
    return true;
  } catch (e) {
    void deps.prompter.notify(msg('onboardingConnectFailed', { agent: label, detail: describeError(e) }), 'error');
    return false;
  }
}

interface ActionItem extends vscode.QuickPickItem {
  action: 'connect' | 'copilot' | 'link' | 'again' | 'done';
  agent?: AgentKind;
  url?: string;
}

function buildItems(lines: DetectionLine[]): ActionItem[] {
  const items: ActionItem[] = [];
  const found = lines.filter((l) => l.found);
  for (const l of lines) {
    items.push({
      label: `${l.found ? '$(check)' : '$(circle-slash)'} ${l.label}`,
      description: l.found ? (l.ready ? 'found, ready' : 'found, not signed in') : 'not found',
      detail: l.detail,
      action: l.found ? (l.agent === 'copilot' ? 'copilot' : 'connect') : 'link',
      agent: l.agent,
      url: INSTALL_LINKS.find((x) => x.agent === l.agent)?.url,
      alwaysShow: true,
    });
  }
  if (found.length) {
    for (const l of found) {
      if (l.agent === 'copilot') items.push({ label: '$(plug) Set up Copilot steering', description: 'review overlay + copilot-instructions.md', action: 'copilot', agent: 'copilot', alwaysShow: true });
      else items.push({ label: `$(plug) Connect ${AGENT_LABEL[l.agent]}`, description: 'one click: installs the checkpoint hook', action: 'connect', agent: l.agent, alwaysShow: true });
    }
  } else {
    for (const link of INSTALL_LINKS) items.push({ label: `$(link-external) ${link.label}`, description: link.url, action: 'link', url: link.url, alwaysShow: true });
  }
  items.push({ label: `$(refresh) ${CHECK_AGAIN}`, description: 'look for assistants again', action: 'again', alwaysShow: true });
  items.push({ label: `$(check-all) ${DONE}`, description: 'finish setup', action: 'done', alwaysShow: true });
  return items;
}

export async function runOnboarding(deps: OnboardingDeps, opts: { force?: boolean } = {}): Promise<void> {
  const force = opts.force === true;
  deps.logger.info(`onboarding started${force ? ' (forced)' : ''}`);
  const granted = await askConsent(deps, force);
  if (!granted) {
    // The person can come back any time; do not nag on every start-up.
    await deps.state.update((s) => {
      s.onboardingDone = true;
    });
    return;
  }

  // Steps 2-4 loop: detect, offer one-click connects, or guidance + "Check again".
  const connected = new Set<AgentKind>();
  // Agents we already tried this run (success or failure): test mode must never retry a failing install
  // ten times, and a person who saw the failure message is not re-offered the same click by default.
  const attempted = new Set<AgentKind>();
  for (let round = 0; round < 10; round++) {
    void deps.prompter.notify(MESSAGES.onboardingDetecting, 'info');
    const lines = await detectAll(deps);
    const items = buildItems(lines);
    const anyFound = lines.some((l) => l.found);
    if (!anyFound) void deps.prompter.notify(MESSAGES.onboardingNothingFound, 'warning');

    const picked = await deps.prompter.pick('connect', items, {
      placeHolder: anyFound ? 'Choose an assistant to connect, or Done' : 'No assistant found. Install one, then choose "Check again".',
      title: 'ExplainIT setup: assistants on this computer',
      testDefault: (all) => {
        // Test mode: EXPLAINIT_TEST_ANSWERS.connect may name an agent ("claude"); otherwise finish.
        const want = deps.prompter.answerFor('connect');
        const agent = typeof want === 'string' && !attempted.has(want as AgentKind) ? all.find((i) => (i.action === 'connect' || i.action === 'copilot') && i.agent === want) : undefined;
        return agent ?? all.find((i) => i.action === 'done');
      },
    });
    if (!picked || picked.action === 'done') break;
    if (picked.action === 'again') continue;
    if (picked.action === 'link') {
      if (picked.url && !deps.prompter.testMode) await vscode.env.openExternal(vscode.Uri.parse(picked.url));
      continue;
    }
    if (picked.agent) {
      attempted.add(picked.agent);
      const ok = await connectAgent(deps, picked.agent);
      if (ok) connected.add(picked.agent);
    }
  }

  await deps.state.update((s) => {
    s.onboardingDone = true;
  });
  deps.logger.info(`onboarding finished; connected: ${[...connected].join(', ') || 'none'}`);
  void deps.prompter.notify(MESSAGES.onboardingDone, 'info');
}

/** Exposed so tests can assert the verbatim consent sentence is what the dialog shows. */
export function consentDialogText(): string {
  return `${MESSAGES.onboardingTitle}\n${MESSAGES.onboardingBody}`;
}

export { CONSENT_SENTENCE };
