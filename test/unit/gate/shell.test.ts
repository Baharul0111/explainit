import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { analyseCommand, shellWriteReason, splitSegments, tokenize } from '../../../src/gate/pure/shell';

suite('gate/pure/shell: tokenize', () => {
  test('splits on whitespace and honours quotes', () => {
    assert.deepEqual(tokenize(`sed -i 's/a b/c/' "my file.py"`), ['sed', '-i', 's/a b/c/', 'my file.py']);
  });
  test('escapes', () => {
    assert.deepEqual(tokenize('echo a\\ b'), ['echo', 'a b']);
  });
});

suite('gate/pure/shell: splitSegments', () => {
  test('splits on && || ; | and newlines outside quotes only', () => {
    assert.deepEqual(splitSegments('a && b || c; d | e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(splitSegments('bash -c "cd x && cat > y" && ls'), ['bash -c "cd x && cat > y"', 'ls']);
    assert.deepEqual(splitSegments("echo 'a;b' ; echo c"), ["echo 'a;b'", 'echo c']);
    assert.deepEqual(splitSegments('echo "a\\"b|c" | tee d'), ['echo "a\\"b|c"', 'tee d']);
    assert.deepEqual(splitSegments('echo a\\;b; c'), ['echo a\\;b', 'c']);
  });
  test('unbalanced quotes fall back to the plain split so nothing after a stray apostrophe is hidden', () => {
    assert.deepEqual(splitSegments("echo it's fine && sed -i s/a/b/ x.py"), ["echo it's fine", 'sed -i s/a/b/ x.py']);
    assert.equal(analyseCommand("echo it's fine && sed -i s/a/b/ x.py").writes, true);
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

  test('every written file is listed, code file or not, and cd / pushd / popd move the effective directory (F4)', () => {
    // The roots are built with path.resolve, not path.join: relative targets are resolved against the
    // effective cwd, and on Windows path.resolve carries the current drive letter ("D:\\people\\me")
    // while path.join does not ("\\people\\me"), which would make every expectation below disagree.
    const home = path.resolve(path.sep, 'people', 'me');
    const cwd = path.resolve(path.sep, 'work', 'repo');
    assert.equal(path.resolve(home), home, 'the roots must already be fully resolved (drive letter and all)');
    const ctx = { cwd, home };
    const a = analyseCommand('cd ~/.claude && cat > settings.json', ctx);
    assert.deepEqual(a.enteredDirs, [path.join(home, '.claude')]);
    assert.deepEqual(a.writeTargets, [path.join(home, '.claude', 'settings.json')]);
    const b = analyseCommand('(cd ~/.explainit/sessions && echo x > 1.json)', ctx);
    assert.deepEqual(b.enteredDirs, [path.join(home, '.explainit', 'sessions')]);
    assert.deepEqual(b.writeTargets, [path.join(home, '.explainit', 'sessions', '1.json')]);
    const c = analyseCommand('pushd ~/.codex; tee hooks.json', ctx);
    assert.deepEqual(c.enteredDirs, [path.join(home, '.codex')]);
    assert.deepEqual(c.writeTargets, [path.join(home, '.codex', 'hooks.json')]);
    const d = analyseCommand('pushd src; popd; echo x > notes.txt', ctx);
    assert.deepEqual(d.enteredDirs, [path.join(cwd, 'src')]);
    assert.deepEqual(d.writeTargets, [path.join(cwd, 'notes.txt')], 'popd restores the previous directory');
    const e = analyseCommand('cd src && cd ../lib && cat <<EOF > x.txt\nhello\nEOF', ctx);
    assert.deepEqual(e.enteredDirs, [path.join(cwd, 'src'), path.join(cwd, 'lib')]);
    assert.deepEqual(e.writeTargets, [path.join(cwd, 'lib', 'x.txt')]);
    const f = analyseCommand('bash -c "cd $HOME/.claude && printf x | tee settings.local.json"', ctx);
    assert.deepEqual(f.enteredDirs, [path.join(home, '.claude')]);
    assert.deepEqual(f.writeTargets, [path.join(home, '.claude', 'settings.local.json')]);
    const g = analyseCommand('cd && echo x > y', ctx);
    assert.deepEqual(g.enteredDirs, [home]);
    assert.deepEqual(analyseCommand('cd - && echo x > y', ctx).writeTargets, ['y'], 'after `cd -` the directory is unknown');
    assert.deepEqual(analyseCommand('chmod +x .git/hooks/pre-commit', ctx).writeTargets, [path.join(cwd, '.git', 'hooks', 'pre-commit')]);
    assert.deepEqual(analyseCommand('ln -s evil .git/hooks/pre-push', ctx).writeTargets, [path.join(cwd, '.git', 'hooks', 'pre-push')]);
    const explainitHome = path.resolve(path.sep, 'e');
    const codexHome = path.resolve(path.sep, 'c');
    assert.deepEqual(analyseCommand('echo x > $EXPLAINIT_HOME/state.json', { ...ctx, explainitHome }).writeTargets, [path.join(explainitHome, 'state.json')]);
    assert.deepEqual(analyseCommand('echo x > $CODEX_HOME/hooks.json', { ...ctx, codexHome }).writeTargets, [path.join(codexHome, 'hooks.json')]);
    assert.deepEqual(analyseCommand('echo hello > /dev/null', ctx).writeTargets, []);
    assert.deepEqual(analyseCommand('ls -la', ctx).writeTargets, []);
  });

  test('a Windows-spelled path survives tokenising, so a cd into one is still tracked (F4 on win32)', () => {
    // `\` is a POSIX escape everywhere else, but inside a token that starts as a Windows path it is
    // a separator: otherwise `cd C:\Users\me\.claude` would tokenise as `C:Usersme.claude` and the
    // protected-directory check would never see it. This holds on every platform, so macOS proves it.
    assert.deepEqual(tokenize('cd C:\\Users\\me\\.claude'), ['cd', 'C:\\Users\\me\\.claude']);
    assert.deepEqual(tokenize('cd "C:\\Users\\me\\.claude"'), ['cd', 'C:\\Users\\me\\.claude']);
    assert.deepEqual(tokenize('cp x \\\\srv\\share\\hooks.json'), ['cp', 'x', '\\\\srv\\share\\hooks.json']);
    assert.deepEqual(tokenize('echo a\\ b'), ['echo', 'a b'], 'the POSIX escape still holds outside Windows paths');
    const win = analyseCommand('cd C:\\Users\\me\\.claude && cat > settings.json');
    assert.deepEqual(win.enteredDirs, [path.normalize('C:\\Users\\me\\.claude')]);
    assert.deepEqual(win.writeTargets, [path.resolve(win.enteredDirs[0], 'settings.json')], 'the write resolves against the directory the command entered');
  });

  test('git config: writes target .git/config, ~/.gitconfig for --global, or the --file argument; reads target nothing', () => {
    // path.resolve, so the roots carry the drive letter on Windows (see the F4 test above).
    const home = path.resolve(path.sep, 'people', 'me');
    const cwd = path.resolve(path.sep, 'work', 'repo');
    const ctx = { cwd, home };
    assert.deepEqual(analyseCommand('git config user.name "A B"', ctx).writeTargets, [path.join(cwd, '.git', 'config')]);
    assert.deepEqual(analyseCommand('git config --add remote.origin.fetch x', ctx).writeTargets, [path.join(cwd, '.git', 'config')]);
    assert.deepEqual(analyseCommand('git -C sub config core.hooksPath /tmp/h', ctx).writeTargets, [path.join(cwd, 'sub', '.git', 'config')]);
    assert.deepEqual(analyseCommand('git config --global user.email a@b.c', ctx).writeTargets, [path.join(home, '.gitconfig')]);
    assert.deepEqual(analyseCommand('git config --file custom.ini a.b c', ctx).writeTargets, [path.join(cwd, 'custom.ini')]);
    assert.deepEqual(analyseCommand('git config --file=custom.ini a.b c', ctx).writeTargets, [path.join(cwd, 'custom.ini')]);
    for (const read of ['git config --get user.name', 'git config --list', 'git config -l', 'git config --get-regexp remote', 'git config --show-origin --get x']) {
      assert.deepEqual(analyseCommand(read, ctx).writeTargets, [], read);
    }
    assert.equal(analyseCommand('git config user.name x', ctx).writes, false, 'not a code write; the policy decides on the target');
  });

  test('reason text steers to Write/Edit (claude) or apply_patch (codex)', () => {
    const a = analyseCommand('sed -i "s/a/b/" x.py');
    assert.match(shellWriteReason(a, 'claude'), /Write or Edit tool/);
    assert.match(shellWriteReason(a, 'codex'), /apply_patch/);
    assert.match(shellWriteReason(a, 'claude'), /x\.py/);
  });
});
