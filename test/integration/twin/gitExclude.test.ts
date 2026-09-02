import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getApi } from './helpers';
import type { ExplainitApi } from '../../../src/extension';

suite('twin git exclude (integration)', function () {
  this.timeout(60_000);
  let api: ExplainitApi;
  let tmp: string;
  const savedAnswers = process.env.EXPLAINIT_TEST_ANSWERS;

  suiteSetup(async () => {
    api = await getApi();
  });
  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-repo-'));
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.mkdirSync(path.join(tmp, 'src'));
  });
  teardown(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedAnswers === undefined) delete process.env.EXPLAINIT_TEST_ANSWERS;
    else process.env.EXPLAINIT_TEST_ANSWERS = savedAnswers;
  });

  test('.git/info/exclude gets *_explain.txt once; .gitignore is never touched', async () => {
    assert.strictEqual(await api.twin.ensureGitExclude(path.join(tmp, 'src')), 'added');
    const exclude = path.join(tmp, '.git', 'info', 'exclude');
    assert.strictEqual(fs.readFileSync(exclude, 'utf8'), '*_explain.txt\n');
    assert.strictEqual(await api.twin.ensureGitExclude(tmp), 'present');
    assert.strictEqual(fs.readFileSync(exclude, 'utf8'), '*_explain.txt\n');
    assert.ok(!fs.existsSync(path.join(tmp, '.gitignore')));
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-nogit-'));
    try {
      const r = await api.twin.ensureGitExclude(noGit);
      assert.ok(r === 'no-git' || r === 'present' || r === 'added', r); // tmp may sit inside a repo on dev machines
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test('offerSharedGitignore appends only on an explicit "Add to .gitignore" answer', async () => {
    process.env.EXPLAINIT_TEST_ANSWERS = JSON.stringify({ 'twin.sharedGitignore': 'Not now' });
    await api.twin.offerSharedGitignore(tmp);
    assert.ok(!fs.existsSync(path.join(tmp, '.gitignore')), 'declined: nothing written');

    fs.writeFileSync(path.join(tmp, '.gitignore'), 'node_modules/');
    process.env.EXPLAINIT_TEST_ANSWERS = JSON.stringify({ 'twin.sharedGitignore': 'Add to .gitignore' });
    await api.twin.offerSharedGitignore(tmp);
    assert.strictEqual(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8'), 'node_modules/\n*_explain.txt\n');
    await api.twin.offerSharedGitignore(tmp);
    assert.strictEqual(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8'), 'node_modules/\n*_explain.txt\n', 'idempotent');
  });
});
