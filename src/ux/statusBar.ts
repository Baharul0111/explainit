/**
 * Status-bar item: "$(shield) ExplainIT" fed by gate heartbeats. Turns red when no heartbeat arrived
 * for 15 s, shows "$(debug-pause) ExplainIT paused" while the kill switch is on, and opens the
 * status quick pick on click. Also runs a loopback health probe when heartbeats stop, so a gate
 * that is alive but idle is never reported as dead.
 */
import * as vscode from 'vscode';
import type { AdapterManager, Disposable, GateServer, GenerationRouter } from '../core/interfaces';
import type { Logger } from '../core/log';
import { withTimeout } from '../core/cancel';
import { probeHealth } from './pure/health';
import { computeStatus, HeartbeatTracker, STALE_AFTER_MS, type StatusView } from './pure/statusModel';

/** Upper bound for the slow-changing facts refresh (CLI detection can spawn processes). */
export const FACTS_TIMEOUT_MS = 8_000;

export interface StatusBarDeps {
  gate: GateServer;
  router: GenerationRouter;
  adapters: AdapterManager;
  logger: Logger;
  disposables: Disposable[];
  /** Injected for tests. */
  now?: () => number;
  /** How often to re-evaluate (ms). */
  tickMs?: number;
}

export class StatusBar {
  readonly item: vscode.StatusBarItem;
  readonly tracker = new HeartbeatTracker(STALE_AFTER_MS);
  private readonly startedAt: number;
  private readonly onChange = new vscode.EventEmitter<StatusView>();
  readonly onDidChange = this.onChange.event;
  private view: StatusView;
  private channel = 'none';
  private assistants: string[] = [];
  private armedAgents: string[] = [];
  private probing = false;
  private lastFactsRefresh = 0;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly deps: StatusBarDeps) {
    this.startedAt = this.now();
    this.item = vscode.window.createStatusBarItem('explainit.status', vscode.StatusBarAlignment.Left, 50);
    this.item.name = 'ExplainIT';
    this.item.command = 'explainit.showStatus';
    this.view = this.compute();
    this.apply();
    this.item.show();
    deps.disposables.push(this.item, this.onChange);
    deps.disposables.push(deps.gate.onHeartbeat((hb) => this.onHeartbeat(hb)));
    this.timer = setInterval(() => void this.tick(), deps.tickMs ?? 5000);
    deps.disposables.push({ dispose: () => this.dispose() });
    void this.refreshFacts();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Current status-bar text (for tests and the status quick pick). */
  get text(): string {
    return this.view.text;
  }

  get current(): StatusView {
    return this.view;
  }

  get facts(): { channel: string; assistants: string[]; armedAgents: string[]; pending: number } {
    return { channel: this.channel, assistants: this.assistants, armedAgents: this.armedAgents, pending: this.tracker.pending };
  }

  private onHeartbeat(hb: { ts: string; pending: number }): void {
    const t = Date.parse(hb.ts);
    this.tracker.record(Number.isFinite(t) ? Math.max(t, this.now() - 1000) : this.now(), hb.pending);
    this.refresh();
  }

  /** Ux.setHeartbeat: an explicit liveness report from outside. */
  setHeartbeat(alive: boolean, pending: number): void {
    this.tracker.report(alive, pending, this.now());
    this.refresh();
  }

  /** Re-evaluate now (after pause/resume, channel change, etc.). */
  refresh(): void {
    if (this.disposed) return;
    const next = this.compute();
    const changed = next.text !== this.view.text || next.tooltip !== this.view.tooltip || next.state !== this.view.state;
    this.view = next;
    if (changed) {
      this.apply();
      this.onChange.fire(next);
    }
  }

  private compute(): StatusView {
    return computeStatus({
      paused: this.deps.gate.paused,
      gateStarted: this.deps.gate.info !== undefined,
      lastHeartbeatMs: this.tracker.lastHeartbeatMs,
      startedAtMs: this.startedAt,
      nowMs: this.now(),
      pending: this.tracker.pending,
      channel: this.channel,
      assistants: this.assistants,
      armedAgents: this.armedAgents,
    });
  }

  private apply(): void {
    this.item.text = this.view.text;
    this.item.tooltip = this.view.tooltip;
    this.item.backgroundColor =
      this.view.severity === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : this.view.severity === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    // Heartbeats may be sparse while the gate is idle: before going red, ask the gate directly.
    const info = this.deps.gate.info;
    if (info && !this.tracker.isAlive(this.now()) && !this.probing) {
      this.probing = true;
      try {
        const r = await probeHealth(info.port, 2000);
        if (r.ok) this.tracker.record(this.now());
      } catch (e) {
        this.deps.logger.debug('health probe failed', e);
      } finally {
        this.probing = false;
      }
    }
    if (this.now() - this.lastFactsRefresh > 60_000) void this.refreshFacts();
    this.refresh();
  }

  /** Slow-changing facts for the tooltip: channel and assistants. Never throws. */
  async refreshFacts(): Promise<void> {
    this.lastFactsRefresh = this.now();
    try {
      // Detection may spawn the assistant CLIs; bound every call so a stuck CLI never wedges the status bar.
      const t = FACTS_TIMEOUT_MS;
      const [channel, detect, states] = await Promise.all([
        withTimeout(this.deps.router.resolveChannel(), t, 'channel resolution').catch(() => 'none' as const),
        withTimeout(this.deps.adapters.detect(), t, 'assistant detection').catch(() => []),
        withTimeout(this.deps.adapters.states(), t, 'adapter states').catch(() => []),
      ]);
      this.channel = channel;
      this.assistants = detect.filter((d) => d.present).map((d) => d.agent);
      this.armedAgents = states.filter((s) => s.installed && s.armed).map((s) => s.agent);
    } catch (e) {
      this.deps.logger.debug('status facts refresh failed', e);
    }
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
