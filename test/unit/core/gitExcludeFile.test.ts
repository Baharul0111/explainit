import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureFileExcluded, excludePatternForFile, hasIgnoreLine } from '../../../src/core/gitExclude';

suite('core/gitExclude: keeping one created file out of git', () => {
  let repo: string;
  setup(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-exclude-file-'));
    fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'sub', '.github'), { recursive: true });
  });
  teardown(() => fs.rmSync(repo, { recursive: true, force: true }));

  test('the pattern is anchored to the repo root with forward slashes', () => {
    assert.strictEqual(excludePatternForFile(repo, path.join(repo, 'CLAUDE.md')), '/CLAUDE.md');
    assert.strictEqual(excludePatternForFile(repo, path.join(repo, 'sub', '.github', 'copilot-instructions.md')), '/sub/.github/copilot-instructions.md');
  });

  test('ensureFileExcluded writes the local exclude list once and never the shared .gitignore', async () => {
    const file = path.join(repo, 'sub', 'AGENTS.md');
    fs.writeFileSync(file, 'x');
    const first = await ensureFileExcluded(file);
    assert.strictEqual(first.result, 'added');
    assert.strictEqual(first.pattern, '/sub/AGENTS.md');
    const excludeFile = path.join(repo, '.git', 'info', 'exclude');
    assert.ok(hasIgnoreLine(fs.readFileSync(excludeFile, 'utf8'), '/sub/AGENTS.md'));
    const second = await ensureFileExcluded(file);
    assert.strictEqual(second.result, 'present');
    assert.strictEqual(fs.readFileSync(excludeFile, 'utf8').split('/sub/AGENTS.md').length, 2, 'written exactly once');
    assert.ok(!fs.existsSync(path.join(repo, '.gitignore')), 'the shared ignore file is never created');
  });

  test('outside any repository nothing is written', async () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-no-repo-'));
    try {
      const file = path.join(loose, 'CLAUDE.md');
      fs.writeFileSync(file, 'x');
      assert.strictEqual((await ensureFileExcluded(file)).result, 'no-git');
    } finally {
      fs.rmSync(loose, { recursive: true, force: true });
    }
  });
});
