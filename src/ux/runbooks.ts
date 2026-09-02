/**
 * The five runbooks (docs/runbooks/*.md) and the quick-pick index that opens them.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../core/log';
import { msg, describeError } from './pure/messages';
import type { Prompter } from './prompts';

export interface Runbook {
  file: string;
  title: string;
  symptom: string;
}

export const RUNBOOKS: Runbook[] = [
  { file: '1-no-assistant-found.md', title: 'No assistant found', symptom: 'ExplainIT cannot find Claude Code, Codex or Copilot, or says none is connected.' },
  { file: '2-checkpoint-not-stopping-changes.md', title: 'The checkpoint is not stopping changes', symptom: 'An assistant changed a file and no review appeared.' },
  { file: '3-twin-not-opening.md', title: 'The twin is not opening', symptom: 'You open a code file and no plain-English twin appears beside it.' },
  { file: '4-explainit-not-responding.md', title: 'ExplainIT is not responding', symptom: 'The status bar is red, or an assistant says ExplainIT is unresponsive.' },
  { file: '5-restore-and-journal.md', title: 'Restore a file, or the journal fails to verify', symptom: 'You need an older version back, or the journal check reports tampering.' },
];

export function runbookPath(extensionPath: string, file: string): string {
  return path.join(extensionPath, 'docs', 'runbooks', file);
}

export async function openRunbook(extensionPath: string, file: string, logger: Logger): Promise<void> {
  const p = runbookPath(extensionPath, file);
  if (!fs.existsSync(p)) throw new Error(`the help page ${file} is missing from the extension folder`);
  const uri = vscode.Uri.file(p);
  try {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } catch (e) {
    logger.debug('markdown preview unavailable, opening as text', e);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  }
}

export async function openRunbookIndex(prompter: Prompter, extensionPath: string, logger: Logger): Promise<void> {
  const items = RUNBOOKS.map((r) => ({ label: r.title, description: r.file, detail: r.symptom, runbook: r }));
  const picked = await prompter.pick('runbook', items, { placeHolder: 'Which problem are you seeing?', title: 'ExplainIT help: the five most likely problems' });
  if (!picked) return;
  try {
    await openRunbook(extensionPath, picked.runbook.file, logger);
  } catch (e) {
    void prompter.notify(msg('runbookOpenFailed', { detail: describeError(e) }), 'error');
  }
}
