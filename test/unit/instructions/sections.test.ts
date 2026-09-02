import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../../../src/core/log';
import { inMemorySettings } from '../../../src/core/settings';
import { createInstructionsGenerator } from '../../../src/instructions';
import { END_MARK, START_MARK, fileForAgent, hasSection, sectionText, upsertSection } from '../../../src/instructions/pure/sections';

suite('instructions/pure/sections', () => {
  test('sectionText is marker-delimited and says the essential things', () => {
    for (const agent of ['claude', 'codex', 'copilot'] as const) {
      const t = sectionText(agent);
      assert.ok(t.startsWith(START_MARK + '\n'));
      assert.ok(t.endsWith('\n' + END_MARK));
      assert.match(t, /one function at a time/i);
      assert.match(t, /_explain\.txt/);
      assert.match(t, /Never create, edit, delete, or commit `\*_explain\.txt`/);
      assert.match(t, /\.git\/info\/exclude/);
    }
    assert.match(sectionText('claude'), /stops each file change before it reaches the disk/);
    assert.match(sectionText('claude'), /rejection reason is the person's own words\. Follow it/);
    assert.match(sectionText('codex'), /checkpoint hook for Codex/);
    assert.match(sectionText('copilot'), /cannot stop Copilot edits before they land/);
    assert.match(sectionText('copilot'), /Keep \/ Undo/);
  });

  test('fileForAgent', () => {
    assert.strictEqual(fileForAgent('claude'), 'CLAUDE.md');
    assert.strictEqual(fileForAgent('codex'), 'AGENTS.md');
    assert.strictEqual(fileForAgent('copilot'), '.github/copilot-instructions.md');
  });

  test('upsert into a missing or empty file creates just the block', () => {
    const block = sectionText('claude');
    assert.deepStrictEqual(upsertSection(undefined, block), { text: block + '\n', changed: true, action: 'appended' });
    assert.strictEqual(upsertSection('   \n', block).text, block + '\n');
  });

  test('upsert appends after existing text and is idempotent', () => {
    const block = sectionText('codex');
    const first = upsertSection('# My project\n\nSome notes.\n', block);
    assert.strictEqual(first.action, 'appended');
    assert.strictEqual(first.text, '# My project\n\nSome notes.\n\n' + block + '\n');
    const second = upsertSection(first.text, block);
    assert.strictEqual(second.changed, false);
    assert.strictEqual(second.action, 'unchanged');
    assert.strictEqual(second.text, first.text);
    assert.ok(hasSection(first.text));
  });

  test('upsert replaces only the block, keeping text before and after', () => {
    const old = `${START_MARK}\nold stuff\n${END_MARK}`;
    const existing = `# Title\n\n${old}\n\n## After\nkeep me\n`;
    const r = upsertSection(existing, sectionText('claude'));
    assert.strictEqual(r.action, 'replaced');
    assert.strictEqual(r.text, `# Title\n\n${sectionText('claude')}\n\n## After\nkeep me\n`);
    assert.ok(!r.text.includes('old stuff'));
  });

  test('upsert preserves CRLF line endings', () => {
    const existing = '# Title\r\n\r\nline\r\n';
    const r = upsertSection(existing, sectionText('copilot'));
    assert.ok(!/(^|[^\r])\n/.test(r.text), 'every newline is CRLF');
    assert.ok(r.text.startsWith('# Title\r\n\r\nline\r\n\r\n' + START_MARK + '\r\n'));
    const again = upsertSection(r.text, sectionText('copilot'));
    assert.strictEqual(again.changed, false);
  });

  test('a file without a trailing newline gets a blank line before the block', () => {
    const r = upsertSection('notes', sectionText('claude'));
    assert.ok(r.text.startsWith('notes\n\n' + START_MARK));
  });

  test('a stray single marker is left alone and a fresh block appended', () => {
    const existing = `${START_MARK}\nhalf\n`;
    const r = upsertSection(existing, sectionText('claude'));
    assert.strictEqual(r.action, 'appended');
    assert.ok(r.text.startsWith(existing));
    assert.ok(r.text.endsWith(END_MARK + '\n'));
  });
});

suite('instructions/createInstructionsGenerator', function () {
  this.timeout(10000);
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-instr-'));
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const gen = () => createInstructionsGenerator({ logger: createLogger([], 'test'), settings: inMemorySettings(), extensionPath: dir, version: '0' });

  test('ensure creates the three files, then reports them unchanged', async () => {
    const g = gen();
    const first = await g.ensure(dir);
    assert.deepStrictEqual(first.written.map((f) => path.relative(dir, f)).sort(), ['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md'].map((p) => p.split('/').join(path.sep)).sort());
    assert.deepStrictEqual(first.unchanged, []);
    const second = await g.ensure(dir);
    assert.deepStrictEqual(second.written, []);
    assert.strictEqual(second.unchanged.length, 3);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), g.sectionText('claude') + '\n');
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes('explainit-tmp')));
  });

  test('ensure keeps the person\'s text and honours the agents option', async () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Rules\n\nBe kind.\n');
    const r = await gen().ensure(dir, { agents: ['codex'] });
    assert.strictEqual(r.written.length, 1);
    const text = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(text.startsWith('# Rules\n\nBe kind.\n\n' + START_MARK));
    assert.ok(!fs.existsSync(path.join(dir, 'CLAUDE.md')));
  });

  test('ensure reports unwritable folders in plain English', async function () {
    if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
    const ro = path.join(dir, 'ro');
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o500);
    try {
      await assert.rejects(gen().ensure(ro, { agents: ['claude'] }), /could not update 1 instruction file .*Check that the folder is writable/);
    } finally {
      fs.chmodSync(ro, 0o700);
    }
  });
});
