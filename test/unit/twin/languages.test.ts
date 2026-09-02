import * as assert from 'node:assert';
import { isCodeFilePath, isCodeLanguage, languageIdForPath, MAX_TWIN_SOURCE_BYTES } from '../../../src/twin/pure/languages';
import { applyLineReplace, minimalLineReplace } from '../../../src/twin/pure/textEdit';

suite('twin/pure/languages', () => {
  test('deny list', () => {
    for (const id of ['plaintext', 'markdown', 'json', 'jsonc', 'yaml', 'xml', 'csv', 'log', 'ini', 'properties', 'git-commit', 'git-rebase', 'diff', 'scminput']) assert.ok(!isCodeLanguage(id), id);
    for (const id of ['python', 'typescript', 'dockerfile', 'cobol', 'shellscript', 'unknown-lang', 'Python']) assert.ok(isCodeLanguage(id), id);
    assert.ok(!isCodeLanguage('Markdown'), 'case-insensitive');
  });
  test('extension map for files on disk', () => {
    assert.strictEqual(languageIdForPath('/w/app.py'), 'python');
    assert.strictEqual(languageIdForPath('C:\\w\\Main.JAVA'), 'java');
    assert.strictEqual(languageIdForPath('/w/index.tsx'), 'typescriptreact');
    assert.strictEqual(languageIdForPath('/w/legacy/report.cob'), 'cobol');
    assert.strictEqual(languageIdForPath('/w/Dockerfile'), 'dockerfile');
    assert.strictEqual(languageIdForPath('/w/README.md'), undefined);
    assert.strictEqual(languageIdForPath('/w/data.json'), undefined);
    assert.strictEqual(languageIdForPath('/w/noext'), undefined);
    assert.ok(isCodeFilePath('/w/x.rs') && !isCodeFilePath('/w/x.css'));
    assert.strictEqual(MAX_TWIN_SOURCE_BYTES, 2 * 1024 * 1024);
  });
});

suite('twin/pure/textEdit', () => {
  const cases: [string, string][] = [
    ['a\nb\nc\n', 'a\nB\nc\n'],
    ['a\nb\nc\n', 'a\nb\nc\nd\n'],
    ['a\nb\nc\n', 'a\n'],
    ['', 'x\ny\n'],
    ['x\ny\n', ''],
    ['1\n2\n3', '1\n2\n3\n4'],
    ['same\nprefix\nX\nsame\nsuffix', 'same\nprefix\nY\nZ\nsame\nsuffix'],
    ['a\r\nb\r\n', 'a\nc\n'],
  ];
  test('minimal replace reproduces the new text', () => {
    for (const [oldT, newT] of cases) {
      const r = minimalLineReplace(oldT, newT);
      assert.ok(r, `replace expected for ${JSON.stringify([oldT, newT])}`);
      assert.strictEqual(applyLineReplace(oldT, r!), newT.replace(/\r\n/g, '\n'));
    }
  });
  test('identical texts produce no edit; only the differing block is touched', () => {
    assert.strictEqual(minimalLineReplace('a\nb\n', 'a\nb\n'), undefined);
    const r = minimalLineReplace('h1\nh2\n\n1. a\nWhat it does: old.\n\n2. b\nx\n', 'h1\nh2\n\n1. a\nWhat it does: new.\n\n2. b\nx\n');
    assert.deepStrictEqual(r, { fromLine: 4, toLineExclusive: 5, lines: ['What it does: new.'], oldLineCount: 9 });
  });
});
