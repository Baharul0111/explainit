/**
 * Virtual documents for proposed (not yet on disk) content so the DocumentSymbol providers can
 * outline it. One TextDocumentContentProvider for the `explainit-proposed` scheme serves texts kept
 * in a map keyed by a random id; the entry is removed as soon as the caller releases it.
 */
import * as vscode from 'vscode';
import { withTimeout } from '../core/cancel';
import { randomId } from '../core/hash';
import type { CancelToken, Disposable } from '../core/interfaces';
import type { Logger } from '../core/log';
import { hintBasename } from './pure/normalize';

export const PROPOSED_SCHEME = 'explainit-proposed';
const OPEN_TIMEOUT_MS = 5000;

export interface ProposedDocumentHandle {
  doc: vscode.TextDocument;
  release(): void;
}

export interface ProposedDocuments {
  /** Opens a virtual document carrying `text` whose path ends like `uriHint` (so VS Code picks the language from the extension). */
  open(text: string, uriHint: string, languageId: string, token?: CancelToken): Promise<ProposedDocumentHandle>;
  /** Number of texts currently held (tests check this returns to 0). */
  count(): number;
  dispose(): void;
}

/** Basename of a uri string or path, sanitised for a virtual path; keeps the extension so the language is inferred. */
export const proposedBasename = (uriHint: string): string => hintBasename(uriHint);

export function createProposedDocuments(disposables: Disposable[], log: Logger): ProposedDocuments {
  const texts = new Map<string, string>();
  let registration: vscode.Disposable | undefined;
  const idOf = (uri: vscode.Uri): string => uri.path.split('/')[1] ?? '';

  const ensureRegistered = (): void => {
    if (registration) return;
    registration = vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
      provideTextDocumentContent: (uri) => texts.get(idOf(uri)) ?? '',
    });
    disposables.push(registration);
  };

  return {
    async open(text, uriHint, languageId, token) {
      ensureRegistered();
      const id = randomId('p');
      texts.set(id, text);
      const uri = vscode.Uri.from({ scheme: PROPOSED_SCHEME, authority: 'proposed', path: `/${id}/${proposedBasename(uriHint)}` });
      const release = (): void => {
        texts.delete(id);
      };
      try {
        let doc = await withTimeout(Promise.resolve(vscode.workspace.openTextDocument(uri)), OPEN_TIMEOUT_MS, 'opening proposed document', token);
        if (doc.languageId !== languageId) {
          try {
            doc = await withTimeout(Promise.resolve(vscode.languages.setTextDocumentLanguage(doc, languageId)), 2000, 'setting document language', token);
          } catch (e) {
            log.debug(`could not set language ${languageId} on proposed document: ${(e as Error).message}`);
          }
        }
        return { doc, release };
      } catch (e) {
        release();
        throw e;
      }
    },
    count: () => texts.size,
    dispose: () => texts.clear(),
  };
}
