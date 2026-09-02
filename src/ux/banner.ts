/**
 * Persistent "checkpoint is paused" banner. While paused a warning notification with a Resume button
 * stays up; if the person dismisses it, it comes back the next time the window gains focus, so a
 * paused checkpoint is never forgotten.
 */
import * as vscode from 'vscode';
import type { Disposable } from '../core/interfaces';
import type { Logger } from '../core/log';
import { MESSAGES } from './pure/messages';
import { isTestMode } from './pure/parsers';

export const RESUME_LABEL = 'Resume';

export class PausedBanner {
  private paused = false;
  private visible = false;
  /** Increments on every show/hide so a stale notification's answer is ignored. */
  private generation = 0;
  readonly shownCount = { value: 0 };

  constructor(
    private readonly deps: { logger: Logger; disposables: Disposable[]; onResume: () => Promise<void>; testMode?: boolean },
  ) {
    deps.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && this.paused && !this.visible) this.present();
      }),
    );
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  show(paused: boolean): void {
    if (paused === this.paused && (!paused || this.visible)) return;
    this.paused = paused;
    this.generation++;
    if (paused) this.present();
    else this.visible = false; // VS Code has no API to close a notification; the next answer is ignored via generation.
  }

  private present(): void {
    const gen = this.generation;
    this.visible = true;
    this.shownCount.value++;
    this.deps.logger.info('showing paused banner');
    const testMode = this.deps.testMode ?? isTestMode();
    if (testMode) {
      // No dialogs in test mode; the banner state is still tracked so tests can assert it.
      this.visible = false;
      return;
    }
    void vscode.window.showWarningMessage(MESSAGES.pausedBanner, RESUME_LABEL).then(
      async (choice) => {
        if (gen !== this.generation) return;
        this.visible = false;
        if (choice === RESUME_LABEL) {
          try {
            await this.deps.onResume();
          } catch (e) {
            this.deps.logger.error('resume from banner failed', e);
          }
        }
      },
      () => {
        this.visible = false;
      },
    );
  }
}
