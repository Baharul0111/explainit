/**
 * "Changes and restore points" tree view (view id `explainit.journalView`) plus the one-click restore
 * flows (goal item 11). This is the vscode glue; every label comes from pure/format.ts.
 *
 * Shape: [workspace folder] > file > restore points (contextValue 'checkpoint') and journal entries.
 * With a single workspace folder the folder level is skipped. Clicking a restore point opens a diff
 * against the current file; the inline button (command `explainit.restoreCheckpoint`, registered by
 * the ux module, which calls `view.restore(item)`) brings it back. Restores are always undoable:
 * the store saves the current content as a restore point first, and the notification offers Undo.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDeps, SafetyKit } from '../core/interfaces';
import type { Logger } from '../core/log';
import type { Checkpoint, JournalEntry } from '../core/types';
import { HOME_LAYOUT, canonicalPath } from '../core/paths';
import { withTimeout } from '../core/cancel';
import { samePath } from './pure/journal';
import { describeCheckpoint, describeEntry, displayPath, entryTooltip, groupEntriesByPath, timeAgo, verdictPhrase } from './pure/format';

export const JOURNAL_VIEW_ID = 'explainit.journalView';
/** Internal command bound to a restore point's click: compare the snapshot with the current file. */
export const PREVIEW_COMMAND = 'explainit.journalView.previewCheckpoint';
const PREVIEW_SCHEME = 'explainit-restore';
const MAX_ENTRIES_SHOWN = 200;
const POLL_MS = 2500;
const RESTORE_TIMEOUT_MS = 60_000;

export type JournalNode =
  | { type: 'folder'; kit: SafetyKit; folder: string | undefined; label: string }
  | { type: 'file'; kit: SafetyKit; folder: string | undefined; path: string; entries: JournalEntry[]; checkpoints: Checkpoint[]; expanded: boolean }
  | { type: 'entry'; entry: JournalEntry }
  | { type: 'checkpoint'; kit: SafetyKit; checkpoint: Checkpoint }
  | { type: 'message'; label: string; tooltip?: string };

export class JournalTreeItem extends vscode.TreeItem {
  /** Set on restore-point items so commands receiving the item can act on it. */
  checkpointId?: string;
  constructor(readonly node: JournalNode, label: string, state: vscode.TreeItemCollapsibleState) {
    super(label, state);
  }
}

export interface JournalView extends vscode.Disposable {
  refresh(): void;
  /** Restore a tree item, a `{ checkpointId }` object, or a plain checkpoint id string. */
  restore(itemOrId: unknown): Promise<void>;
}

/** Every live view; restores from the quick pick refresh all of them. */
const liveViews = new Set<JournalView>();

function folderForKit(kit: SafetyKit): string | undefined {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const folder = canonicalPath(f.uri.fsPath);
    if (samePath(HOME_LAYOUT.journal(folder), kit.journal.file)) return folder;
  }
  return undefined;
}

function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function entryIcon(entry: JournalEntry): vscode.ThemeIcon {
  switch (entry.kind) {
    case 'proposed':
      return new vscode.ThemeIcon('inbox');
    case 'decided':
      switch (entry.decision?.verdict) {
        case 'accept':
        case 'auto':
          return new vscode.ThemeIcon('check');
        case 'partial':
          return new vscode.ThemeIcon('check-all');
        case 'reject':
          return new vscode.ThemeIcon('close');
        case 'deny-protected':
          return new vscode.ThemeIcon('shield');
        case 'paused':
          return new vscode.ThemeIcon('debug-pause');
        default:
          return new vscode.ThemeIcon('question');
      }
    case 'applied':
      return new vscode.ThemeIcon('save');
    case 'restored':
      return new vscode.ThemeIcon('history');
    default:
      return new vscode.ThemeIcon('info');
  }
}

class JournalProvider implements vscode.TreeDataProvider<JournalNode> {
  private readonly emitter = new vscode.EventEmitter<JournalNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly kits: () => SafetyKit[],
    private readonly logger: Logger,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  getTreeItem(node: JournalNode): vscode.TreeItem {
    const now = Date.now();
    switch (node.type) {
      case 'folder': {
        const item = new JournalTreeItem(node, node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.description = node.folder;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = 'folder';
        return item;
      }
      case 'file': {
        const item = new JournalTreeItem(node, displayPath(node.folder, node.path), node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        const latest = node.entries[0];
        const points = node.checkpoints.length;
        item.description = latest ? describeEntry(latest, now) : `${points} restore point${points === 1 ? '' : 's'}`;
        item.tooltip = `${node.path}\n${node.entries.length} recorded change${node.entries.length === 1 ? '' : 's'}, ${points} restore point${points === 1 ? '' : 's'}`;
        if (node.path) {
          item.resourceUri = vscode.Uri.file(node.path);
          item.iconPath = vscode.ThemeIcon.File;
        } else {
          item.iconPath = new vscode.ThemeIcon('info');
        }
        item.contextValue = 'file';
        return item;
      }
      case 'entry': {
        const item = new JournalTreeItem(node, capitalise(verdictPhrase(node.entry)), vscode.TreeItemCollapsibleState.None);
        item.description = timeAgo(node.entry.ts, now);
        item.tooltip = entryTooltip(node.entry);
        item.iconPath = entryIcon(node.entry);
        item.contextValue = 'entry';
        return item;
      }
      case 'checkpoint': {
        const d = describeCheckpoint(node.checkpoint, now);
        const item = new JournalTreeItem(node, d.label, vscode.TreeItemCollapsibleState.None);
        item.description = d.description;
        item.tooltip = d.tooltip;
        item.iconPath = new vscode.ThemeIcon('history');
        item.contextValue = 'checkpoint';
        item.checkpointId = node.checkpoint.id;
        item.command = { command: PREVIEW_COMMAND, title: 'Compare with the current file', arguments: [node.checkpoint.id] };
        return item;
      }
      case 'message': {
        const item = new JournalTreeItem(node, node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        item.tooltip = node.tooltip;
        item.contextValue = 'message';
        return item;
      }
    }
  }

  async getChildren(node?: JournalNode): Promise<JournalNode[]> {
    try {
      if (!node) {
        const kits = this.kits();
        if (kits.length === 0) return [];
        if (kits.length === 1) return this.fileNodes(kits[0], folderForKit(kits[0]), true);
        return kits.map((kit) => {
          const folder = folderForKit(kit);
          return { type: 'folder', kit, folder, label: folder ? path.basename(folder) : 'Workspace' } as JournalNode;
        });
      }
      switch (node.type) {
        case 'folder':
          return this.fileNodes(node.kit, node.folder, false);
        case 'file':
          return [
            ...node.checkpoints.map((checkpoint) => ({ type: 'checkpoint', kit: node.kit, checkpoint }) as JournalNode),
            ...node.entries.map((entry) => ({ type: 'entry', entry }) as JournalNode),
          ];
        default:
          return [];
      }
    } catch (e) {
      this.logger.error('journal view could not load', e);
      return [{ type: 'message', label: 'Could not read the change journal. Run "ExplainIT: Doctor" for details.', tooltip: (e as Error).message }];
    }
  }

  private async fileNodes(kit: SafetyKit, folder: string | undefined, root: boolean): Promise<JournalNode[]> {
    const [entries, checkpoints] = await Promise.all([kit.journal.list({ limit: MAX_ENTRIES_SHOWN }), kit.checkpoints.list()]);
    const byPath = new Map<string, { path: string; entries: JournalEntry[]; checkpoints: Checkpoint[]; latest: string }>();
    for (const g of groupEntriesByPath(entries)) {
      byPath.set(g.path, { path: g.path, entries: g.entries, checkpoints: [], latest: g.entries[0]?.ts ?? '' });
    }
    for (const cp of checkpoints) {
      const key = [...byPath.keys()].find((k) => k !== '' && samePath(k, cp.path)) ?? cp.path;
      const g = byPath.get(key) ?? { path: cp.path, entries: [], checkpoints: [], latest: '' };
      g.checkpoints.push(cp);
      if (cp.ts > g.latest) g.latest = cp.ts;
      byPath.set(key, g);
    }
    const groups = [...byPath.values()].sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
    if (groups.length === 0) {
      // At the root an empty list shows the view's welcome content (package.json viewsWelcome).
      return root ? [] : [{ type: 'message', label: 'No changes recorded yet for this folder.' }];
    }
    return groups.map((g, i) => ({ type: 'file', kit, folder, path: g.path, entries: g.entries, checkpoints: g.checkpoints, expanded: i === 0 }) as JournalNode);
  }
}

// ---------------------------------------------------------------------------------------------
// Restore flows shared by the tree view and the quick pick
// ---------------------------------------------------------------------------------------------

async function findCheckpoint(kits: SafetyKit[], id: string): Promise<{ kit: SafetyKit; checkpoint: Checkpoint; content: string } | undefined> {
  for (const kit of kits) {
    const found = await kit.checkpoints.read(id);
    if (found) return { kit, ...found };
  }
  return undefined;
}

function refreshAllViews(): void {
  for (const v of liveViews) v.refresh();
}

function testAnswers(): Record<string, unknown> {
  if (process.env.EXPLAINIT_TEST_MODE !== '1') return {};
  try {
    const parsed = JSON.parse(process.env.EXPLAINIT_TEST_ANSWERS || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function performRestore(kit: SafetyKit, checkpoint: Checkpoint, logger: Logger): Promise<void> {
  const name = path.basename(checkpoint.path);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, checkpoint.path));
  if (open?.isDirty) {
    void vscode.window.showWarningMessage(`${name} has unsaved changes in the editor. Save or discard them first, then restore again.`);
    return;
  }
  let result: { restoredPath: string; safetyCheckpointId: string };
  try {
    result = await withTimeout(kit.checkpoints.restore(checkpoint.id), RESTORE_TIMEOUT_MS, `Restoring ${name}`);
  } catch (e) {
    logger.error(`restore of ${checkpoint.id} failed`, e);
    void vscode.window.showErrorMessage(`ExplainIT could not restore ${name}: ${(e as Error).message}`);
    return;
  }
  refreshAllViews();
  const when = timeAgo(checkpoint.ts);
  const message = result.safetyCheckpointId
    ? `Restored ${name} to the version from ${when}. The content it replaced was saved as a restore point.`
    : `Restored ${name} to the version from ${when}. The file did not exist before.`;
  const actions = result.safetyCheckpointId ? ['Open file', 'Undo'] : ['Open file'];
  // Not awaited: an information toast must never block the caller (and in tests nobody clicks it).
  void vscode.window.showInformationMessage(message, ...actions).then(async (choice) => {
    try {
      if (choice === 'Open file') {
        await vscode.window.showTextDocument(vscode.Uri.file(result.restoredPath), { preview: false });
      } else if (choice === 'Undo') {
        const safety = await kit.checkpoints.read(result.safetyCheckpointId);
        if (!safety) {
          void vscode.window.showErrorMessage(`The restore point that held the previous content of ${name} is no longer available, so it cannot be undone.`);
          return;
        }
        await performRestore(kit, safety.checkpoint, logger);
      }
    } catch (e) {
      logger.error('restore follow-up failed', e);
    }
  });
}

/**
 * List the restore points for a file and restore the chosen one (ux calls this for
 * `explainit.restoreFile`). With no path, the active editor's file is used.
 */
export async function quickPickRestore(kits: SafetyKit[], filePath?: string, logger?: Logger): Promise<void> {
  const log: Logger = logger ?? silentLogger();
  const active = vscode.window.activeTextEditor?.document;
  const target = filePath ?? (active && active.uri.scheme === 'file' ? active.uri.fsPath : undefined);
  if (!target) {
    void vscode.window.showInformationMessage('Open a file (or right-click one in the Explorer) to choose a restore point for it.');
    return;
  }
  const name = path.basename(target);
  const found: { kit: SafetyKit; cp: Checkpoint }[] = [];
  const seen = new Set<string>();
  for (const kit of kits) {
    try {
      for (const cp of await kit.checkpoints.list(target)) {
        if (seen.has(cp.id)) continue;
        seen.add(cp.id);
        found.push({ kit, cp });
      }
    } catch (e) {
      log.warn('could not list restore points', e);
    }
  }
  found.sort((a, b) => (a.cp.ts < b.cp.ts ? 1 : a.cp.ts > b.cp.ts ? -1 : 0));
  if (found.length === 0) {
    void vscode.window.showInformationMessage(`No restore points for ${name} yet. ExplainIT saves one before every change it accepts.`);
    return;
  }
  const now = Date.now();
  const items = found.map(({ kit, cp }) => ({
    label: `$(history) ${timeAgo(cp.ts, now)}`,
    description: describeCheckpoint(cp, now).description,
    detail: `${cp.ts} · ${cp.id}`,
    kit,
    cp,
  }));
  let pick: (typeof items)[number] | undefined;
  const answer = testAnswers().restore;
  if (process.env.EXPLAINIT_TEST_MODE === '1') {
    // Never block a test on a quick pick: pick by index or id from EXPLAINIT_TEST_ANSWERS, else do nothing.
    if (typeof answer === 'number') pick = items[answer];
    else if (typeof answer === 'string') pick = items.find((i) => i.cp.id === answer);
    if (!pick) {
      log.info('quickPickRestore: test mode without an answer; nothing restored');
      return;
    }
  } else {
    pick = await vscode.window.showQuickPick(items, {
      title: `Restore ${name}`,
      placeHolder: 'Choose the version to bring back. What is on disk now is saved as a restore point first.',
      matchOnDescription: true,
      matchOnDetail: true,
    });
  }
  if (!pick) return;
  await performRestore(pick.kit, pick.cp, log);
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export function registerJournalView(deps: CoreDeps & { kits: () => SafetyKit[]; context: vscode.ExtensionContext }): JournalView {
  const logger = deps.logger.child('journalView');
  const disposables: vscode.Disposable[] = [];
  const provider = new JournalProvider(deps.kits, logger);
  disposables.push(provider);

  const treeView = vscode.window.createTreeView<JournalNode>(JOURNAL_VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
  disposables.push(treeView);

  // Snapshot preview: a read-only virtual document diffed against the file on disk.
  const contentEmitter = new vscode.EventEmitter<vscode.Uri>();
  disposables.push(contentEmitter);
  try {
    disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
        onDidChange: contentEmitter.event,
        async provideTextDocumentContent(uri) {
          const id = new URLSearchParams(uri.query).get('id') ?? '';
          const found = await findCheckpoint(deps.kits(), id);
          return found ? found.content : `Restore point ${id} is no longer available.`;
        },
      }),
    );
  } catch (e) {
    logger.warn('snapshot preview provider already registered', e);
  }
  try {
    disposables.push(
      vscode.commands.registerCommand(PREVIEW_COMMAND, async (arg: unknown) => {
        const id = resolveId(arg);
        if (!id) return;
        const found = await findCheckpoint(deps.kits(), id);
        if (!found) {
          void vscode.window.showErrorMessage(`Restore point ${id} was not found. It may have been removed to stay within the restore point limits. Refresh the view and choose another.`);
          return;
        }
        const name = path.basename(found.checkpoint.path);
        const left = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${name}`, query: `id=${encodeURIComponent(id)}` });
        contentEmitter.fire(left);
        if (fs.existsSync(found.checkpoint.path)) {
          await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(found.checkpoint.path), `${name}: restore point from ${timeAgo(found.checkpoint.ts)} ↔ current file`, { preview: true });
        } else {
          await vscode.window.showTextDocument(left, { preview: true });
        }
      }),
    );
  } catch (e) {
    logger.warn('snapshot preview command already registered', e);
  }

  // Keep the view fresh while it is visible, even if nobody calls refresh(): poll file mtimes (cheap, portable).
  let timer: NodeJS.Timeout | undefined;
  const stamps = new Map<string, number>();
  const poll = (): void => {
    let changed = false;
    for (const kit of deps.kits()) {
      for (const file of [kit.journal.file, path.join(path.dirname(kit.journal.file), 'checkpoints', 'index.json')]) {
        let m = -1;
        try {
          m = fs.statSync(file).mtimeMs;
        } catch {
          /* missing = -1 */
        }
        if (stamps.has(file) && stamps.get(file) !== m) changed = true;
        stamps.set(file, m);
      }
    }
    if (changed) provider.refresh();
  };
  const startPolling = (): void => {
    if (timer) return;
    poll();
    timer = setInterval(poll, POLL_MS);
  };
  const stopPolling = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  disposables.push(treeView.onDidChangeVisibility((e) => (e.visible ? startPolling() : stopPolling())));
  disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()));
  if (treeView.visible) startPolling();

  const view: JournalView = {
    refresh: () => provider.refresh(),
    async restore(itemOrId: unknown) {
      const id = resolveId(itemOrId);
      if (!id) {
        void vscode.window.showInformationMessage('Choose a restore point in the ExplainIT view, or run "ExplainIT: Restore a file from a restore point".');
        return;
      }
      const found = await findCheckpoint(deps.kits(), id);
      if (!found) {
        void vscode.window.showErrorMessage(`Restore point ${id} was not found. It may have been removed to stay within the restore point limits. Refresh the view and choose another.`);
        return;
      }
      await performRestore(found.kit, found.checkpoint, logger);
    },
    dispose() {
      stopPolling();
      liveViews.delete(view);
      for (const d of disposables.splice(0).reverse()) {
        try {
          d.dispose();
        } catch (e) {
          logger.warn('dispose failed', e);
        }
      }
    },
  };
  liveViews.add(view);
  // The ux module's `explainit.refreshJournalView` command reaches the view through this global
  // (it must not import journal internals). Removed again on dispose.
  const g = globalThis as Record<string, unknown>;
  g.__explainitJournalRefresh = () => refreshAllViews();
  disposables.push({
    dispose: () => {
      if (g.__explainitJournalRefresh && liveViews.size <= 1) delete g.__explainitJournalRefresh;
    },
  });
  if (process.env.EXPLAINIT_TEST_MODE === '1') {
    g.__explainitJournalViewTestHook = { provider, view };
  }
  return view;
}

function silentLogger(): Logger {
  const l: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => l, setLevel() {} };
  return l;
}

/** Accepts a tree item, `{ checkpointId }`, `{ id }`, a `{ node: { checkpoint } }` or a plain id. */
function resolveId(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (!arg || typeof arg !== 'object') return undefined;
  const o = arg as Record<string, unknown>;
  if (typeof o.checkpointId === 'string') return o.checkpointId;
  const node = o.node as { type?: string; checkpoint?: { id?: unknown } } | undefined;
  if (node?.type === 'checkpoint' && typeof node.checkpoint?.id === 'string') return node.checkpoint.id;
  if (o.type === 'checkpoint' && typeof (o.checkpoint as { id?: unknown })?.id === 'string') return (o.checkpoint as { id: string }).id;
  if (typeof o.id === 'string') return o.id;
  return undefined;
}
