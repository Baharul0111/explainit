import * as assert from 'node:assert/strict';
import { computeStatus, HeartbeatTracker, STALE_AFTER_MS, STARTUP_GRACE_MS, channelLabel, type StatusInputs } from '../../../src/ux/pure/statusModel';

function base(over: Partial<StatusInputs> = {}): StatusInputs {
  return {
    paused: false,
    gateStarted: true,
    lastHeartbeatMs: 100_000,
    startedAtMs: 0,
    nowMs: 100_000,
    pending: 0,
    channel: 'claude',
    assistants: ['claude'],
    armedAgents: ['claude'],
    ...over,
  };
}

suite('ux/pure/statusModel', () => {
  test('fresh heartbeat -> armed shield', () => {
    const v = computeStatus(base());
    assert.equal(v.state, 'armed');
    assert.equal(v.text, '$(shield) ExplainIT');
    assert.equal(v.severity, 'ok');
    assert.ok(v.tooltip.includes('armed'));
    assert.ok(v.tooltip.includes('Claude Code'));
    assert.ok(v.tooltip.includes('Hooks armed for: claude'));
  });

  test('pending count is shown in the text and tooltip', () => {
    const v = computeStatus(base({ pending: 2 }));
    assert.equal(v.text, '$(shield) ExplainIT (2)');
    assert.ok(v.tooltip.includes('2 change(s) waiting'));
  });

  test('heartbeat exactly at the stale boundary is still alive; one ms later it is not', () => {
    const at = computeStatus(base({ lastHeartbeatMs: 100_000, nowMs: 100_000 + STALE_AFTER_MS }));
    assert.equal(at.state, 'armed');
    const late = computeStatus(base({ lastHeartbeatMs: 100_000, nowMs: 100_000 + STALE_AFTER_MS + 1 }));
    assert.equal(late.state, 'not-responding');
    assert.equal(late.text, '$(shield) ExplainIT: not responding');
    assert.equal(late.severity, 'error');
    assert.ok(late.tooltip.includes('15 seconds'));
    assert.ok(late.tooltip.includes('Doctor'));
  });

  test('paused wins over everything and uses the pause icon', () => {
    const v = computeStatus(base({ paused: true, lastHeartbeatMs: undefined, gateStarted: false, nowMs: 10 ** 9 }));
    assert.equal(v.state, 'paused');
    assert.equal(v.text, '$(debug-pause) ExplainIT paused');
    assert.equal(v.severity, 'warning');
    assert.ok(v.tooltip.includes('Assistants are using their own prompts'));
  });

  test('no heartbeat yet inside the grace period -> starting (not red)', () => {
    const v = computeStatus(base({ lastHeartbeatMs: undefined, startedAtMs: 0, nowMs: STARTUP_GRACE_MS - 1 }));
    assert.equal(v.state, 'starting');
    assert.equal(v.severity, 'ok');
  });

  test('no heartbeat after the grace period with a started gate -> not responding', () => {
    const v = computeStatus(base({ lastHeartbeatMs: undefined, startedAtMs: 0, nowMs: STARTUP_GRACE_MS }));
    assert.equal(v.state, 'not-responding');
  });

  test('gate never started and no heartbeat after grace -> off', () => {
    const v = computeStatus(base({ gateStarted: false, lastHeartbeatMs: undefined, startedAtMs: 0, nowMs: STARTUP_GRACE_MS + 1 }));
    assert.equal(v.state, 'off');
    assert.equal(v.text, '$(shield) ExplainIT: not running');
    assert.equal(v.severity, 'error');
  });

  test('tooltip reflects a missing channel and no assistants', () => {
    const v = computeStatus(base({ channel: 'none', assistants: [], armedAgents: [] }));
    assert.ok(v.tooltip.includes('no assistant connected'));
    assert.ok(v.tooltip.includes('Assistants found: none'));
  });

  test('channelLabel is human', () => {
    assert.equal(channelLabel('copilot'), 'Copilot (through VS Code)');
    assert.equal(channelLabel('claude'), 'Claude Code');
    assert.equal(channelLabel('codex'), 'Codex');
    assert.equal(channelLabel('auto'), 'automatic');
    assert.equal(channelLabel('weird'), 'weird');
  });

  suite('HeartbeatTracker', () => {
    test('records heartbeats and pending counts', () => {
      const t = new HeartbeatTracker(1000);
      assert.equal(t.isAlive(0), false);
      t.record(500, 3);
      assert.equal(t.isAlive(1500), true);
      assert.equal(t.isAlive(1501), false);
      assert.equal(t.pending, 3);
      assert.equal(t.lastHeartbeatMs, 500);
    });

    test('ignores bad pending values and never goes negative', () => {
      const t = new HeartbeatTracker(1000);
      t.record(1, -4);
      assert.equal(t.pending, 0);
      t.record(2, Number.NaN);
      assert.equal(t.pending, 0);
      t.record(3, 2.9);
      assert.equal(t.pending, 2);
    });

    test('report(alive=false) marks the gate stale immediately', () => {
      const t = new HeartbeatTracker(1000);
      t.record(1000);
      t.report(false, 1, 1000);
      assert.equal(t.isAlive(1000), false);
      assert.equal(t.pending, 1);
      t.report(true, 0, 2000);
      assert.equal(t.isAlive(2000), true);
    });
  });
});
