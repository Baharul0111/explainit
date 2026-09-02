/**
 * Read-only markdown documents (doctor report, journal listing) served through a
 * TextDocumentContentProvider so nothing is written into the workspace.
 */
import * as vscode from 'vscode';
import type { Disposable } from '../core/interfaces';
import type { Logger } from '../core/log';

export const VIRTUAL_SCHEME = 'explainit-doc';

export class VirtualDocs implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly logger: Logger, disposables: Disposable[]) {
    disposables.push(vscode.workspace.registerTextDocumentContentProvider(VIRTUAL_SCHEME, this), this.changed);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? 'This document is no longer available. Run the command again.';
  }

  uriFor(name: string): vscode.Uri {
    return vscode.Uri.from({ scheme: VIRTUAL_SCHEME, path: `/${name}` });
  }

  /** Store the content and open it beside the current editor (markdown preview when available). */
  async show(name: string, markdown: string, opts: { preview?: boolean; silent?: boolean } = {}): Promise<vscode.Uri> {
    const uri = this.uriFor(name);
    this.docs.set(uri.path, markdown);
    this.changed.fire(uri);
    if (opts.silent) return uri;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (opts.preview !== false) {
        try {
          await vscode.commands.executeCommand('markdown.showPreview', uri);
          return uri;
        } catch (e) {
          this.logger.debug('markdown preview unavailable, opening as text', e);
        }
      }
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    } catch (e) {
      this.logger.warn('could not open virtual document', e);
    }
    return uri;
  }
}
