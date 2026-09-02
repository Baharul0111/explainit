/**
 * Tree view 'explainit.statusView': checkpoint state, explanation channel, assistants, pending
 * reviews and the last decision. Refreshes on status changes (throttled) and on demand.
 */
import * as vscode from 'vscode';
import type { AdapterManager, Disposable, GateServer, SafetyKit } from '../core/interfaces';
import type { JournalEntry } from '../core/types';
import type { Logger } from '../core/log';
import { AGENT_LABEL } from './pure/doctorChecks';
import { channelLabel } from './pure/statusModel';
import type { StatusBar } from './statusBar';

export class StatusItem extends vscode.TreeItem {
  constructor(label: string, description?: string, opts: { icon?: string; command?: string; tooltip?: string; children?: StatusItem[]; contextValue?: string } = {}) {
    super(label, opts.children?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.description = description;
    if (opts.icon) this.iconPath = new vscode.ThemeIcon(opts.icon);
    if (opts.command) this.command = { command: opts.command, title: label };
    if (opts.tooltip) this.tooltip = opts.tooltip;
    this.contextValue = opts.contextValue ?? 'status';
    this.children = opts.children ?? [];
  }
  readonly children: StatusItem[];
}

export interface StatusViewDeps {
  gate: GateServer;
  statusBar: StatusBar;
  kits: () => SafetyKit[];
  adapters: AdapterManager;
  logger: Logger;
  disposables: Disposable[];
  folders: () => string[];
}

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem> {
  private readonly changed = new vscode.EventEmitter<StatusItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private lastDecision: { text: string; when: string } | undefined;
  private lastRequest: { agent: string; path: string; when: string } | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  readonly view: vscode.TreeView<StatusItem>;

  constructor(private readonly deps: StatusViewDeps) {
    this.view = vscode.window.createTreeView('explainit.statusView', { treeDataProvider: this, showCollapseAll: false });
    deps.disposables.push(this.view, this.changed, { dispose: () => this.refreshTimer && clearTimeout(this.refreshTimer) });
    deps.disposables.push(deps.statusBar.onDidChange(() => this.scheduleRefresh()));
    deps.disposables.push(
      deps.gate.onRequest((req) => {
        const first = req.writes[0]?.path ?? '';
        this.lastRequest = { agent: req.agent, path: first, when: req.receivedAt };
        this.scheduleRefresh();
      }),
    );
    // Heartbeats can be frequent; only re-read the journals when the pending count actually moves.
    let lastPending = -1;
    deps.disposables.push(
      deps.gate.onHeartbeat((hb) => {
        if (hb.pending !== lastPending) {
          lastPending = hb.pending;
          this.scheduleRefresh(500);
        }
      }),
    );
  }

  /** Coalesce bursts of events into one refresh. */
  scheduleRefresh(delayMs = 200): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delayMs);
  }

  async refresh(): Promise<void> {
    try {
      await this.loadLastDecision();
    } catch (e) {
      this.deps.logger.debug('status view: last decision unavailable', e);
    }
    this.changed.fire(undefined);
  }

  private async loadLastDecision(): Promise<void> {
    let newest: JournalEntry | undefined;
    for (const kit of this.deps.kits()) {
      const entries = await kit.journal.list({ limit: 50 }).catch(() => [] as JournalEntry[]);
      for (const e of entries) {
        if (e.kind !== 'decided' && e.kind !== 'applied') continue;
        if (!newest || e.ts > newest.ts) newest = e;
      }
    }
    if (newest) {
      const verdict = newest.decision?.verdict ?? newest.kind;
      const reason = newest.decision?.reason ? ` — ${newest.decision.reason}` : '';
      this.lastDecision = { text: `${verdict}${reason}${newest.path ? ` (${vscode.workspace.asRelativePath(newest.path)})` : ''}`, when: newest.ts };
    }
  }

  getTreeItem(el: StatusItem): vscode.TreeItem {
    return el;
  }

  getChildren(el?: StatusItem): StatusItem[] {
    if (el) return el.children;
    return this.rootItems();
  }

  rootItems(): StatusItem[] {
    const sb = this.deps.statusBar;
    const view = sb.current;
    const facts = sb.facts;
    const stateIcon = view.state === 'armed' ? 'shield' : view.state === 'paused' ? 'debug-pause' : view.state === 'starting' ? 'loading~spin' : 'warning';
    const stateLabel = view.state === 'armed' ? 'Armed' : view.state === 'paused' ? 'Paused' : view.state === 'starting' ? 'Starting' : view.state === 'off' ? 'Not running' : 'Not responding';
    const checkpoint = new StatusItem('Checkpoint', stateLabel, {
      icon: stateIcon,
      tooltip: view.headline,
      command: view.state === 'paused' ? 'explainit.resumeCheckpoint' : view.state === 'armed' ? 'explainit.pauseCheckpoint' : 'explainit.doctor',
    });
    const channel = new StatusItem('Explanations written by', facts.channel === 'none' ? 'no assistant connected' : channelLabel(facts.channel), {
      icon: 'comment-discussion',
      command: 'explainit.selectChannel',
    });
    const assistantChildren = (['claude', 'codex', 'copilot'] as const).map((a) => {
      const found = facts.assistants.includes(a);
      const armed = facts.armedAgents.includes(a);
      const desc = !found ? 'not found' : a === 'copilot' ? 'found (review after landing)' : armed ? 'found, hook armed' : 'found, hook not installed';
      return new StatusItem(AGENT_LABEL[a], desc, { icon: found ? 'check' : 'circle-slash', command: found ? undefined : 'explainit.setupAssistants' });
    });
    const assistants = new StatusItem('Assistants', facts.assistants.length ? `${facts.assistants.length} found` : 'none found', { icon: 'hubot', children: assistantChildren, command: 'explainit.setupAssistants' });
    const pending = new StatusItem('Pending reviews', facts.pending > 0 ? `${facts.pending} waiting` : 'none', { icon: facts.pending > 0 ? 'bell-dot' : 'bell' });
    const lastChildren: StatusItem[] = [];
    if (this.lastRequest) lastChildren.push(new StatusItem('Last proposal', `${this.lastRequest.agent} → ${vscode.workspace.asRelativePath(this.lastRequest.path)}`, { icon: 'git-pull-request', tooltip: this.lastRequest.when }));
    const last = new StatusItem('Last decision', this.lastDecision ? this.lastDecision.text : 'none yet', {
      icon: 'history',
      tooltip: this.lastDecision?.when,
      children: lastChildren,
      command: 'explainit.showJournal',
    });
    const doctor = new StatusItem('Run the Doctor', undefined, { icon: 'heart', command: 'explainit.doctor' });
    return [checkpoint, channel, assistants, pending, last, doctor];
  }
}
