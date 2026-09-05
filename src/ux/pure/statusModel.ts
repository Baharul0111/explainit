/**
 * Pure state machine behind the status-bar item and the status tree view. No `vscode` import.
 *
 * Inputs are plain values so the logic can be unit-tested with a fake clock:
 *  - heartbeats arrive from the gate (or from a loopback health probe run by the UX layer);
 *  - the gate is "not responding" when no heartbeat arrived for STALE_AFTER_MS;
 *  - right after start-up we allow a grace period so the item does not flash red before the
 *    first heartbeat.
 */

export const STALE_AFTER_MS = 15_000;
export const STARTUP_GRACE_MS = 30_000;

export type StatusState = 'armed' | 'unarmed' | 'paused' | 'not-responding' | 'starting' | 'off';
export type StatusSeverity = 'ok' | 'warning' | 'error';

export interface StatusInputs {
  paused: boolean;
  /** The gate reported a listening port. */
  gateStarted: boolean;
  /** Epoch ms of the last heartbeat, if any. */
  lastHeartbeatMs?: number;
  /** Epoch ms when the UX layer was created (start of the grace period). */
  startedAtMs: number;
  nowMs: number;
  pending: number;
  /** Resolved generation channel label ('none' when nothing is connected). */
  channel: string;
  /** Names of assistants that were detected (for the tooltip). */
  assistants: string[];
  /** Names of assistants whose checkpoint hook is installed and armed. */
  armedAgents: string[];
  /** Assistants found on this machine whose hook is NOT armed although permission was given (fresh install). */
  unarmedAgents?: string[];
  staleAfterMs?: number;
  startupGraceMs?: number;
}

export interface StatusView {
  state: StatusState;
  /** Text shown in the status bar (uses codicon syntax). */
  text: string;
  tooltip: string;
  severity: StatusSeverity;
  /** Short one-line description for the tree view and the quick pick. */
  headline: string;
}

export function computeStatus(i: StatusInputs): StatusView {
  const stale = i.staleAfterMs ?? STALE_AFTER_MS;
  const grace = i.startupGraceMs ?? STARTUP_GRACE_MS;
  const heartbeatFresh = i.lastHeartbeatMs !== undefined && i.nowMs - i.lastHeartbeatMs <= stale;
  const inGrace = i.lastHeartbeatMs === undefined && i.nowMs - i.startedAtMs < grace;

  let state: StatusState;
  if (i.paused) state = 'paused';
  else if (heartbeatFresh && (i.unarmedAgents?.length ?? 0) > 0) state = 'unarmed';
  else if (heartbeatFresh) state = 'armed';
  else if (inGrace) state = 'starting';
  else if (!i.gateStarted && i.lastHeartbeatMs === undefined) state = 'off';
  else state = 'not-responding';

  const pendingLine = i.pending > 0 ? `${i.pending} change(s) waiting for your decision.` : 'No changes waiting for review.';
  const channelLine = i.channel && i.channel !== 'none' ? `Explanations written by: ${channelLabel(i.channel)}` : 'Explanations: no assistant connected';
  const assistantsLine = i.assistants.length ? `Assistants found: ${i.assistants.join(', ')}` : 'Assistants found: none';
  const armedLine = i.armedAgents.length ? `Hooks armed for: ${i.armedAgents.join(', ')}` : 'Hooks armed for: none';

  switch (state) {
    case 'paused':
      return {
        state,
        text: '$(debug-pause) ExplainIT paused',
        severity: 'warning',
        headline: 'Checkpoint paused: assistants use their own prompts.',
        tooltip: ['ExplainIT checkpoint is paused. Assistants are using their own prompts.', 'Click for status and actions.', channelLine, assistantsLine].join('\n'),
      };
    case 'unarmed': {
      const who = (i.unarmedAgents ?? []).map(channelLabel).join(' and ');
      return {
        state,
        text: '$(shield) ExplainIT: not armed',
        severity: 'warning',
        headline: `${who} found, but the checkpoint hook is not armed: changes are not being stopped. Click to arm it.`,
        tooltip: [`The ExplainIT checkpoint is running, but ${who} can still write without approval because the hook is not installed.`, 'Click and choose "Arm the checkpoint now".', pendingLine, channelLine, assistantsLine, armedLine].join('\n'),
      };
    }
    case 'armed':
      return {
        state,
        text: i.pending > 0 ? `$(shield) ExplainIT (${i.pending})` : '$(shield) ExplainIT',
        severity: 'ok',
        headline: 'Checkpoint armed: every Claude Code and Codex change stops for your approval.',
        tooltip: ['ExplainIT checkpoint armed.', pendingLine, channelLine, assistantsLine, armedLine, 'Click for status and actions.'].join('\n'),
      };
    case 'starting':
      return {
        state,
        text: '$(shield) ExplainIT: starting',
        severity: 'ok',
        headline: 'The checkpoint is starting...',
        tooltip: ['ExplainIT is starting its local checkpoint.', channelLine, assistantsLine].join('\n'),
      };
    case 'off':
      return {
        state,
        text: '$(shield) ExplainIT: not running',
        severity: 'error',
        headline: 'The checkpoint is not running in this window.',
        tooltip: ['The ExplainIT checkpoint did not start. Reload the window and run "ExplainIT: Doctor".', channelLine].join('\n'),
      };
    default:
      return {
        state: 'not-responding',
        text: '$(shield) ExplainIT: not responding',
        severity: 'error',
        headline: 'The checkpoint has not sent a heartbeat for a while. Assistants will fall back to their own prompts.',
        tooltip: [
          `No heartbeat from the ExplainIT checkpoint for more than ${Math.round(stale / 1000)} seconds.`,
          'Assistants fall back to their own permission prompts. Reload the window, then run "ExplainIT: Doctor".',
          pendingLine,
        ].join('\n'),
      };
  }
}

export function channelLabel(channel: string): string {
  switch (channel) {
    case 'copilot':
      return 'Copilot (through VS Code)';
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'auto':
      return 'automatic';
    case 'none':
      return 'none';
    default:
      return channel;
  }
}

/** Tracks heartbeats so the status bar can tell "alive" from "stale" with a fake clock in tests. */
export class HeartbeatTracker {
  private last: number | undefined;
  private pendingCount = 0;
  constructor(private readonly staleAfterMs: number = STALE_AFTER_MS) {}
  record(nowMs: number, pending?: number): void {
    this.last = nowMs;
    if (pending !== undefined && Number.isFinite(pending)) this.pendingCount = Math.max(0, Math.floor(pending));
  }
  /** Explicit liveness report (Ux.setHeartbeat). `alive=false` marks the gate stale immediately. */
  report(alive: boolean, pending: number, nowMs: number): void {
    if (alive) this.record(nowMs, pending);
    else {
      this.last = nowMs - this.staleAfterMs - 1;
      this.pendingCount = Math.max(0, Math.floor(pending));
    }
  }
  get lastHeartbeatMs(): number | undefined {
    return this.last;
  }
  get pending(): number {
    return this.pendingCount;
  }
  isAlive(nowMs: number): boolean {
    return this.last !== undefined && nowMs - this.last <= this.staleAfterMs;
  }
}
