import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The compiled test lives at <outDir>/test/install-smoke/test, four levels below the repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

interface Entry {
  name: string;
  size: number;
  compressedSize: number;
}

const checker = require(path.join(REPO_ROOT, 'scripts', 'check-vsix.js')) as {
  listZipEntries(buf: Buffer): Entry[];
  checkEntries(entries: { name: string; size: number }[], opts?: { maxFiles?: number; maxMb?: number }): { ok: boolean; problems: string[]; files: number; totalBytes: number };
  forbiddenReason(name: string): string | undefined;
  parseCliArgs(argv: string[]): { file?: string; maxFiles: number; maxMb: number; json: boolean; help: boolean };
  pickNewestVsix(dir: string): string | undefined;
  REQUIRED_ENTRIES: string[];
  REQUIRED_PREFIXES: string[];
  DEFAULT_MAX_FILES: number;
};

/** Build a real zip (stored entries, no compression) so the central-directory reader is exercised end to end. */
function makeZip(files: { name: string; data?: string }[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data ?? '', 'utf8');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 14); // crc (not checked by the reader)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length + 4 /* extra */ + 3 /* comment */);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(4, 30);
    central.writeUInt16LE(3, 32);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    Buffer.from([1, 2, 3, 4]).copy(central, 46 + name.length);
    Buffer.from('abc').copy(central, 50 + name.length);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cen = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22 + commentBuf.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cen.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  commentBuf.copy(eocd, 22);
  return Buffer.concat([...locals, cen, eocd]);
}

const GOOD = [
  'extension.vsixmanifest',
  '[Content_Types].xml',
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/dist/wasm/tree-sitter.wasm',
  'extension/hooks/explainit-hook.js',
  'extension/docs/runbooks/README.md',
  'extension/media/icon.png',
  'extension/README.md',
  'extension/LICENSE',
];

suite('scripts/check-vsix: zip reader', () => {
  test('lists entries with names and uncompressed sizes, comments and extra fields included', () => {
    const zip = makeZip(
      [
        { name: 'extension/package.json', data: '{"name":"explainit"}' },
        { name: 'extension/dist/', data: '' },
        { name: 'extension/dist/extension.js', data: 'x'.repeat(1234) },
      ],
      'archive comment',
    );
    const entries = checker.listZipEntries(zip);
    assert.deepEqual(
      entries.map((e) => [e.name, e.size]),
      [
        ['extension/package.json', 20],
        ['extension/dist/', 0],
        ['extension/dist/extension.js', 1234],
      ],
    );
    assert.deepEqual(checker.listZipEntries(makeZip([])), []);
  });

  test('corrupt, truncated and non-zip input give plain-English errors', () => {
    assert.throws(() => checker.listZipEntries(Buffer.from('not a zip at all, but long enough to have an EOCD')), /no end-of-central-directory/);
    assert.throws(() => checker.listZipEntries(Buffer.alloc(5)), /shorter than/);
    const zip = makeZip([{ name: 'a.txt', data: 'hello' }]);
    const eocd = zip.length - 22;
    const truncated = Buffer.from(zip);
    truncated.writeUInt32LE(0xffffffff, eocd + 16); // central directory offset -> ZIP64 marker
    assert.throws(() => checker.listZipEntries(truncated), /ZIP64/);
    const bad = Buffer.from(zip);
    bad.writeUInt32LE(0, bad.readUInt32LE(eocd + 16)); // clobber the first central signature
    assert.throws(() => checker.listZipEntries(bad), /entry 1 is corrupt/);
    const past = Buffer.from(zip);
    past.writeUInt32LE(zip.length, eocd + 12); // central size runs past the end
    assert.throws(() => checker.listZipEntries(past), /past the end/);
  });
});

suite('scripts/check-vsix: content checks', () => {
  const entries = (names: string[], size = 10) => names.map((name) => ({ name, size }));

  test('a healthy package passes', () => {
    const r = checker.checkEntries(entries(GOOD));
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.equal(r.files, GOOD.length);
  });

  test('missing required files and folders are reported with what to do', () => {
    const r = checker.checkEntries(entries(GOOD.filter((n) => !n.includes('wasm') && !n.endsWith('explainit-hook.js'))));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /missing extension\/hooks\/explainit-hook\.js/.test(p) && /npm run build/.test(p)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => /nothing under extension\/dist\/wasm\//.test(p)));
    // An empty directory entry does not count as content.
    const onlyDir = checker.checkEntries(entries([...GOOD.filter((n) => !n.includes('wasm')), 'extension/dist/wasm/']));
    assert.ok(onlyDir.problems.some((p) => /nothing under extension\/dist\/wasm\//.test(p)));
  });

  test('sources, tests, scratch build folders, node_modules, .env and logs must not ship (grouped per top-level folder)', () => {
    const stray = [
      'extension/src/extension.ts',
      'extension/test/unit/x.test.js',
      'extension/out-ux-verify/src/extension.js',
      'extension/out-ux-verify/test/x.js',
      'extension/out-ci/x.js',
      'extension/out/x.js',
      'extension/node_modules/diff/index.js',
      'extension/.env',
      'extension/.env.local',
      'extension/.vscode-test-download.log',
      'extension/.workflows/build2.js',
      'extension/explainit-0.0.9.vsix',
      'extension/tsconfig.json',
    ];
    const r = checker.checkEntries(entries([...GOOD, ...stray]));
    assert.equal(r.ok, false);
    const text = r.problems.join('\n');
    assert.match(text, /extension\/src\/ must not ship: src\/ is not part of the extension \(1 file\(s\)/);
    assert.match(text, /extension\/out-ux-verify\/ must not ship: a scratch build folder .* \(2 file\(s\), e\.g\. extension\/out-ux-verify\/src\/extension\.js\)/);
    assert.match(text, /extension\/out-ci\/ must not ship/);
    assert.match(text, /extension\/out\/ must not ship/);
    assert.match(text, /extension\/node_modules\/ must not ship/);
    assert.match(text, /extension\/\.env must not ship/);
    assert.match(text, /extension\/\.env\.local must not ship/);
    assert.match(text, /extension\/\.vscode-test-download\.log must not ship/);
    assert.match(text, /extension\/\.workflows\/ must not ship/);
    assert.match(text, /extension\/explainit-0\.0\.9\.vsix must not ship/);
    assert.match(text, /extension\/tsconfig\.json must not ship/);
    assert.equal(r.problems.filter((p) => /out-ux-verify/.test(p)).length, 1, 'one line per stray folder');
    assert.equal(r.problems.filter((p) => /\.vsix/.test(p)).length, 1);
  });

  test('forbiddenReason: shipped files are fine, entries outside extension/ are the manifest', () => {
    assert.equal(checker.forbiddenReason('extension/dist/extension.js'), undefined);
    assert.equal(checker.forbiddenReason('extension/dist/extension.js.map'), undefined);
    assert.equal(checker.forbiddenReason('extension/docs/runbooks/no-assistant.md'), undefined);
    assert.equal(checker.forbiddenReason('extension/hooks/explainit-hook.js'), undefined);
    assert.equal(checker.forbiddenReason('extension/outline.md'), undefined, 'out- must be a folder, not a name prefix');
    assert.equal(checker.forbiddenReason('extension.vsixmanifest'), undefined);
    assert.match(checker.forbiddenReason('extension/src/x.ts')!, /src\//);
    assert.match(checker.forbiddenReason('extension/media/x.ts')!, /must not ship/);
    assert.match(checker.forbiddenReason('extension/out-anything/x.js')!, /scratch build folder/);
  });

  test('too many files or too many megabytes is a problem even when every file looks fine', () => {
    const many = entries([...GOOD, ...Array.from({ length: 500 }, (_, i) => `extension/media/x${i}.svg`)]);
    const r = checker.checkEntries(many);
    assert.ok(r.problems.some((p) => /510 files in the package/.test(p)), r.problems.join('\n'));
    assert.equal(checker.checkEntries(many, { maxFiles: 1000 }).ok, true);
    const big = checker.checkEntries(entries(GOOD, 20 * 1024 * 1024));
    assert.ok(big.problems.some((p) => /MB uncompressed; more than 120 MB/.test(p)), big.problems.join('\n'));
    assert.equal(checker.checkEntries(entries(GOOD, 20 * 1024 * 1024), { maxMb: 500 }).ok, true);
    assert.equal(checker.DEFAULT_MAX_FILES, 400);
  });

  test('an empty package is reported as missing everything', () => {
    const r = checker.checkEntries([]);
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, checker.REQUIRED_ENTRIES.length + checker.REQUIRED_PREFIXES.length);
  });
});

suite('scripts/check-vsix: driver', () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-vsix-'));
  });
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('parseCliArgs', () => {
    assert.deepEqual(checker.parseCliArgs([]), { file: undefined, maxFiles: 400, maxMb: 120, json: false, help: false });
    const o = checker.parseCliArgs(['x.vsix', '--max-files', '50', '--max-mb=7', '--json']);
    assert.equal(o.file, 'x.vsix');
    assert.equal(o.maxFiles, 50);
    assert.equal(o.maxMb, 7);
    assert.equal(o.json, true);
    assert.throws(() => checker.parseCliArgs(['--max-files', 'lots']), /positive number/);
    assert.throws(() => checker.parseCliArgs(['--nope']), /Unknown argument/);
    assert.throws(() => checker.parseCliArgs(['a.vsix', 'b.vsix']), /Only one/);
  });

  test('pickNewestVsix picks the most recently written explainit-*.vsix and ignores the rest', () => {
    fs.writeFileSync(path.join(dir, 'explainit-0.1.0.vsix'), 'old');
    fs.writeFileSync(path.join(dir, 'other.vsix'), 'x');
    fs.writeFileSync(path.join(dir, 'explainit-0.2.0.vsix'), 'new');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, 'explainit-0.1.0.vsix'), past, past);
    assert.equal(path.basename(checker.pickNewestVsix(dir)!), 'explainit-0.2.0.vsix');
    assert.equal(checker.pickNewestVsix(os.tmpdir() + path.sep + 'explainit-none-' + process.pid), undefined, 'a missing dir is not a crash');
  });

  test('a real zip written to disk round-trips through the checker', () => {
    const file = path.join(dir, 'explainit-9.9.9.vsix');
    fs.writeFileSync(file, makeZip(GOOD.map((name) => ({ name, data: 'content' }))));
    const r = checker.checkEntries(checker.listZipEntries(fs.readFileSync(file)));
    assert.equal(r.ok, true, r.problems.join('\n'));
  });

  test('the packaged VSIX in the repo root, when present, is a readable zip with the manifest', () => {
    const file = checker.pickNewestVsix(REPO_ROOT);
    if (!file) return; // no package built on this machine; CI packages first and then runs the script itself
    const entries = checker.listZipEntries(fs.readFileSync(file));
    assert.ok(entries.length > 0);
    assert.ok(entries.some((e) => e.name === 'extension/package.json'), 'has extension/package.json');
    assert.ok(entries.some((e) => e.name === 'extension/dist/extension.js'), 'has the bundle');
  });
});
