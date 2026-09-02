import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../../../src/core/log';
import { sha256 } from '../../../src/core/hash';
import type { Checkpoint } from '../../../src/core/types';
import type { Journal } from '../../../src/core/interfaces';
import { createJournal } from '../../../src/journal/pure/journal';
import { INDEX_FILE, SELF_TEST_DIR, SNAP_EXT, atomicWriteFile, checkpointId, createCheckpointStore, planRotation, positiveOr, sortNewestFirst } from '../../../src/journal/pure/checkpoints';

const silent = createLogger([], 'test');

function cp(id: string, p: string, ts: string, size = 10): Checkpoint {
  return { id, path: p, ts, contentHash: sha256(id), size };
}

suite('checkpoints: pure helpers', () => {
  test('checkpointId is <ts>-<shortHash>, Windows-safe and content-sensitive', () => {
    const d = new Date('2026-09-02T10:11:12.345Z');
    const a = checkpointId(d, '/w/a.py', 'x');
    assert.match(a, /^2026-09-02T10-11-12-345Z-[0-9a-f]{10}$/);
    assert.notStrictEqual(a, checkpointId(d, '/w/a.py', 'y'));
    assert.notStrictEqual(a, checkpointId(d, '/w/b.py', 'x'));
    assert.strictEqual(a, checkpointId(d, '/w/a.py', 'x'));
  });

  test('sortNewestFirst orders by ts then by index position', () => {
    const list = [cp('a', '/p', '2026-01-01T00:00:00.000Z'), cp('b', '/p', '2026-01-03T00:00:00.000Z'), cp('c', '/p', '2026-01-02T00:00:00.000Z'), cp('d', '/p', '2026-01-03T00:00:00.000Z')];
    assert.deepStrictEqual(
      sortNewestFirst(list).map((c) => c.id),
      ['d', 'b', 'c', 'a'],
    );
    assert.deepStrictEqual(
      list.map((c) => c.id),
      ['a', 'b', 'c', 'd'],
      'input untouched',
    );
  });

  test('planRotation enforces the per-file cap first, then the total size cap, oldest first', () => {
    const list = [
      cp('a1', '/a', '2026-01-01T00:00:00.000Z', 100),
      cp('a2', '/a', '2026-01-02T00:00:00.000Z', 100),
      cp('a3', '/a', '2026-01-03T00:00:00.000Z', 100),
      cp('b1', '/b', '2026-01-01T12:00:00.000Z', 100),
      cp('b2', '/b', '2026-01-04T00:00:00.000Z', 100),
    ];
    const perFile = planRotation(list, 2, Infinity);
    assert.deepStrictEqual(
      perFile.remove.map((c) => c.id),
      ['a1'],
    );
    assert.deepStrictEqual(
      perFile.keep.map((c) => c.id),
      ['a2', 'a3', 'b1', 'b2'],
    );
    const sized = planRotation(list, 10, 250);
    assert.deepStrictEqual(
      sized.remove.map((c) => c.id).sort(),
      ['a1', 'a2', 'b1'],
    );
    assert.deepStrictEqual(
      sized.keep.map((c) => c.id),
      ['a3', 'b2'],
    );
    const nothing = planRotation(list, 10, 10_000);
    assert.strictEqual(nothing.remove.length, 0);
  });

  test('planRotation always keeps the newest checkpoint even when it exceeds the cap', () => {
    const list = [cp('old', '/a', '2026-01-01T00:00:00.000Z', 500), cp('new', '/a', '2026-01-02T00:00:00.000Z', 5000)];
    const r = planRotation(list, 20, 100);
    assert.deepStrictEqual(
      r.keep.map((c) => c.id),
      ['new'],
    );
    assert.strictEqual(planRotation([], 20, 0).keep.length, 0);
    const one = planRotation([cp('only', '/a', '2026-01-01T00:00:00.000Z', 5)], 0, 0);
    assert.strictEqual(one.keep.length, 1, 'maxPerFile below 1 is treated as 1');
  });
});

suite('checkpoints: store', () => {
  let root: string;
  let dir: string;
  let journal: Journal;
  let maxPerFile = 20;
  let maxTotalMB = 200;

  const store = () => createCheckpointStore({ dir, journal, maxPerFile: () => maxPerFile, maxTotalMB: () => maxTotalMB, logger: silent });

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-checkpoints-'));
    dir = path.join(root, 'home', 'checkpoints');
    journal = createJournal({ file: path.join(root, 'home', 'journal.jsonl'), logger: silent });
    maxPerFile = 20;
    maxTotalMB = 200;
  });
  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('save writes a snapshot and the index; list is newest first and filters by path', async () => {
    const s = store();
    const fileA = path.join(root, 'ws', 'a.py');
    const fileB = path.join(root, 'ws', 'b.py');
    const c1 = await s.save(fileA, 'one', { requestId: 'r1', agent: 'claude' });
    const c2 = await s.save(fileB, 'two');
    const c3 = await s.save(fileA, 'three', { agent: 'codex' });
    assert.ok(fs.existsSync(path.join(dir, c1.id + SNAP_EXT)));
    assert.strictEqual(fs.readFileSync(path.join(dir, c1.id + SNAP_EXT), 'utf8'), 'one');
    const index = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8')) as Checkpoint[];
    assert.strictEqual(index.length, 3);
    assert.strictEqual(c1.contentHash, sha256('one'));
    assert.strictEqual(c1.size, 3);
    assert.strictEqual(c1.requestId, 'r1');
    assert.strictEqual(c1.agent, 'claude');
    assert.strictEqual(c2.requestId, undefined);
    assert.ok(!('requestId' in c2), 'no undefined keys are stored');
    assert.deepStrictEqual(
      (await s.list()).map((c) => c.id),
      [c3.id, c2.id, c1.id],
    );
    assert.deepStrictEqual(
      (await s.list(fileA)).map((c) => c.id),
      [c3.id, c1.id],
    );
    assert.deepStrictEqual(await s.list(path.join(root, 'ws', 'nope.py')), []);
  });

  test('read returns the content or undefined; ids stay unique for identical saves', async () => {
    const fixed = new Date('2026-09-02T10:00:00.000Z');
    const s = createCheckpointStore({ dir, journal, logger: silent, now: () => fixed });
    const file = path.join(root, 'ws', 'a.py');
    const c1 = await s.save(file, 'same');
    const c2 = await s.save(file, 'same');
    assert.notStrictEqual(c1.id, c2.id);
    assert.strictEqual(c2.id, `${c1.id}-2`);
    const r = await s.read(c1.id);
    assert.strictEqual(r?.content, 'same');
    assert.strictEqual(r?.checkpoint.id, c1.id);
    assert.strictEqual(await s.read('missing'), undefined);
    fs.unlinkSync(path.join(dir, c2.id + SNAP_EXT));
    assert.strictEqual(await s.read(c2.id), undefined, 'index entry without a snapshot reads as missing');
  });

  test('restore saves a safety checkpoint first, writes the snapshot back and journals it', async () => {
    const s = store();
    const file = path.join(root, 'ws', 'deep', 'a.py');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'version 1\r\nline two\r\n');
    const c1 = await s.save(file, fs.readFileSync(file, 'utf8'), { agent: 'claude' });
    fs.writeFileSync(file, 'version 2');
    const r = await s.restore(c1.id);
    assert.strictEqual(r.restoredPath, c1.path);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'version 1\r\nline two\r\n', 'bytes restored exactly, line endings included');
    assert.ok(r.safetyCheckpointId);
    const safety = await s.read(r.safetyCheckpointId);
    assert.strictEqual(safety?.content, 'version 2');
    assert.strictEqual(safety?.checkpoint.contentHash, sha256('version 2'));
    assert.deepStrictEqual(
      (await s.list(file)).map((c) => c.id),
      [r.safetyCheckpointId, c1.id],
    );
    const entries = await journal.list();
    const restored = entries.find((e) => e.kind === 'restored');
    assert.ok(restored, 'journal has a restored entry');
    assert.strictEqual(restored!.checkpointId, c1.id);
    assert.strictEqual(restored!.path, c1.path);
    assert.strictEqual(restored!.beforeHash, sha256('version 2'));
    assert.strictEqual(restored!.afterHash, c1.contentHash);
    assert.ok(restored!.note!.includes(r.safetyCheckpointId));
    assert.strictEqual((await journal.verifyChain()).ok, true);
    assert.ok(!fs.readdirSync(path.dirname(file)).some((n) => n.includes('.tmp')), 'no temp files left beside the file');
  });

  test('restore recreates a deleted file (no safety checkpoint) and refuses unknown ids', async () => {
    const s = store();
    const file = path.join(root, 'ws', 'gone', 'a.py');
    const c1 = await s.save(file, 'content');
    assert.ok(!fs.existsSync(file));
    const r = await s.restore(c1.id);
    assert.strictEqual(r.safetyCheckpointId, '');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'content');
    const restored = (await journal.list()).find((e) => e.kind === 'restored');
    assert.strictEqual(restored?.beforeHash, null);
    await assert.rejects(s.restore('does-not-exist'), (e: Error) => /not found/.test(e.message) && /Refresh/.test(e.message));
  });

  test('rotation keeps at most maxPerFile per path, newest first, and deletes old snapshots', async () => {
    maxPerFile = 2;
    const s = store();
    const fileA = path.join(root, 'ws', 'a.py');
    const fileB = path.join(root, 'ws', 'b.py');
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await s.save(fileA, `a${i}`)).id);
    const b = await s.save(fileB, 'b0');
    const left = await s.list();
    assert.deepStrictEqual(
      left.map((c) => c.id).sort(),
      [ids[2], ids[3], b.id].sort(),
    );
    assert.ok(!fs.existsSync(path.join(dir, ids[0] + SNAP_EXT)));
    assert.ok(!fs.existsSync(path.join(dir, ids[1] + SNAP_EXT)));
    assert.ok(fs.existsSync(path.join(dir, ids[3] + SNAP_EXT)));
    assert.strictEqual((await s.read(ids[0])), undefined);
  });

  test('rotation enforces the total size cap across files and removes orphan snapshots', async () => {
    maxTotalMB = 120 / (1024 * 1024); // 120 bytes
    const s = store();
    const payload = 'x'.repeat(50);
    const c1 = await s.save(path.join(root, 'ws', 'a.py'), payload);
    const c2 = await s.save(path.join(root, 'ws', 'b.py'), payload);
    const c3 = await s.save(path.join(root, 'ws', 'c.py'), payload);
    const left = (await s.list()).map((c) => c.id);
    assert.deepStrictEqual(left.sort(), [c2.id, c3.id].sort());
    assert.ok(!fs.existsSync(path.join(dir, c1.id + SNAP_EXT)));

    const orphan = path.join(dir, 'orphan' + SNAP_EXT);
    fs.writeFileSync(orphan, 'stray');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(orphan, old, old);
    const fresh = path.join(dir, 'fresh' + SNAP_EXT);
    fs.writeFileSync(fresh, 'maybe mid-save');
    await s.rotate();
    assert.ok(!fs.existsSync(orphan), 'old orphan removed');
    assert.ok(fs.existsSync(fresh), 'recent orphan left alone');
  });

  test('missing or broken cap settings fall back to the defaults instead of deleting restore points', async () => {
    assert.strictEqual(positiveOr(undefined, 20), 20);
    assert.strictEqual(positiveOr(NaN, 20), 20);
    assert.strictEqual(positiveOr(0, 20), 20);
    assert.strictEqual(positiveOr(-3, 20), 20);
    assert.strictEqual(positiveOr('many', 20), 20);
    assert.strictEqual(positiveOr(7, 20), 7);
    assert.strictEqual(positiveOr('7', 20), 7);
    const s = createCheckpointStore({ dir, journal, maxPerFile: () => undefined as unknown as number, maxTotalMB: () => NaN, logger: silent });
    const file = path.join(root, 'ws', 'a.py');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await s.save(file, `v${i}`)).id);
    ids.push((await s.save(path.join(root, 'ws', 'b.py'), 'b')).id);
    await s.rotate();
    assert.deepStrictEqual((await s.list()).map((c) => c.id).sort(), ids.sort(), 'nothing was deleted');
  });

  test('restore applies the caps afterwards but always keeps the safety restore point', async () => {
    maxPerFile = 1;
    const s = store();
    const file = path.join(root, 'ws', 'a.py');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'v1');
    const c1 = await s.save(file, 'v1');
    fs.writeFileSync(file, 'v2');
    const r = await s.restore(c1.id);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'v1');
    const left = await s.list(file);
    assert.deepStrictEqual(left.map((c) => c.id), [r.safetyCheckpointId], 'only the newest (safety) restore point survives a cap of 1');
    assert.strictEqual((await s.read(r.safetyCheckpointId))?.content, 'v2', 'Undo is still possible');
    assert.ok(!fs.existsSync(path.join(dir, c1.id + SNAP_EXT)));
  });

  test('selfTest round-trips a scratch file, cleans up and never touches user files', async () => {
    const s = store();
    const userFile = path.join(root, 'ws', 'user.py');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, 'untouched');
    const before = await s.list();
    const r = await s.selfTest();
    assert.strictEqual(r.ok, true, r.detail);
    assert.match(r.detail, /verified/);
    assert.strictEqual(fs.readFileSync(userFile, 'utf8'), 'untouched');
    assert.deepStrictEqual(await s.list(), before, 'no restore points left behind');
    const scratch = path.join(dir, SELF_TEST_DIR);
    assert.deepStrictEqual(fs.existsSync(scratch) ? fs.readdirSync(scratch) : [], [], 'scratch file removed');
    assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith(SNAP_EXT)), 'no snapshots left behind');
    const entries = await journal.list();
    assert.ok(entries.some((e) => e.kind === 'system' && /self-test passed/.test(e.note ?? '')));
    assert.ok(!entries.some((e) => e.kind === 'restored'), 'the self-test does not pose as a real restore');
  });

  test('selfTest reports a failure in plain English instead of throwing', async () => {
    const s = createCheckpointStore({ dir, journal, logger: silent });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'a file where the folder should be');
    const r = await s.selfTest();
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /self-test failed/);
    assert.match(r.detail, /Doctor/);
  });

  test('a damaged index is moved aside and the store keeps working', async () => {
    const s = store();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, INDEX_FILE), '{not json');
    assert.deepStrictEqual(await s.list(), []);
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith(INDEX_FILE + '.corrupt-')));
    const c = await s.save(path.join(root, 'ws', 'a.py'), 'ok');
    assert.strictEqual((await s.read(c.id))?.content, 'ok');
  });

  test('concurrent saves and restores are serialised', async () => {
    const s = store();
    const file = path.join(root, 'ws', 'a.py');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'v0');
    const saved = await Promise.all(Array.from({ length: 10 }, (_, i) => s.save(file, `v${i}`)));
    assert.strictEqual(new Set(saved.map((c) => c.id)).size, 10);
    assert.strictEqual((await s.list(file)).length, 10);
    await Promise.all([s.restore(saved[3].id), s.restore(saved[7].id)]);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'v7');
    assert.strictEqual((await journal.verifyChain()).ok, true);
  });

  test('atomicWriteFile creates folders and leaves no temp files', async () => {
    const target = path.join(root, 'new', 'dir', 'file.txt');
    await atomicWriteFile(target, 'hello');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hello');
    await atomicWriteFile(target, 'again');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'again');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(target)), ['file.txt']);
  });
});
