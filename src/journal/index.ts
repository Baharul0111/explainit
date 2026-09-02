/**
 * Journal & safety module (REQ-015, goal items 11 and 12): a tamper-evident change journal and
 * restore points per workspace folder, plus the "Changes and restore points" view.
 *
 * Files live outside the repo under HOME_LAYOUT.workspace(folder) so agents can never edit them
 * (the gate hard-denies writes under the ExplainIT home).
 */
import type { CoreDeps, SafetyKit } from '../core/interfaces';
import { HOME_LAYOUT } from '../core/paths';
import { createCheckpointStore } from './pure/checkpoints';
import { createJournal } from './pure/journal';

export function createSafetyKit(deps: CoreDeps & { folder: string }): SafetyKit {
  const logger = deps.logger.child('journal');
  const journal = createJournal({
    file: HOME_LAYOUT.journal(deps.folder),
    maxEntries: () => deps.settings.get('journalMaxEntries'),
    logger,
  });
  const checkpoints = createCheckpointStore({
    dir: HOME_LAYOUT.checkpoints(deps.folder),
    journal,
    maxPerFile: () => deps.settings.get('checkpointsMaxPerFile'),
    maxTotalMB: () => deps.settings.get('checkpointsMaxTotalMB'),
    logger: logger.child('checkpoints'),
  });
  return { journal, checkpoints };
}

export { registerJournalView, quickPickRestore, JOURNAL_VIEW_ID, PREVIEW_COMMAND } from './treeView';
export type { JournalView, JournalNode, JournalTreeItem } from './treeView';
