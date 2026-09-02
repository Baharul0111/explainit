import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalPath, isInside, workspaceKey, explainitHome, HOME_LAYOUT, writePrivateFile } from '../../../src/core/paths';

/** What canonicalPath promises for an existing path: realpath with a lower-case drive letter on Windows (VS Code's fsPath style). */
function expectedCanonical(p: string): string {
  const real = fs.realpathSync.native(p);
  return process.platform === 'win32' ? real.replace(/^([a-zA-Z]):/, (_m, d: string) => d.toLowerCase() + ':') : real;
}

suite('core/paths', () => {
  let tmp: string;
  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-paths-'));
  });
  teardown(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('canonicalPath resolves existing paths and keeps missing tails', () => {
    const real = expectedCanonical(tmp);
    assert.strictEqual(canonicalPath(tmp), real);
    const missing = path.join(tmp, 'a', 'b', 'c.txt');
    assert.strictEqual(canonicalPath(missing), path.join(real, 'a', 'b', 'c.txt'));
  });

  test('canonicalPath follows symlinks', function () {
    const target = path.join(tmp, 'target');
    fs.mkdirSync(target);
    const link = path.join(tmp, 'link');
    try {
      fs.symlinkSync(target, link, 'dir');
    } catch {
      this.skip();
    }
    assert.strictEqual(canonicalPath(path.join(link, 'x.py')), path.join(expectedCanonical(target), 'x.py'));
  });

  test('isInside handles equality, children and escapes', () => {
    assert.ok(isInside(tmp, tmp));
    assert.ok(isInside(tmp, path.join(tmp, 'src', 'a.py')));
    assert.ok(!isInside(tmp, path.join(tmp, '..', 'other')));
    assert.ok(!isInside(path.join(tmp, 'ws'), path.join(tmp, 'ws2', 'file')));
  });

  test('workspaceKey is stable and short', () => {
    assert.strictEqual(workspaceKey(tmp), workspaceKey(tmp + path.sep));
    assert.strictEqual(workspaceKey(tmp).length, 16);
  });

  test('EXPLAINIT_HOME overrides the home layout', () => {
    const prev = process.env.EXPLAINIT_HOME;
    process.env.EXPLAINIT_HOME = tmp;
    try {
      assert.strictEqual(explainitHome(), path.resolve(tmp));
      assert.ok(HOME_LAYOUT.journal('/x/y').startsWith(path.resolve(tmp)));
      assert.ok(HOME_LAYOUT.hooks().startsWith(path.resolve(tmp)));
    } finally {
      if (prev === undefined) delete process.env.EXPLAINIT_HOME;
      else process.env.EXPLAINIT_HOME = prev;
    }
  });

  test('writePrivateFile creates parents and restricts mode', function () {
    const f = path.join(tmp, 'deep', 'state.json');
    writePrivateFile(f, '{}');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), '{}');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    }
  });
});
