import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../../../src/core/log';
import { canonicalJson, sha256 } from '../../../src/core/hash';
import type { JournalEntry } from '../../../src/core/types';
import {
  ARCHIVE_RE,
  GENESIS_HASH,
  compactTimestamp,
  createJournal,
  hashEntry,
  parseJournalText,
  samePath,
  stripHash,
  verifyLines,
} from '../../../src/journal/pure/journal';

const silent = createLogger([], 'test');

function readLines(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

function readEntries(file: string): JournalEntry[] {
  return readLines(file).map((l) => JSON.parse(l) as JournalEntry);
}

function archivesIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((n) => ARCHIVE_RE.test(n))
    .sort()
    .map((n) => path.join(dir, n));
}

suite('journal: pure helpers', () => {
  test('hashEntry = sha256(prevHash + canonicalJson(entry without hash)) and ignores key order', () => {
    const base = { version: 1 as const, seq: 1, ts: '2026-09-02T00:00:00.000Z', kind: 'system' as const, note: 'hi', prevHash: GENESIS_HASH };
    const expected = sha256(GENESIS_HASH + canonicalJson(base));
    assert.strictEqual(hashEntry(base), expected);
    const reordered = { prevHash: GENESIS_HASH, note: 'hi', kind: 'system' as const, ts: base.ts, seq: 1, version: 1 as const };
    assert.strictEqual(hashEntry(reordered), expected);
    assert.deepStrictEqual(stripHash({ ...base, hash: 'x' }), base);
  });

  test('parseJournalText tolerates CRLF, blank lines, partial tails and garbage', () => {
    const e = { version: 1, seq: 1, ts: 't', kind: 'system', prevHash: GENESIS_HASH, hash: 'h' };
    const p = parseJournalText(JSON.stringify(e) + '\r\n\r\nnot json\n{"a":1}\n{"partial');
    assert.strictEqual(p.entries.length, 1);
    assert.strictEqual(p.lines.length, 5);
    assert.ok(p.lines[1].problem);
    assert.ok(p.lines[2].problem);
    assert.ok(p.lines[3].problem, 'an object that is not an entry is a problem');
    assert.ok(p.lines[4].problem);
    assert.strictEqual(p.partialTail, true);
    assert.strictEqual(parseJournalText('').partialTail, false);
    assert.strictEqual(parseJournalText(JSON.stringify(e) + '\n').partialTail, false);
  });

  test('verifyLines reports the first bad line with a plain-English detail', () => {
    const a: Omit<JournalEntry, 'hash'> = { version: 1, seq: 1, ts: 't', kind: 'system', prevHash: GENESIS_HASH };
    const ea: JournalEntry = { ...a, hash: hashEntry(a) };
    const b: Omit<JournalEntry, 'hash'> = { version: 1, seq: 2, ts: 't', kind: 'system', prevHash: ea.hash };
    const eb: JournalEntry = { ...b, hash: hashEntry(b) };
    const text = [ea, eb].map((x) => JSON.stringify(x)).join('\n') + '\n';
    const ok = verifyLines(parseJournalText(text), GENESIS_HASH, undefined, 'j');
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.count, 2);
    assert.strictEqual(ok.tailHash, eb.hash);
    assert.strictEqual(ok.nextSeq, 3);

    const wrongStart = verifyLines(parseJournalText(text), 'f'.repeat(64), undefined, 'j');
    assert.strictEqual(wrongStart.ok, false);
    assert.strictEqual(wrongStart.brokenAt, 1);

    const badSeq = verifyLines(parseJournalText(text), GENESIS_HASH, 5, 'j');
    assert.strictEqual(badSeq.ok, false);
    assert.strictEqual(badSeq.brokenAt, 1);
    assert.match(badSeq.detail!, /sequence number/);
  });

  test('samePath and compactTimestamp', () => {
    assert.strictEqual(samePath('/a/b/../c', '/a/c'), true);
    assert.strictEqual(samePath(undefined, '/a'), false);
    assert.strictEqual(samePath('/a', '/b'), false);
    const ts = compactTimestamp(new Date('2026-09-02T10:11:12.345Z'));
    assert.strictEqual(ts, '2026-09-02T10-11-12-345Z');
    assert.ok(!/[:.]/.test(ts));
  });
});

suite('journal: file journal', () => {
  let dir: string;
  let file: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-journal-'));
    file = path.join(dir, 'nested', 'journal.jsonl');
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('empty journal verifies and lists nothing', async () => {
    const j = createJournal({ file, logger: silent });
    assert.deepStrictEqual(await j.list(), []);
    const v = await j.verifyChain();
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.entries, 0);
    assert.ok(v.detail);
  });

  test('append builds a hash chain from genesis with increasing seq', async () => {
    const j = createJournal({ file, logger: silent });
    const a = await j.append({ kind: 'proposed', path: '/w/app.py', agent: 'claude', requestId: 'r1' });
    const b = await j.append({ kind: 'decided', path: '/w/app.py', agent: 'claude', requestId: 'r1', decision: { requestId: 'r1', verdict: 'accept', scope: 'one', decidedAt: 't' } });
    assert.strictEqual(a.version, 1);
    assert.strictEqual(a.seq, 1);
    assert.strictEqual(a.prevHash, GENESIS_HASH);
    assert.strictEqual(a.hash, hashEntry(stripHash(a)));
    assert.strictEqual(b.seq, 2);
    assert.strictEqual(b.prevHash, a.hash);
    assert.strictEqual(b.hash, hashEntry(stripHash(b)));
    assert.ok(Number.isFinite(Date.parse(a.ts)));
    assert.ok(fs.existsSync(file), 'creates parent folders');
    const lines = readLines(file);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], canonicalJson(a));
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
    const v = await j.verifyChain();
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.entries, 2);
  });

  test('caller-supplied chain fields are ignored', async () => {
    const j = createJournal({ file, logger: silent });
    const e = await j.append({ kind: 'system', note: 'x', seq: 99, hash: 'nope', prevHash: 'nope' } as never);
    assert.strictEqual(e.seq, 1);
    assert.strictEqual(e.prevHash, GENESIS_HASH);
    assert.strictEqual((await j.verifyChain()).ok, true);
  });

  test('list filters by path and limit keeps the most recent entries in order', async () => {
    const j = createJournal({ file, logger: silent });
    for (let i = 0; i < 6; i++) await j.append({ kind: 'applied', path: i % 2 ? '/w/a.py' : '/w/b.py', note: String(i) });
    const all = await j.list();
    assert.strictEqual(all.length, 6);
    assert.deepStrictEqual(
      all.map((e) => e.seq),
      [1, 2, 3, 4, 5, 6],
    );
    const a = await j.list({ path: '/w/a.py' });
    assert.deepStrictEqual(
      a.map((e) => e.note),
      ['1', '3', '5'],
    );
    const last2 = await j.list({ limit: 2 });
    assert.deepStrictEqual(
      last2.map((e) => e.seq),
      [5, 6],
    );
    const a1 = await j.list({ path: '/w/a.py', limit: 1 });
    assert.deepStrictEqual(
      a1.map((e) => e.note),
      ['5'],
    );
  });

  test('tampering with a line is reported at that line', async () => {
    const j = createJournal({ file, logger: silent });
    for (let i = 1; i <= 4; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    const lines = readLines(file);
    lines[2] = lines[2].replace('entry 3', 'entry 3 EDITED');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const v = await createJournal({ file, logger: silent }).verifyChain();
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.brokenAt, 3);
    assert.match(v.detail!, /altered/);
  });

  test('removing a line breaks the link of the following line', async () => {
    const j = createJournal({ file, logger: silent });
    for (let i = 1; i <= 4; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    const lines = readLines(file);
    lines.splice(1, 1);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const v = await j.verifyChain();
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.brokenAt, 2);
    assert.match(v.detail!, /does not link/);
  });

  test('a re-hashed edited line is caught by the next line and a foreign first line by line 1', async () => {
    const j = createJournal({ file, logger: silent });
    for (let i = 1; i <= 3; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    const entries = readEntries(file);
    entries[1].note = 'rewritten';
    entries[1].hash = hashEntry(stripHash(entries[1]));
    fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const v = await j.verifyChain();
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.brokenAt, 3);

    const first = readEntries(file)[0];
    first.prevHash = 'a'.repeat(64);
    first.hash = hashEntry(stripHash(first));
    fs.writeFileSync(file, JSON.stringify(first) + '\n');
    const v2 = await j.verifyChain();
    assert.strictEqual(v2.ok, false);
    assert.strictEqual(v2.brokenAt, 1);
    assert.match(v2.detail!, /archive|beginning/);
  });

  test('a truncated last line is reported, then trimmed and noted on the next append', async () => {
    const j = createJournal({ file, logger: silent });
    for (let i = 1; i <= 3; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    const third = readEntries(file)[2];
    fs.appendFileSync(file, '{"version":1,"seq":4,"ts":"2026-');
    const v = await createJournal({ file, logger: silent }).verifyChain();
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.brokenAt, 4);
    assert.match(v.detail!, /incomplete/);
    assert.strictEqual(v.entries, 3);

    const j2 = createJournal({ file, logger: silent });
    const e = await j2.append({ kind: 'proposed', path: '/w/x.py' });
    const entries = readEntries(file);
    assert.strictEqual(entries.length, 5, 'system note + new entry');
    assert.strictEqual(entries[3].kind, 'system');
    assert.match(entries[3].note!, /incomplete last line/);
    assert.strictEqual(entries[3].prevHash, third.hash);
    assert.strictEqual(e.seq, 5);
    assert.strictEqual((await j2.verifyChain()).ok, true);
  });

  test('a complete last line missing its newline is finished, not trimmed', async () => {
    const j = createJournal({ file, logger: silent });
    for (let i = 1; i <= 2; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.slice(0, -1));
    const j2 = createJournal({ file, logger: silent });
    await j2.append({ kind: 'system', note: 'entry 3' });
    const entries = readEntries(file);
    assert.deepStrictEqual(
      entries.map((e) => e.seq),
      [1, 2, 3],
    );
    assert.strictEqual((await j2.verifyChain()).ok, true);
  });

  test('a new instance continues the chain and notices appends by another instance', async () => {
    const a = createJournal({ file, logger: silent });
    await a.append({ kind: 'system', note: '1' });
    const b = createJournal({ file, logger: silent });
    await b.append({ kind: 'system', note: '2' });
    await a.append({ kind: 'system', note: '3' });
    await b.append({ kind: 'system', note: '4' });
    const v = await a.verifyChain();
    assert.strictEqual(v.ok, true, v.detail);
    assert.strictEqual(v.entries, 4);
    assert.deepStrictEqual(
      readEntries(file).map((e) => e.seq),
      [1, 2, 3, 4],
    );
  });

  test('100 parallel appends keep a valid chain with seq 1..100', async () => {
    const j = createJournal({ file, logger: silent });
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => j.append({ kind: 'applied', path: `/w/f${i % 7}.ts`, note: String(i) })));
    assert.deepStrictEqual(
      results.map((e) => e.seq).sort((x, y) => x - y),
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
    const v = await j.verifyChain();
    assert.strictEqual(v.ok, true, v.detail);
    assert.strictEqual(v.entries, 100);
    const onDisk = readEntries(file);
    for (let i = 1; i < onDisk.length; i++) assert.strictEqual(onDisk[i].prevHash, onDisk[i - 1].hash);
  });

  test('rotation archives the oldest half, records the archive link and stays verifiable', async () => {
    let max = 10;
    const j = createJournal({ file, maxEntries: () => max, logger: silent });
    for (let i = 1; i <= 11; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    const archives = archivesIn(path.dirname(file));
    assert.strictEqual(archives.length, 1);
    const archived = readEntries(archives[0]);
    assert.deepStrictEqual(
      archived.map((e) => e.seq),
      [1, 2, 3, 4, 5],
    );
    const active = readEntries(file);
    assert.deepStrictEqual(
      active.map((e) => e.seq),
      [6, 7, 8, 9, 10, 11, 12],
    );
    assert.strictEqual(active[0].prevHash, archived[4].hash, 'chain continues across files');
    const note = active[active.length - 1];
    assert.strictEqual(note.kind, 'system');
    assert.strictEqual(note.afterHash, archived[4].hash);
    assert.strictEqual(note.beforeHash, GENESIS_HASH);
    assert.strictEqual(path.basename(note.path!), path.basename(archives[0]));
    assert.match(note.note!, /archived/);

    const v = await j.verifyChain();
    assert.strictEqual(v.ok, true, v.detail);
    assert.strictEqual(v.entries, 12);
    assert.match(v.detail!, /2 files/);

    // list() only reports the active file.
    assert.strictEqual((await j.list()).length, 7);

    // Raising the limit stops further rotation; lowering it triggers another.
    max = 1000;
    await j.append({ kind: 'system', note: 'no rotation' });
    assert.strictEqual(archivesIn(path.dirname(file)).length, 1);
    max = 4;
    await j.append({ kind: 'system', note: 'rotate again' });
    assert.strictEqual(archivesIn(path.dirname(file)).length, 2);
    const v2 = await j.verifyChain();
    assert.strictEqual(v2.ok, true, v2.detail);
    assert.strictEqual(v2.entries, 15);
  });

  test('verification follows the chain across many archives with continuous seq', async () => {
    const j = createJournal({ file, maxEntries: () => 4, logger: silent });
    for (let i = 1; i <= 40; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    const v = await j.verifyChain();
    assert.strictEqual(v.ok, true, v.detail);
    assert.ok(archivesIn(path.dirname(file)).length >= 5);
    const all = [...archivesIn(path.dirname(file)).flatMap(readEntries), ...readEntries(file)];
    assert.strictEqual(v.entries, all.length);
    for (let i = 0; i < all.length; i++) assert.strictEqual(all[i].seq, i + 1);
  });

  test('a tampered or missing archive breaks verification with a message naming it', async () => {
    const j = createJournal({ file, maxEntries: () => 6, logger: silent });
    for (let i = 1; i <= 7; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    const [archive] = archivesIn(path.dirname(file));
    const original = fs.readFileSync(archive, 'utf8');

    fs.writeFileSync(archive, original.replace('entry 2', 'entry 2 EDITED'));
    const tampered = await j.verifyChain();
    assert.strictEqual(tampered.ok, false);
    assert.strictEqual(tampered.brokenAt, 2);
    assert.ok(tampered.detail!.includes(path.basename(archive)));

    // Truncating the archive keeps its lines valid but the boundary no longer links.
    const lines = original.split('\n').filter(Boolean);
    fs.writeFileSync(archive, lines.slice(0, 2).join('\n') + '\n');
    const shortened = await j.verifyChain();
    assert.strictEqual(shortened.ok, false);
    assert.match(shortened.detail!, /does not continue|archive/);

    fs.unlinkSync(archive);
    const missing = await j.verifyChain();
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.brokenAt, 1);
    assert.match(missing.detail!, /archive/);

    fs.writeFileSync(archive, original);
    assert.strictEqual((await j.verifyChain()).ok, true);
  });

  test('a rotation interrupted before the archive was renamed is completed on the next append', async () => {
    const j = createJournal({ file, maxEntries: () => 4, logger: silent });
    for (let i = 1; i <= 5; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    const [archive] = archivesIn(path.dirname(file));
    fs.renameSync(archive, archive + '.tmp');
    assert.strictEqual((await createJournal({ file, logger: silent }).verifyChain()).ok, false);

    const j2 = createJournal({ file, maxEntries: () => 1000, logger: silent });
    await j2.append({ kind: 'system', note: 'after crash' });
    assert.ok(fs.existsSync(archive), 'archive renamed back');
    assert.ok(!fs.existsSync(archive + '.tmp'));
    const v = await j2.verifyChain();
    assert.strictEqual(v.ok, true, v.detail);

    // A stale temp file that does not link anywhere is discarded when the journal is next loaded.
    fs.writeFileSync(path.join(path.dirname(file), 'journal.stale.archived.jsonl.tmp'), 'garbage\n');
    const j3 = createJournal({ file, maxEntries: () => 1000, logger: silent });
    await j3.append({ kind: 'system', note: 'again' });
    assert.ok(!fs.existsSync(path.join(path.dirname(file), 'journal.stale.archived.jsonl.tmp')));
    assert.strictEqual((await j3.verifyChain()).ok, true);
  });

  test('several rotations inside the same millisecond stay verifiable (archive order comes from seq, not names)', async () => {
    const fixed = new Date('2026-09-02T10:00:00.000Z');
    const j = createJournal({ file, maxEntries: () => 4, logger: silent, now: () => fixed });
    for (let i = 1; i <= 14; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    const archives = archivesIn(path.dirname(file));
    assert.ok(archives.length >= 3, 'many rotations at the same timestamp');
    assert.ok(archives.some((a) => /-\d+\.archived\.jsonl$/.test(a)), 'same-timestamp archives get a numeric suffix');
    const v = await j.verifyChain();
    assert.strictEqual(v.ok, true, v.detail);
    const all = [...archives.flatMap(readEntries), ...readEntries(file)].sort((a, b) => a.seq - b.seq);
    assert.strictEqual(v.entries, all.length);
    for (let i = 0; i < all.length; i++) assert.strictEqual(all[i].seq, i + 1);
  });

  test('a missing or broken maxEntries setting falls back to the default instead of rotating everything away', async () => {
    for (const bad of [undefined, NaN, 0, -5, 'lots'] as unknown[]) {
      const f = path.join(dir, `bad-${String(bad)}.jsonl`);
      const j = createJournal({ file: f, maxEntries: () => bad as number, logger: silent });
      for (let i = 1; i <= 8; i++) await j.append({ kind: 'system', note: `entry ${i}` });
      assert.strictEqual(readEntries(f).length, 8, `no rotation for maxEntries=${String(bad)}`);
      assert.strictEqual((await j.verifyChain()).ok, true);
    }
    assert.strictEqual(archivesIn(dir).length, 0);
  });

  test('a folder where the journal file should be fails with a plain-English message, and the journal recovers once it is gone', async () => {
    fs.mkdirSync(file, { recursive: true });
    const j = createJournal({ file, logger: silent });
    await assert.rejects(j.append({ kind: 'system', note: 'x' }), (e: Error) => /could not record a change/.test(e.message) && /folder is sitting where the journal file should be/.test(e.message) && e.message.includes(file));
    await assert.rejects(j.list(), (e: Error) => /could not read its change journal/.test(e.message));
    await assert.rejects(j.verifyChain(), (e: Error) => /could not verify its change journal/.test(e.message));
    fs.rmdirSync(file);
    const e = await j.append({ kind: 'system', note: 'after the fix' });
    assert.strictEqual(e.seq, 1);
    assert.strictEqual((await j.verifyChain()).ok, true);
  });

  test('rotation keeps damaged lines as they are so evidence is never destroyed', async () => {
    const j = createJournal({ file, maxEntries: () => 4, logger: silent });
    for (let i = 1; i <= 3; i++) await j.append({ kind: 'system', note: `entry ${i}` });
    fs.appendFileSync(file, 'garbage line\n');
    const j2 = createJournal({ file, maxEntries: () => 4, logger: silent });
    await j2.append({ kind: 'system', note: 'entry 4' });
    await j2.append({ kind: 'system', note: 'entry 5' });
    const allText = [...archivesIn(path.dirname(file)), file].map((f) => fs.readFileSync(f, 'utf8')).join('');
    assert.ok(allText.includes('garbage line'));
    const v = await j2.verifyChain();
    assert.strictEqual(v.ok, false);
    // The garbage line was rotated into the second archive as its line 2; brokenAt is relative to the file the detail names.
    assert.strictEqual(v.brokenAt, 2);
    assert.match(v.detail!, /not a valid journal entry/);
    assert.match(v.detail!, /archived\.jsonl/);
    assert.strictEqual(v.entries, 3, 'entries before the damage still verify');
  });
});
