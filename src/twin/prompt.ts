/**
 * Dialog helpers. In EXPLAINIT_TEST_MODE nothing blocks: answers come from the EXPLAINIT_TEST_ANSWERS
 * JSON env (`{ "<question id>": "<button label>" }`), falling back to the given default.
 *
 * Question ids used by the twin module:
 *   twin.backfillConfirm   -> "Start backfill" | anything else = cancel   (test default: start)
 *   twin.sharedGitignore   -> "Add to .gitignore" | "Not now"              (test default: Not now)
 */
import * as vscode from 'vscode';

export function isTestMode(): boolean {
  return process.env.EXPLAINIT_TEST_MODE === '1';
}

export function testAnswer(id: string): string | undefined {
  const raw = process.env.EXPLAINIT_TEST_ANSWERS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed?.[id];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Modal confirmation. Returns the chosen label, or undefined when dismissed/cancelled. */
export async function askModal(id: string, message: string, detail: string | undefined, items: string[], testDefault: string | undefined): Promise<string | undefined> {
  if (isTestMode()) return testAnswer(id) ?? testDefault;
  const picked = await vscode.window.showInformationMessage(message, { modal: true, detail }, ...items);
  return picked;
}

/** Non-blocking information message with buttons. */
export async function askInfo(id: string, message: string, items: string[], testDefault: string | undefined): Promise<string | undefined> {
  if (isTestMode()) return testAnswer(id) ?? testDefault;
  return vscode.window.showInformationMessage(message, ...items);
}

/** Fire-and-forget notices; suppressed in test mode so test runs stay quiet. */
export function notice(kind: 'info' | 'warn' | 'error', message: string): void {
  if (isTestMode()) return;
  if (kind === 'info') void vscode.window.showInformationMessage(message);
  else if (kind === 'warn') void vscode.window.showWarningMessage(message);
  else void vscode.window.showErrorMessage(message);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
