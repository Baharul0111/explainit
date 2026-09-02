/**
 * Dialog helpers that respect EXPLAINIT_TEST_MODE: in test mode nothing blocks — modal questions are
 * answered from the EXPLAINIT_TEST_ANSWERS JSON env (`{"consent":"Allow"}`) or from the caller's default,
 * and notifications are still shown but never awaited.
 */
import * as vscode from 'vscode';
import type { Logger } from '../core/log';
import { isTestMode, parseTestAnswers } from './pure/parsers';

export interface AskOptions {
  message: string;
  /** Extra text shown under the message in modal dialogs (and appended for non-modal ones). */
  detail?: string;
  items: string[];
  modal?: boolean;
  severity?: 'info' | 'warning' | 'error';
  /** Answer used in test mode when EXPLAINIT_TEST_ANSWERS has no entry for the key. `undefined` = dismissed. */
  testDefault?: string;
}

export class Prompter {
  readonly testMode: boolean;
  private readonly answers: Record<string, unknown>;

  constructor(private readonly logger: Logger, env: NodeJS.ProcessEnv = process.env) {
    this.testMode = isTestMode(env);
    this.answers = parseTestAnswers(env.EXPLAINIT_TEST_ANSWERS);
  }

  /** A test-mode answer for `key`, when one is configured. */
  answerFor(key: string): unknown {
    return this.answers[key];
  }

  /** Ask a question with buttons. Resolves to the chosen button label or undefined when dismissed. */
  async ask(key: string, o: AskOptions): Promise<string | undefined> {
    if (this.testMode) {
      const configured = this.answers[key];
      const answer = typeof configured === 'string' && o.items.includes(configured) ? configured : o.testDefault;
      this.logger.debug(`test mode: auto-answering "${key}" with ${answer ?? '(dismissed)'}`);
      return answer;
    }
    const show = o.severity === 'error' ? vscode.window.showErrorMessage : o.severity === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    if (o.modal) return show(o.message, { modal: true, detail: o.detail }, ...o.items);
    return show(o.detail ? `${o.message} ${o.detail}` : o.message, ...o.items);
  }

  /** Quick pick; in test mode picks by label from the answers, else the test default. */
  async pick<T extends vscode.QuickPickItem>(key: string, items: T[], o: { placeHolder: string; title?: string; testDefault?: (items: T[]) => T | undefined }): Promise<T | undefined> {
    if (this.testMode) {
      const configured = this.answers[key];
      const byLabel = typeof configured === 'string' ? items.find((i) => i.label === configured || stripIcons(i.label) === configured) : undefined;
      const answer = byLabel ?? o.testDefault?.(items);
      this.logger.debug(`test mode: auto-picking "${key}" -> ${answer?.label ?? '(dismissed)'}`);
      return answer;
    }
    return vscode.window.showQuickPick(items, { placeHolder: o.placeHolder, title: o.title, ignoreFocusOut: true });
  }

  /** Fire-and-forget notification (never awaited, never blocks). */
  notify(message: string, severity: 'info' | 'warning' | 'error' = 'info', ...items: string[]): Thenable<string | undefined> {
    const show = severity === 'error' ? vscode.window.showErrorMessage : severity === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    this.logger.info(`notify[${severity}]: ${message}`);
    if (this.testMode) return Promise.resolve(undefined);
    return show(message, ...items);
  }
}

export function stripIcons(label: string): string {
  return label.replace(/\$\([a-z0-9-]+\)\s*/gi, '').trim();
}
