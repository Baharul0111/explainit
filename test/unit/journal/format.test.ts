import * as assert from 'node:assert';
import * as path from 'node:path';
import type { Checkpoint, Decision, JournalEntry } from '../../../src/core/types';
import { agentName, describeCheckpoint, describeEntry, displayPath, entryTooltip, formatBytes, groupEntriesByPath, timeAgo, verdictPhrase } from '../../../src/journal/pure/format';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');

function entry(over: Partial<JournalEntry>): JournalEntry {
  return { version: 1, seq: 1, ts: '2026-09-02T11:58:00.000Z', kind: 'proposed', prevHash: '0'.repeat(64), hash: 'a'.repeat(64), ...over };
}

function decision(verdict: Decision['verdict'], extra: Partial<Decision> = {}): Decision {
  return { requestId: 'r', verdict, scope: 'one', decidedAt: 't', ...extra };
}

suite('format', () => {
  test('agentName', () => {
    assert.strictEqual(agentName('claude'), 'Claude Code');
    assert.strictEqual(agentName('codex'), 'Codex');
    assert.strictEqual(agentName('copilot'), 'Copilot');
    assert.strictEqual(agentName(undefined), 'an assistant');
  });

  test('timeAgo covers every bucket and never throws', () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    assert.strictEqual(timeAgo(at(10_000), NOW), 'just now');
    assert.strictEqual(timeAgo(at(60_000), NOW), '1 minute ago');
    assert.strictEqual(timeAgo(at(2 * 60_000), NOW), '2 minutes ago');
    assert.strictEqual(timeAgo(at(60 * 60_000), NOW), '1 hour ago');
    assert.strictEqual(timeAgo(at(5 * 3_600_000), NOW), '5 hours ago');
    assert.strictEqual(timeAgo(at(30 * 3_600_000), NOW), 'yesterday');
    assert.strictEqual(timeAgo(at(3 * 86_400_000), NOW), '3 days ago');
    assert.strictEqual(timeAgo(at(45 * 86_400_000), NOW), 'on 2026-07-19');
    assert.strictEqual(timeAgo('garbage', NOW), 'at an unknown time');
    assert.strictEqual(timeAgo(at(-60_000), NOW), 'just now', 'future timestamps clamp');
  });

  test('formatBytes', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1536), '1.5 KB');
    assert.strictEqual(formatBytes(3 * 1024 * 1024), '3.0 MB');
    assert.strictEqual(formatBytes(-1), '0 B');
    assert.strictEqual(formatBytes(NaN), '0 B');
  });

  test('verdictPhrase for every kind and verdict', () => {
    assert.strictEqual(verdictPhrase(entry({ kind: 'proposed', agent: 'claude' })), 'proposed by Claude Code');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('accept') })), 'accepted by you');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('accept', { scope: 'file' }) })), 'accepted by you (rest of file)');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('accept', { scope: 'session' }) })), 'accepted by you (rest of session)');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('reject', { reason: 'breaks login' }) })), 'rejected by you: breaks login');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('reject') })), 'rejected by you');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('partial') })), 'partly accepted by you');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('auto') })), 'accepted automatically (remembered decision)');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('auto', { scope: 'session' }) })), 'accepted automatically (rest of session)');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('deny-protected') })), 'refused: protected file');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('paused') })), 'let through (checkpoint paused)');
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided', decision: decision('ask') })), "handed to the assistant's own prompt");
    assert.strictEqual(verdictPhrase(entry({ kind: 'decided' })), 'decided');
    assert.strictEqual(verdictPhrase(entry({ kind: 'applied', agent: 'codex' })), 'written to disk for Codex');
    assert.strictEqual(verdictPhrase(entry({ kind: 'applied' })), 'written to disk');
    assert.strictEqual(verdictPhrase(entry({ kind: 'restored' })), 'restored by you from a restore point');
    assert.strictEqual(verdictPhrase(entry({ kind: 'system', note: 'rotated' })), 'ExplainIT: rotated');
    assert.strictEqual(verdictPhrase(entry({ kind: 'system' })), 'ExplainIT note');
  });

  test('describeEntry joins the phrase and the time', () => {
    assert.strictEqual(describeEntry(entry({ kind: 'decided', decision: decision('accept') }), NOW), 'accepted by you · 2 minutes ago');
  });

  test('entryTooltip lists the useful fields', () => {
    const t = entryTooltip(entry({ kind: 'decided', seq: 7, path: '/w/app.py', agent: 'claude', requestId: 'r1', beforeHash: null, afterHash: 'b'.repeat(64), checkpointId: 'cp1', decision: decision('accept') }));
    assert.match(t, /#7 decided — accepted by you/);
    assert.match(t, /File: \/w\/app\.py/);
    assert.match(t, /Assistant: Claude Code/);
    assert.match(t, /Before: \(file did not exist\)/);
    assert.match(t, /After: bbbbbbbbbbbb/);
    assert.match(t, /Restore point: cp1/);
    assert.match(t, /Entry hash: a{16}…/);
  });

  test('describeCheckpoint', () => {
    const cp: Checkpoint = { id: 'x', path: '/w/app.py', ts: '2026-09-02T11:58:00.000Z', contentHash: 'c'.repeat(64), size: 2048, agent: 'claude' };
    const d = describeCheckpoint(cp, NOW);
    assert.strictEqual(d.label, 'Restore point · 2 minutes ago');
    assert.strictEqual(d.description, '2.0 KB · before a change by Claude Code');
    assert.match(d.tooltip, /Restore point x/);
    const plain = describeCheckpoint({ ...cp, agent: undefined }, NOW);
    assert.strictEqual(plain.description, '2.0 KB · saved by ExplainIT');
  });

  test('groupEntriesByPath groups by file, most recent first, system notes separately', () => {
    const list = [
      entry({ seq: 1, path: '/w/a.py', kind: 'proposed' }),
      entry({ seq: 2, path: '/w/b.py', kind: 'proposed' }),
      entry({ seq: 3, kind: 'system', note: 'n', path: '/somewhere/archive' }),
      entry({ seq: 4, path: '/w/a.py', kind: 'decided', decision: decision('accept') }),
    ];
    const g = groupEntriesByPath(list);
    assert.deepStrictEqual(
      g.map((x) => x.path),
      ['/w/a.py', '', '/w/b.py'],
    );
    assert.deepStrictEqual(
      g[0].entries.map((e) => e.seq),
      [4, 1],
    );
    assert.deepStrictEqual(groupEntriesByPath([]), []);
  });

  test('displayPath is relative inside the folder and absolute elsewhere', () => {
    const folder = path.resolve('/w/project');
    assert.strictEqual(displayPath(folder, path.join(folder, 'src', 'app.py')), 'src/app.py');
    assert.strictEqual(displayPath(folder, path.resolve('/elsewhere/x.py')), path.resolve('/elsewhere/x.py'));
    assert.strictEqual(displayPath(undefined, path.resolve('/w/x.py')), path.resolve('/w/x.py'));
    assert.strictEqual(displayPath(folder, ''), 'ExplainIT notes');
  });
});
