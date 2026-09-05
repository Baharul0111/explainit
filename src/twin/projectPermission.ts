/**
 * Per-project permission glue for the twin engine: before ExplainIT explains anything in a workspace
 * folder it asks once ("Explain this project?"), remembers the answer, and never asks again for that
 * folder. A refused project gets no twins, no auto-open, no backfill and no instruction files.
 * The checkpoint does not go through here: it protects every project.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProjectConsent, ProjectDecision } from '../core/interfaces';
import type { Logger } from '../core/log';
import type { Settings } from '../core/settings';

export const EXPLAIN_PROJECT = 'Explain this project';
export const NOT_THIS_PROJECT = 'Not this project';
export const ASK_LATER = 'Ask me later';

/** After a dismissed question, wait this long before asking again in the same window. */
export const REASK_COOLDOWN_MS = 5 * 60_000;

export const PROJECT_OFF_MESSAGE =
  'ExplainIT is turned off for this project. Run "ExplainIT: Allow or stop explanations for this project" to turn it on.';

export interface ProjectGate {
  /** Canonical workspace folder for a file, if it is inside one. */
  folderOf(fsPath: string): string | undefined;
  /** Decision for the folder holding fsPath. Files outside every workspace folder are not a project: 'allowed'. */
  status(fsPath: string): ProjectDecision;
  /** True when explaining may go ahead. Asks once (with a cooldown) when the decision is unknown and `ask` is set. */
  ensureAllowed(fsPath: string, opts?: { ask?: boolean }): Promise<boolean>;
  /** Ask (or ask again) for a folder, e.g. from the command palette. */
  ask(folder: string): Promise<ProjectDecision>;
}

export function questionFor(folderName: string): string {
  return `Explain the code in "${folderName}"? ExplainIT would write a plain-English twin beside each code file you open here (kept out of git) using the assistant you already have. The checkpoint protects this project either way.`;
}

/** Test mode reads the answer from EXPLAINIT_TEST_ANSWERS ({"projectPermission":"Not this project"}), default: explain. */
export function testModeAnswer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.EXPLAINIT_TEST_MODE !== '1') return undefined;
  try {
    const parsed = JSON.parse(env.EXPLAINIT_TEST_ANSWERS || '{}') as Record<string, unknown>;
    const v = parsed.projectPermission;
    return typeof v === 'string' && [EXPLAIN_PROJECT, NOT_THIS_PROJECT, ASK_LATER].includes(v) ? v : EXPLAIN_PROJECT;
  } catch {
    return EXPLAIN_PROJECT;
  }
}

export function createProjectGate(deps: { settings: Settings; consent: ProjectConsent; workspaceFolders: () => string[]; logger: Logger }): ProjectGate {
  const log = deps.logger.child('twin:project');
  const pending = new Map<string, Promise<ProjectDecision>>();
  const lastAsked = new Map<string, number>();

  const folderOf = (fsPath: string): string | undefined => deps.consent.folderFor(fsPath, deps.workspaceFolders());

  // A recorded or cleared decision ends any cooldown: the next open may ask again right away.
  deps.consent.onDidChange((e) => lastAsked.delete(e.folder));

  const status = (fsPath: string): ProjectDecision => {
    const folder = folderOf(fsPath);
    if (!folder) return 'allowed';
    const s = deps.consent.status(folder);
    if (s === 'unknown' && deps.settings.get('twinProjectPermission') === 'always') return 'allowed';
    return s;
  };

  const askPerson = async (folderName: string): Promise<string | undefined> => {
    const auto = testModeAnswer();
    if (auto !== undefined) {
      log.debug(`test mode: project permission for "${folderName}" auto-answered "${auto}"`);
      return auto;
    }
    return vscode.window.showInformationMessage(questionFor(folderName), EXPLAIN_PROJECT, NOT_THIS_PROJECT, ASK_LATER);
  };

  const ask = (folder: string): Promise<ProjectDecision> => {
    const inflight = pending.get(folder);
    if (inflight) return inflight;
    const p = (async (): Promise<ProjectDecision> => {
      lastAsked.set(folder, Date.now());
      const answer = await askPerson(path.basename(folder) || folder);
      if (answer === EXPLAIN_PROJECT) {
        await deps.consent.set(folder, 'allowed');
        log.info(`explanations allowed for ${folder}`);
        return 'allowed';
      }
      if (answer === NOT_THIS_PROJECT) {
        await deps.consent.set(folder, 'denied');
        log.info(`explanations refused for ${folder}`);
        return 'denied';
      }
      return 'unknown';
    })().finally(() => pending.delete(folder));
    pending.set(folder, p);
    return p;
  };

  return {
    folderOf,
    status,
    ask,
    async ensureAllowed(fsPath, opts) {
      const s = status(fsPath);
      if (s === 'allowed') return true;
      if (s === 'denied') return false;
      if (!opts?.ask) return false;
      const folder = folderOf(fsPath);
      if (!folder) return true;
      const last = lastAsked.get(folder);
      if (last !== undefined && Date.now() - last < REASK_COOLDOWN_MS && !pending.has(folder)) return false;
      return (await ask(folder)) === 'allowed';
    },
  };
}
