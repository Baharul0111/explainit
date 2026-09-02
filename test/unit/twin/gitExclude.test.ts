import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addToGitignore, appendIgnoreLine, ensureExcludePattern, findGitLocation, hasIgnoreLine, parseGitdirPointer, sharedGitignorePath, TWIN_IGNORE_PATTERN } from '../../../src/twin/pure/gitExclude';

suite('twin/pure/gitExclude', () => {
  let tmp: string;
  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-git-'));
  });
  teardown(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('pure helpers', () => {
    assert.ok(hasIgnoreLine('a\n*_explain.txt\n', TWIN_IGNORE_PATTERN));
    assert.ok(hasIgnoreLine('  *_explain.txt  \r\n', TWIN_IGNORE_PATTERN));
    assert.ok(!hasIgnoreLine('# *_explain.txt\n', TWIN_IGNORE_PATTERN));
    assert.ok(!hasIgnoreLine('', TWIN_IGNORE_PATTERN));
    assert.strictEqual(appendIgnoreLine('', 'x'), 'x\n');
    assert.strictEqual(appendIgnoreLine('a', 'x'), 'a\nx\n');
    assert.strictEqual(appendIgnoreLine('a\n', 'x'), 'a\nx\n');
    assert.strictEqual(parseGitdirPointer('gitdir: ../main/.git/worktrees/wt\n', '/r/wt'), path.resolve('/r/wt', '../main/.git/worktrees/wt'));
    assert.strictEqual(parseGitdirPointer('gitdir: /abs/.git/modules/x', '/r'), path.resolve('/abs/.git/modules/x'));
    assert.strictEqual(parseGitdirPointer('garbage', '/r'), undefined);
  });

  test('adds the pattern once to .git/info/exclude (creating info/), idempotent, never touches .gitignore', async () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    const nested = path.join(tmp, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    const first = await ensureExcludePattern(nested);
    assert.strictEqual(first.result, 'added');
    const file = path.join(tmp, '.git', 'info', 'exclude');
    assert.strictEqual(first.file, file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '*_explain.txt\n');
    const second = await ensureExcludePattern(tmp);
    assert.strictEqual(second.result, 'present');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '*_explain.txt\n');
    assert.ok(!fs.existsSync(path.join(tmp, '.gitignore')));
  });

  test('appends to an existing exclude file without a trailing newline', async () => {
    fs.mkdirSync(path.join(tmp, '.git', 'info'), { recursive: true });
    const file = path.join(tmp, '.git', 'info', 'exclude');
    fs.writeFileSync(file, '# comment\n*.log');
    assert.strictEqual((await ensureExcludePattern(tmp)).result, 'added');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# comment\n*.log\n*_explain.txt\n');
  });

  test('no git repository', async () => {
    const r = await ensureExcludePattern(tmp);
    // The temp dir might live under a git repo on a developer machine; only assert when it does not.
    if (r.result === 'no-git') assert.strictEqual(r.file, undefined);
    assert.ok(['no-git', 'added', 'present'].includes(r.result));
    assert.strictEqual(await findGitLocation(path.join(tmp, 'nope')) === undefined, r.result === 'no-git');
  });

  test('worktree: .git is a file pointing at the gitdir, exclude goes to the common dir', async () => {
    const main = path.join(tmp, 'main');
    const wt = path.join(tmp, 'wt');
    const wtGitDir = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.relative(wt, wtGitDir)}\n`);
    fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n');
    const loc = await findGitLocation(path.join(wt));
    assert.ok(loc);
    assert.strictEqual(loc!.root, wt);
    assert.strictEqual(loc!.gitDir, wtGitDir);
    assert.strictEqual(loc!.commonDir, path.join(main, '.git'));
    const r = await ensureExcludePattern(wt);
    assert.strictEqual(r.result, 'added');
    assert.strictEqual(r.file, path.join(main, '.git', 'info', 'exclude'));
    assert.strictEqual((await ensureExcludePattern(wt)).result, 'present');
    assert.strictEqual((await ensureExcludePattern(main)).result, 'present', 'main repo sees the same file');
  });

  test('submodule-style pointer without commondir uses the pointed gitdir', async () => {
    const sub = path.join(tmp, 'sub');
    const gitDir = path.join(tmp, 'modules', 'sub');
    fs.mkdirSync(sub);
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${gitDir}`);
    const r = await ensureExcludePattern(sub);
    assert.strictEqual(r.result, 'added');
    assert.strictEqual(r.file, path.join(gitDir, 'info', 'exclude'));
  });

  test('broken pointer file is not guessed at', async () => {
    fs.writeFileSync(path.join(tmp, '.git'), 'gitdir: does/not/exist');
    assert.strictEqual(await findGitLocation(tmp), undefined);
  });

  test('sharedGitignorePath and addToGitignore only add when absent', async () => {
    fs.mkdirSync(path.join(tmp, '.git'));
    const file = await sharedGitignorePath(path.join(tmp));
    assert.strictEqual(file, path.join(tmp, '.gitignore'));
    assert.strictEqual(await addToGitignore(file!), 'added');
    assert.strictEqual(fs.readFileSync(file!, 'utf8'), '*_explain.txt\n');
    assert.strictEqual(await addToGitignore(file!), 'present');
    assert.strictEqual(fs.readFileSync(file!, 'utf8'), '*_explain.txt\n');
  });
});
