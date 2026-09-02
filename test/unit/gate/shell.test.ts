import * as assert from 'node:assert/strict';
import { analyseCommand, shellWriteReason, tokenize } from '../../../src/gate/pure/shell';

suite('gate/pure/shell: tokenize', () => {
  test('splits on whitespace and honours quotes', () => {
    assert.deepEqual(tokenize(`sed -i 's/a b/c/' "my file.py"`), ['sed', '-i', 's/a b/c/', 'my file.py']);
  });
  test('escapes', () => {
    assert.deepEqual(tokenize('echo a\\ b'), ['echo', 'a b']);
  });
});

suite('gate/pure/shell: analyseCommand heuristics table', () => {
  const table: [string, boolean, string?][] = [
    // writes in place
    ["sed -i 's/foo/bar/' src/app.py", true, 'sed -i'],
    ["sed -i.bak 's/foo/bar/' src/app.py", true, 'sed -i'],
    ["sed --in-place 's/x/y/' lib.rs", true, 'sed -i'],
    ["perl -pi -e 's/foo/bar/' main.go", true, 'perl -i'],
    ['echo "print(1)" > a.py', true, 'redirect'],
    ['echo "print(1)" >> a.py', true, 'redirect'],
    ['echo x >a.py', true, 'redirect'],
    ['cat <<EOF > x.ts\nconst a = 1;\nEOF', true, 'redirect'],
    ['cat > x.ts <<EOF\nconst a = 1;\nEOF', true, 'redirect'],
    ['printf "x" | tee src/util.ts', true, 'tee'],
    ['printf "x" | tee -a src/util.ts', true, 'tee'],
    ['git apply fix.patch', true, 'git apply'],
    ['patch -p1 < fix.diff', true, 'patch'],
    ['mv new.py src/app.py', true, 'mv'],
    ['cp template.java src/Main.java', true, 'cp'],
    ['cp -r assets/ public/ && mv old.txt notes.py', true, 'mv'],
    ['npm test && sed -i "s/a/b/" index.js', true, 'sed -i'],
    ['bash -c "echo hi > run.sh"', true, 'redirect'],
    ['rm src/app.py', true, 'rm'],
    ['git checkout -- src/app.py', true, 'git checkout <file>'],
    ['dd if=/dev/zero of=x.c', true, 'dd'],
    ['FOO=1 sudo sed -i "s/a/b/" x.py', true, 'sed -i'],
    // benign
    ['ls -la', false],
    ['npm test > log.txt', false],
    ['git status', false],
    ['git diff src/app.py', false],
    ['cat src/app.py', false],
    ['grep -rn "foo" src/', false],
    ['echo hello > /dev/null', false],
    ['node script.js 2>&1', false],
    ['python -m pytest tests/', false],
    ['sed "s/a/b/" src/app.py', false],
    ['perl -e "print 1"', false],
    ['mv notes.txt docs/notes.md', false],
    ['cp README.md README.bak', false],
    ['rm -rf dist', false],
    ['tee output.log', false],
    ['git checkout main', false],
    ['', false],
  ];
  for (const [cmd, writes, matched] of table) {
    test(`${JSON.stringify(cmd)} -> ${writes ? 'write' : 'benign'}`, () => {
      const r = analyseCommand(cmd);
      assert.equal(r.writes, writes, JSON.stringify(r));
      if (matched) assert.equal(r.matched, matched);
    });
  }

  test('targets list the code files touched', () => {
    assert.deepEqual(analyseCommand('mv a.py b.py').targets, ['b.py', 'a.py']);
    assert.deepEqual(analyseCommand('echo x > out.go').targets, ['out.go']);
  });

  test('reason text steers to Write/Edit (claude) or apply_patch (codex)', () => {
    const a = analyseCommand('sed -i "s/a/b/" x.py');
    assert.match(shellWriteReason(a, 'claude'), /Write or Edit tool/);
    assert.match(shellWriteReason(a, 'codex'), /apply_patch/);
    assert.match(shellWriteReason(a, 'claude'), /x\.py/);
  });
});
