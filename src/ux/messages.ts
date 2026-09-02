/**
 * Public entry for the message catalog (the catalog itself lives in pure/ so unit tests can load it
 * without `vscode`).
 */
export { MESSAGES, CONSENT_SENTENCE, FORBIDDEN_WORDS, msg, placeholdersOf, describeError } from './pure/messages';
export type { MessageKey } from './pure/messages';
