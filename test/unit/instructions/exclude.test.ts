import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createConsoleLogger } from '../../../src/core/log';
import { inMemorySettings } from '../../../src/core/settings';
import { hasIgnoreLine } from '../../../src/core/gitExclude';
import { createInstructionsGenerator } from '../../../src/instructions';

suite('instructions: files ExplainIT creates stay out of git', () => {
  let repo: string;
  setup(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-instr-exclude-'));
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
  });
  teardown(() => fs.rmSync(repo, { recursive: true, force: true }));

  const gen = (keepOutOfGit = true) =>
    createInstructionsGenerator({ logger: createConsoleLogger('error'), settings: inMemorySettings({ instructionsKeepOutOfGit: keepOutOfGit }), extensionPath: repo, version: '0' });

  test('newly created CLAUDE.md, AGENTS.md and copilot-instructions.md are excluded locally', async () => {
    const r = await gen().ensure(repo);
    assert.strictEqual(r.written.length, 3);
    assert.deepStrictEqual([...(r.excluded ?? [])].sort(), [...r.written].sort());
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    for (const p of ['/CLAUDE.md', '/AGENTS.md', '/.github/copilot-instructions.md']) assert.ok(hasIgnoreLine(exclude, p), `${p} should be excluded`);
    assert.ok(!fs.existsSync(path.join(repo, '.gitignore')), 'the shared .gitignore is never touched');
  });

  test('a file the team already had is updated but its git status is left alone', async () => {
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Team rules\n\nBe nice.\n');
    const r = await gen().ensure(repo, { agents: ['claude'] });
    assert.strictEqual(r.written.length, 1);
    assert.deepStrictEqual(r.excluded, []);
    assert.ok(!fs.existsSync(path.join(repo, '.git', 'info', 'exclude')));
    assert.ok(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8').startsWith('# Team rules'));
  });

  test('the setting turns the exclusion off', async () => {
    const r = await gen(false).ensure(repo, { agents: ['codex'] });
    assert.strictEqual(r.written.length, 1);
    assert.deepStrictEqual(r.excluded, []);
    assert.ok(!fs.existsSync(path.join(repo, '.git', 'info', 'exclude')));
  });

  test('a second run changes nothing and excludes nothing new', async () => {
    await gen().ensure(repo);
    const again = await gen().ensure(repo);
    assert.strictEqual(again.written.length, 0);
    assert.strictEqual(again.unchanged.length, 3);
    assert.deepStrictEqual(again.excluded, []);
  });
});
