import * as assert from 'node:assert';
import { computeStatus, type StatusInputs } from '../../../src/ux/pure/statusModel';

suite('ux/pure/statusModel: "not armed" state (fresh machine)', () => {
  const base = (): StatusInputs => ({
    paused: false,
    gateStarted: true,
    lastHeartbeatMs: 10_000,
    startedAtMs: 0,
    nowMs: 12_000,
    pending: 0,
    channel: 'claude',
    assistants: ['claude', 'codex'],
    armedAgents: [],
  });

  test('an assistant that is present but not armed turns the shield into a warning with a call to action', () => {
    const v = computeStatus({ ...base(), unarmedAgents: ['claude'] });
    assert.strictEqual(v.state, 'unarmed');
    assert.strictEqual(v.severity, 'warning');
    assert.ok(v.text.includes('not armed'));
    assert.ok(v.headline.includes('Claude Code'), v.headline);
    assert.ok(v.tooltip.includes('Arm the checkpoint now'));
  });

  test('paused still wins, and no unarmed assistants means armed', () => {
    assert.strictEqual(computeStatus({ ...base(), paused: true, unarmedAgents: ['codex'] }).state, 'paused');
    assert.strictEqual(computeStatus({ ...base(), unarmedAgents: [] }).state, 'armed');
    assert.strictEqual(computeStatus(base()).state, 'armed');
  });

  test('without a fresh heartbeat the not-responding state is reported, not "not armed"', () => {
    const v = computeStatus({ ...base(), lastHeartbeatMs: 0, nowMs: 100_000, unarmedAgents: ['claude'] });
    assert.strictEqual(v.state, 'not-responding');
  });
});
