import * as assert from 'node:assert';
import * as path from 'node:path';
import { isTwinPath, sourceNameForTwin, stemOf, twinNameFor, twinPathFrom } from '../../../src/twin/pure/naming';

suite('twin/pure/naming', () => {
  test('stem form when no sibling shares the stem', () => {
    assert.strictEqual(twinNameFor('app.py', ['app.py', 'util.py', 'README.md']), 'app_explain.txt');
    assert.strictEqual(twinNameFor('/abs/dir/app.py', ['app.py']), 'app_explain.txt');
    assert.strictEqual(twinNameFor('app.py', []), 'app_explain.txt');
  });

  test('full-filename form for index.ts + index.css collision, both files', () => {
    const siblings = ['index.ts', 'index.css', 'other.ts'];
    assert.strictEqual(twinNameFor('index.ts', siblings), 'index.ts_explain.txt');
    assert.strictEqual(twinNameFor('index.css', siblings), 'index.css_explain.txt');
    assert.strictEqual(twinNameFor('other.ts', siblings), 'other_explain.txt');
  });

  test('existing twin files never count as a colliding sibling', () => {
    assert.strictEqual(twinNameFor('app.py', ['app.py', 'app_explain.txt']), 'app_explain.txt');
    assert.strictEqual(twinNameFor('index.ts', ['index.ts', 'index.ts_explain.txt', 'index_explain.txt']), 'index_explain.txt');
  });

  test('the source itself is not a collision', () => {
    assert.strictEqual(twinNameFor('main.go', ['main.go', 'main.go']), 'main_explain.txt');
  });

  test('files without an extension and dotfiles', () => {
    assert.strictEqual(stemOf('Makefile'), 'Makefile');
    assert.strictEqual(stemOf('.env'), '.env');
    assert.strictEqual(twinNameFor('Makefile', ['Makefile', 'main.c']), 'Makefile_explain.txt');
    assert.strictEqual(twinNameFor('Makefile', ['Makefile', 'Makefile.am']), 'Makefile_explain.txt');
    assert.strictEqual(twinNameFor('Makefile.am', ['Makefile', 'Makefile.am']), 'Makefile.am_explain.txt');
  });

  test('multi-dot names use the last extension only', () => {
    assert.strictEqual(twinNameFor('server.test.ts', ['server.test.ts', 'server.ts']), 'server.test_explain.txt');
    assert.strictEqual(twinNameFor('archive.tar.gz', ['archive.tar.gz', 'archive.tar']), 'archive.tar_explain.txt');
  });

  test('isTwinPath', () => {
    assert.ok(isTwinPath('app_explain.txt'));
    assert.ok(isTwinPath('/x/y/index.ts_explain.txt'));
    assert.ok(isTwinPath('C:\\proj\\src\\app_explain.txt'.replace(/\\/g, path.sep)));
    assert.ok(!isTwinPath('_explain.txt'), 'a bare suffix is not a twin');
    assert.ok(!isTwinPath('app.py'));
    assert.ok(!isTwinPath('explain.txt'));
    assert.ok(!isTwinPath('app_explain.txt.bak'));
  });

  test('twinPathFrom keeps the folder', () => {
    const src = path.join(path.sep, 'w', 'src', 'app.py');
    assert.strictEqual(twinPathFrom(src, ['app.py']), path.join(path.sep, 'w', 'src', 'app_explain.txt'));
  });

  test('sourceNameForTwin inverts the rule', () => {
    assert.strictEqual(sourceNameForTwin('app_explain.txt', ['app.py', 'util.py']), 'app.py');
    const siblings = ['index.ts', 'index.css', 'other.ts'];
    assert.strictEqual(sourceNameForTwin('index.ts_explain.txt', siblings), 'index.ts');
    assert.strictEqual(sourceNameForTwin('index.css_explain.txt', siblings), 'index.css');
    assert.strictEqual(sourceNameForTwin('other_explain.txt', siblings), 'other.ts');
    assert.strictEqual(sourceNameForTwin('index_explain.txt', siblings), undefined, 'stem form is not used while a collision exists');
    assert.strictEqual(sourceNameForTwin('missing_explain.txt', siblings), undefined);
    assert.strictEqual(sourceNameForTwin('app.py', siblings), undefined);
  });
});
