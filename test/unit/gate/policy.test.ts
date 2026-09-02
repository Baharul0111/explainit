import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProposedWrite } from '../../../src/core/types';
import {
  checkWritePolicy,
  claudeHooksChanged,
  codexHomeOf,
  codexHookLines,
  codexHooksChanged,
  isGitHooksOrConfig,
  isGitInfoExclude,
  isInsideGitDir,
  isProtectedDirectory,
  protectedPathMentioned,
  protectedShellReason,
  shellProtectedTarget,
  tomlLooksValid,
  type PolicyContext,
} from '../../../src/gate/pure/policy';
import { resolveTarget } from '../../../src/gate/pure/ingress';
import { applyEdit, applyEdits } from '../../../src/gate/pure/proposals';
import { analyseCommand } from '../../../src/gate/pure/shell';

suite('gate/pure/policy', () => {
  let root: string;
  let ctx: PolicyContext;
  let ws: string;
  let userHome: string;
  let home: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-policy-'));
    ws = path.join(root, 'ws');
    userHome = path.join(root, 'user');
    home = path.join(root, 'explainit-home');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.git', 'info'), { recursive: true });
    fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(userHome, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, 'hooks'), { recursive: true });
    ctx = { explainitHome: home, userHome, folders: [ws], extraProtected: [path.join(home, 'hooks', 'explainit-hook.js')] };
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  const modify = (p: string, before: string | null, after: string | null): ProposedWrite => ({ kind: before === null ? 'create' : 'modify', path: p, before, after });

  test('ordinary source file -> allow', () => {
    assert.deepEqual(checkWritePolicy(modify(path.join(ws, 'src', 'app.py'), 'a', 'b'), ctx), { action: 'allow' });
  });

  test('anything under the ExplainIT home is denied (hooks, sessions, state, journal)', () => {
    for (const rel of ['hooks/explainit-hook.js', 'hooks/explainit-hook.sh', 'sessions/1.json', 'state.json', 'workspaces/x/journal.jsonl', 'workspaces/x/checkpoints/1.snap']) {
      const r = checkWritePolicy(modify(path.join(home, rel), null, 'x'), ctx);
      assert.equal(r.action, 'deny', rel);
      assert.match((r as { reason: string }).reason, /ExplainIT/);
    }
  });

  test('the hook script path from extraProtected is denied even outside the home', () => {
    const script = path.join(root, 'elsewhere', 'explainit-hook.js');
    const r = checkWritePolicy(modify(script, null, 'x'), { ...ctx, extraProtected: [script] });
    assert.equal(r.action, 'deny');
  });

  test('.git/info/exclude in any folder is denied', () => {
    assert.equal(isGitInfoExclude(path.join(ws, '.git', 'info', 'exclude')), true);
    assert.equal(isGitInfoExclude(path.join(ws, 'exclude')), false);
    const r = checkWritePolicy(modify(path.join(ws, '.git', 'info', 'exclude'), '*_explain.txt\n', ''), ctx);
    assert.equal(r.action, 'deny');
    assert.match((r as { reason: string }).reason, /twin/);
  });

  test('.git/hooks/** and .git/config are denied outright: git runs them as the person, outside any review (F2)', () => {
    for (const rel of [['.git', 'hooks', 'pre-commit'], ['.git', 'hooks', 'pre-commit.sample'], ['.git', 'hooks', 'nested', 'x'], ['.git', 'hooks'], ['.git', 'config'], ['sub', 'repo', '.git', 'config']]) {
      const p = path.join(ws, ...rel);
      assert.equal(isGitHooksOrConfig(p), true, rel.join('/'));
      const r = checkWritePolicy(modify(p, null, '#!/bin/sh'), ctx);
      assert.equal(r.action, 'deny', rel.join('/'));
      assert.match((r as { reason: string }).reason, /git hook or the git config/);
    }
    // A move onto them or a delete of them is refused too.
    assert.equal(checkWritePolicy({ kind: 'move', path: path.join(ws, 'x.sh'), newPath: path.join(ws, '.git', 'hooks', 'pre-push'), before: 'x', after: 'x' }, ctx).action, 'deny');
    assert.equal(checkWritePolicy({ kind: 'delete', path: path.join(ws, '.git', 'config'), before: 'x', after: null }, ctx).action, 'deny');
    // Names that only look similar are not git hooks or the git config.
    for (const rel of [['.git', 'config.lock'], ['.git', 'info', 'config'], ['src', 'hooks', 'x.py'], ['config'], ['hooks', 'pre-commit']]) {
      assert.equal(isGitHooksOrConfig(path.join(ws, ...rel)), false, rel.join('/'));
    }
  });

  test('other .git/** writes -> ask with a warning', () => {
    assert.equal(isInsideGitDir(path.join(ws, '.git', 'HEAD')), true);
    assert.equal(isInsideGitDir(path.join(ws, 'src', 'git.py')), false);
    for (const rel of [['.git', 'HEAD'], ['.git', 'refs', 'heads', 'main'], ['.git', 'info', 'attributes'], ['.git', 'config.lock']]) {
      const r = checkWritePolicy(modify(path.join(ws, ...rel), null, 'x'), ctx);
      assert.equal(r.action, 'ask', rel.join('/'));
      assert.match((r as { warning: string }).warning, /\.git folder/);
    }
  });

  suite('claude settings hooks diff', () => {
    const settings = (hooks: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ model: 'x', hooks, ...extra }, null, 2);
    const hooks = { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: '/x/explainit-hook.sh --agent claude' }] }] };

    test('claudeHooksChanged: same hooks in a different key order or formatting -> unchanged', () => {
      const a = settings(hooks, { a: 1 });
      const b = JSON.stringify({ hooks: JSON.parse(JSON.stringify(hooks)), model: 'x', a: 2 });
      assert.equal(claudeHooksChanged(a, b), false);
    });
    test('claudeHooksChanged: removing or editing a hook -> changed; unparseable -> unparseable', () => {
      assert.equal(claudeHooksChanged(settings(hooks), settings({})), true);
      assert.equal(claudeHooksChanged(settings(hooks), settings({ ...hooks, PostToolUse: [] })), true);
      assert.equal(claudeHooksChanged(settings(hooks), '{ nope'), 'unparseable');
      assert.equal(claudeHooksChanged(null, settings({})), false);
      assert.equal(claudeHooksChanged(null, settings(hooks)), true);
    });
    for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
      for (const base of ['user', 'folder']) {
        test(`${base} ${rel}: changing a non-hook key is allowed, changing hooks is denied, bad JSON is denied`, () => {
          const p = path.join(base === 'user' ? userHome : ws, rel);
          const before = settings(hooks, { theme: 'dark' });
          assert.deepEqual(checkWritePolicy(modify(p, before, settings(hooks, { theme: 'light' })), ctx), { action: 'allow' });
          const denied = checkWritePolicy(modify(p, before, settings({}, { theme: 'light' })), ctx);
          assert.equal(denied.action, 'deny');
          assert.match((denied as { reason: string }).reason, /hooks/);
          assert.equal(checkWritePolicy(modify(p, before, '{ broken'), ctx).action, 'deny');
          assert.equal(checkWritePolicy({ kind: 'delete', path: p, before, after: null }, ctx).action, 'deny');
        });
      }
    }
  });

  suite('codex config diff', () => {
    const toml = `model = "gpt-5"\n\n[features]\nhooks = true\n\n[hooks]\ncommand = "/x/explainit-hook.sh"\n\n[hooks.state]\ntrusted = ["abc"]\n\n[tui]\ntheme = "dark"\n`;
    test('codexHookLines picks hooks lines and the [features] block', () => {
      assert.deepEqual(codexHookLines(toml), ['[features]', 'hooks = true', '[hooks]', 'command = "/x/explainit-hook.sh"', '[hooks.state]', 'trusted = ["abc"]']);
      assert.deepEqual(codexHookLines(null), []);
    });
    test('config.toml: changing theme is allowed; disabling the hooks feature or the hook command is denied', () => {
      const p = path.join(userHome, '.codex', 'config.toml');
      assert.deepEqual(checkWritePolicy(modify(p, toml, toml.replace('theme = "dark"', 'theme = "light"')), ctx), { action: 'allow' });
      assert.equal(checkWritePolicy(modify(p, toml, toml.replace('hooks = true', 'hooks = false')), ctx).action, 'deny');
      assert.equal(checkWritePolicy(modify(p, toml, toml.replace('[hooks]\ncommand = "/x/explainit-hook.sh"\n', '')), ctx).action, 'deny');
      assert.equal(codexHooksChanged('config.toml', toml, toml + '\n# comment mentioning hooks\n'), false);
    });
    test('folder-level .codex/hooks.json: any content change denied, formatting change allowed, bad JSON denied', () => {
      const p = path.join(ws, '.codex', 'hooks.json');
      const before = '{"hooks": {"PreToolUse": [{"matcher": "apply_patch"}]}}';
      assert.deepEqual(checkWritePolicy(modify(p, before, JSON.stringify(JSON.parse(before), null, 2)), ctx), { action: 'allow' });
      assert.equal(checkWritePolicy(modify(p, before, '{"hooks": {}}'), ctx).action, 'deny');
      assert.equal(checkWritePolicy(modify(p, before, 'nope'), ctx).action, 'deny');
      assert.equal(codexHooksChanged('hooks.json', null, '{}'), false);
    });
  });

  suite('hook script parity: partial edits replayed onto the full file', () => {
    const CMD = '/x/hooks/explainit-hook.sh --agent claude';
    const MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
    const PRE_ENTRY = `      { "matcher": "${MATCHER}", "hooks": [{ "type": "command", "command": "${CMD}", "timeout": 7200 }] }\n`;
    const POST_ENTRY = `      { "matcher": "${MATCHER}", "hooks": [{ "type": "command", "command": "${CMD} --event PostToolUse", "timeout": 10 }] }\n`;
    const settingsText = `{\n  "model": "opus",\n  "hooks": {\n    "PreToolUse": [\n${PRE_ENTRY}    ],\n    "PostToolUse": [\n${POST_ENTRY}    ]\n  },\n  "theme": "dark"\n}\n`;
    const toml = ['model = "gpt-5"', '', '[features]', 'hooks = true', '', '[hooks.state."abc"]', 'trusted_hash = "sha256:1111"', 'enabled = true', '', '[hooks.state."def"]', 'trusted_hash = "sha256:2222"', '', '[tui]', 'theme = "dark"', ''].join('\n');
    const edited = (before: string, old_string: string, new_string: string): string => {
      const r = applyEdit(before, { old_string, new_string });
      assert.equal(r.ok, true, 'fixture edit must apply');
      return (r as { after: string }).after;
    };

    test('Edit that swaps "--agent claude" for "--agent x" inside our hook entry -> deny', () => {
      const p = path.join(userHome, '.claude', 'settings.json');
      assert.ok(JSON.parse(settingsText), 'fixture is valid JSON');
      const after = edited(settingsText, '--agent claude"', '--agent x"');
      const r = checkWritePolicy(modify(p, settingsText, after), ctx, { partial: true });
      assert.equal(r.action, 'deny');
      assert.match((r as { reason: string }).reason, /hooks/);
    });

    test('Edit that changes an unrelated setting in settings.json -> allow (normal flow)', () => {
      const p = path.join(userHome, '.claude', 'settings.json');
      const after = edited(settingsText, '"theme": "dark"', '"theme": "light"');
      assert.deepEqual(checkWritePolicy(modify(p, settingsText, after), ctx, { partial: true }), { action: 'allow' });
      // Reformatting the whole file without touching hooks is fine too.
      assert.deepEqual(checkWritePolicy(modify(p, settingsText, JSON.stringify(JSON.parse(settingsText))), ctx), { action: 'allow' });
    });

    test('MultiEdit that removes our entry -> deny; unparseable result -> deny', () => {
      const p = path.join(ws, '.claude', 'settings.json');
      const removed = applyEdits(settingsText, [
        { old_string: '"theme": "dark"', new_string: '"theme": "light"' },
        { old_string: PRE_ENTRY, new_string: '' },
      ]);
      assert.equal(removed.ok, true);
      assert.ok(JSON.parse((removed as { after: string }).after), 'the result is still valid JSON, only our entry is gone');
      const r = checkWritePolicy(modify(p, settingsText, (removed as { after: string }).after), ctx, { partial: true });
      assert.equal(r.action, 'deny');
      // Deleting the closing brace leaves invalid JSON: the hooks cannot be verified, so deny.
      const broken = edited(settingsText, '"timeout": 7200', '"timeout": 7200,');
      const b = checkWritePolicy(modify(p, settingsText, broken), ctx, { partial: true });
      assert.equal(b.action, 'deny');
      assert.match((b as { reason: string }).reason, /not valid JSON/);
    });

    test('a .claude/settings.json in a sub-folder of the workspace is protected the same way', () => {
      const p = path.join(ws, 'packages', 'api', '.claude', 'settings.local.json');
      assert.equal(checkWritePolicy(modify(p, settingsText, edited(settingsText, '--agent claude"', '--agent x"')), ctx).action, 'deny');
      assert.deepEqual(checkWritePolicy(modify(p, settingsText, edited(settingsText, '"dark"', '"light"')), ctx), { action: 'allow' });
    });

    test('config.toml edit that changes trusted_hash, a sha256 value or an enabled switch -> deny', () => {
      const p = path.join(userHome, '.codex', 'config.toml');
      for (const [from, to] of [
        ['trusted_hash = "sha256:1111"', 'trusted_hash = "sha256:9999"'],
        ['sha256:2222', 'sha256:0000'],
        ['enabled = true', 'enabled = false'],
        ['hooks = true', 'hooks = false'],
      ]) {
        const r = checkWritePolicy(modify(p, toml, edited(toml, from, to)), ctx, { partial: true });
        assert.equal(r.action, 'deny', `${from} -> ${to}`);
        assert.match((r as { reason: string }).reason, /hook/);
      }
      assert.deepEqual(checkWritePolicy(modify(p, toml, edited(toml, 'theme = "dark"', 'theme = "light"')), ctx, { partial: true }), { action: 'allow' });
    });

    test('config.toml: swapping the trust hashes of two hooks keeps the same set of lines but is still a change', () => {
      const swapped = toml.replace('sha256:1111', 'TMP').replace('sha256:2222', 'sha256:1111').replace('TMP', 'sha256:2222');
      assert.equal(codexHooksChanged('config.toml', toml, swapped), true);
      assert.equal(codexHooksChanged('config.toml', toml, toml), false);
      assert.equal(codexHooksChanged('config.toml', toml, toml.replace(/\n/g, '\r\n')), false, 'line endings do not matter');
    });

    test('config.toml: a trusted_hash line outside any hooks table is still compared, and so is a header naming explainit', () => {
      const flat = 'trusted_hash = "sha256:aaaa"\nmodel = "x"\n\n[projects."/home/me/explainit"]\ntrust_level = "trusted"\n';
      assert.deepEqual(codexHookLines(flat), ['trusted_hash = "sha256:aaaa"', '[projects."/home/me/explainit"]']);
      assert.equal(codexHooksChanged('config.toml', flat, flat.replace('aaaa', 'bbbb')), true);
      assert.equal(codexHooksChanged('config.toml', flat, flat.replace('/home/me/explainit', '/home/me/other')), true);
    });

    test('unparseable TOML -> unparseable -> deny', () => {
      assert.equal(tomlLooksValid(toml), true);
      assert.equal(tomlLooksValid(null), true);
      assert.equal(tomlLooksValid('hooks = [\n  "a",\n  "b",\n]\n[features]\nhooks = true\n'), true, 'multi-line arrays are fine');
      assert.equal(tomlLooksValid('notes = """\nfree text without equals\n"""\nx = 1\n'), true, 'multi-line strings are fine');
      assert.equal(tomlLooksValid('[hooks.state."a]b"]\ntrusted_hash = "sha256:1"\n'), true, 'brackets inside quoted keys are fine');
      assert.equal(tomlLooksValid('this is not toml\n'), false);
      assert.equal(tomlLooksValid('[features]\nhooks = true\n{{{{\n'), false);
      assert.equal(tomlLooksValid('hooks = [\n  "a",\n'), false, 'unclosed array');
      assert.equal(codexHooksChanged('config.toml', toml, 'garbage'), 'unparseable');
      const p = path.join(userHome, '.codex', 'config.toml');
      const r = checkWritePolicy(modify(p, toml, 'garbage'), ctx, { partial: true });
      assert.equal(r.action, 'deny');
      assert.match((r as { reason: string }).reason, /cannot be parsed/);
    });

    test('hooks.json: any partial edit counts as a hooks change, even a whitespace-only one', () => {
      const p = path.join(userHome, '.codex', 'hooks.json');
      const before = '{"hooks": {"PreToolUse": [{"matcher": "apply_patch"}]}}\n';
      const reformatted = JSON.stringify(JSON.parse(before), null, 2) + '\n';
      const r = checkWritePolicy(modify(p, before, reformatted), ctx, { partial: true });
      assert.equal(r.action, 'deny');
      assert.match((r as { reason: string }).reason, /nothing but hooks/);
      // A whole-file write that lands the same parsed content is not a hooks change.
      assert.deepEqual(checkWritePolicy(modify(p, before, reformatted), ctx), { action: 'allow' });
      // Unparseable proposed JSON is refused either way.
      assert.equal(checkWritePolicy(modify(p, before, '{"hooks": '), ctx).action, 'deny');
      assert.equal(checkWritePolicy(modify(p, before, '{"hooks": '), ctx, { partial: true }).action, 'deny');
    });

    test('CODEX_HOME: hooks.json and config.toml are resolved under it', () => {
      const codexHome = path.join(root, 'codex-home');
      fs.mkdirSync(codexHome, { recursive: true });
      const withHome: PolicyContext = { ...ctx, codexHome };
      assert.equal(codexHomeOf(withHome), codexHome);
      assert.equal(codexHomeOf(ctx), path.join(userHome, '.codex'));
      assert.equal(codexHomeOf({ ...ctx, codexHome: '  ' }), path.join(userHome, '.codex'), 'blank CODEX_HOME means the default');
      const hooksJson = path.join(codexHome, 'hooks.json');
      const configToml = path.join(codexHome, 'config.toml');
      assert.equal(checkWritePolicy(modify(hooksJson, '{}', '{"hooks": {"PreToolUse": []}}'), withHome).action, 'deny');
      assert.equal(checkWritePolicy(modify(hooksJson, '{}', '{}'), withHome, { partial: true }).action, 'deny');
      assert.equal(checkWritePolicy(modify(configToml, toml, edited(toml, 'sha256:1111', 'sha256:9999')), withHome).action, 'deny');
      assert.deepEqual(checkWritePolicy(modify(configToml, toml, edited(toml, 'theme = "dark"', 'theme = "light"')), withHome), { action: 'allow' });
      assert.equal(checkWritePolicy({ kind: 'delete', path: hooksJson, before: '{}', after: null }, withHome).action, 'deny');
      // Without CODEX_HOME the same folder is an ordinary place (outside the workspace).
      assert.deepEqual(checkWritePolicy(modify(hooksJson, '{}', '{"hooks": {"PreToolUse": []}}'), ctx), { action: 'allow' });
      // Shell mentions of the CODEX_HOME files are caught as well, in any letter case.
      assert.ok(protectedPathMentioned(`cat ${configToml}`, withHome));
      assert.ok(protectedPathMentioned(`cat ${hooksJson.toUpperCase()}`, withHome));
      assert.equal(protectedPathMentioned(`cat ${configToml}`, ctx), undefined);
    });
  });

  test('a move whose destination is protected is denied', () => {
    const r = checkWritePolicy({ kind: 'move', path: path.join(ws, 'a.py'), newPath: path.join(ws, '.git', 'info', 'exclude'), before: 'x', after: 'x' }, ctx);
    assert.equal(r.action, 'deny');
  });

  test('symlink escaping the workspace resolves outside', function () {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.py'), 'x');
    try {
      fs.symlinkSync(outside, path.join(ws, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      this.skip();
    }
    const r = resolveTarget('link/secret.py', ws, [ws]);
    assert.equal(r.confinement, 'outside');
    assert.equal(r.folder, undefined);
    assert.equal(resolveTarget('src/app.py', ws, [ws]).confinement, 'inside');
    assert.equal(resolveTarget('../outside/secret.py', ws, [ws]).confinement, 'outside');
  });

  suite('protectedPathMentioned (shell commands)', () => {
    test('mentions of the home, settings, codex config, exclude and the hook script are caught', () => {
      assert.ok(protectedPathMentioned(`cat ${path.join(home, 'state.json')}`, ctx));
      assert.ok(protectedPathMentioned('rm ~/.claude/settings.json', ctx));
      assert.ok(protectedPathMentioned(`echo x > ${path.join(userHome, '.codex', 'config.toml')}`, ctx));
      assert.ok(protectedPathMentioned('echo "" > .git/info/exclude', ctx));
      assert.ok(protectedPathMentioned('chmod -x ~/.explainit/hooks/explainit-hook.sh', ctx));
      assert.ok(protectedPathMentioned(`sed -i "" ${path.join(ws, '.git', 'info', 'exclude')}`, ctx));
    });
    test('git hooks, the git config and core.hooksPath are caught (F2)', () => {
      assert.ok(protectedPathMentioned('cp evil.sh .git/hooks/pre-commit', ctx));
      assert.ok(protectedPathMentioned('echo "[core]" >> .git/config', ctx));
      assert.ok(protectedPathMentioned('git config core.hooksPath /tmp/hooks', ctx));
      assert.ok(protectedPathMentioned('git config --global core.hookspath ~/h', ctx));
    });
    test('benign commands are not flagged', () => {
      assert.equal(protectedPathMentioned('npm test', ctx), undefined);
      assert.equal(protectedPathMentioned('git status', ctx), undefined);
      assert.equal(protectedPathMentioned('git config --get user.name', ctx), undefined);
      assert.equal(protectedPathMentioned(`cat ${path.join(ws, 'src', 'app.py')}`, ctx), undefined);
    });
  });

  suite('shellProtectedTarget: writes resolved against the effective cwd (F4)', () => {
    const analyse = (cmd: string, cwd?: string) => analyseCommand(cmd, { cwd: cwd ?? ws, home: userHome, explainitHome: home, codexHome: codexHomeOf(ctx) });
    const hitOf = (cmd: string, cwd?: string) => shellProtectedTarget(analyse(cmd, cwd), ctx);

    test('cd / pushd into a protected directory is refused even though no token names a protected file', () => {
      const cd = hitOf('cd ~/.claude && cat > settings.json');
      assert.equal(cd?.kind, 'directory');
      assert.equal(cd?.path, path.join(userHome, '.claude'));
      assert.match(protectedShellReason(cd!), /changes into/);
      const sub = hitOf('(cd ~/.explainit/sessions && echo x > 1.json)');
      assert.equal(sub?.kind, 'directory');
      assert.equal(sub?.path, path.join(userHome, '.explainit', 'sessions'));
      const pushd = hitOf('pushd ~/.codex; tee hooks.json');
      assert.equal(pushd?.kind, 'directory');
      assert.equal(pushd?.path, path.join(userHome, '.codex'));
      // An absolute path spelled either way: as the shell would write it (forward slashes) and as
      // Windows writes it (backslashes, drive letter). `home` comes from path.resolve, so on Windows
      // it carries the drive letter that the analyser's own path.resolve adds to relative targets.
      assert.equal(path.resolve(home), home, 'the sandbox roots are fully resolved paths');
      assert.equal(hitOf(`cd ${home.replace(/\\/g, '/')}/hooks && ls`)?.kind, 'directory', 'POSIX spelling');
      assert.equal(hitOf(`cd ${home}${path.sep}hooks && ls`)?.kind, 'directory', 'native spelling');
      assert.equal(hitOf('cd .git/hooks && ls')?.kind, 'directory');
      assert.equal(hitOf('bash -c "cd ~/.claude && cat > settings.json"')?.kind, 'directory');
    });

    test('Windows spellings are protected too: drive letters, backslashes and (on win32) any case', () => {
      // Runs on every platform: the analyser and the policy both understand `C:\...` paths, so the
      // Windows behaviour is proved here rather than only on a Windows runner.
      const winCtx: PolicyContext = { explainitHome: 'C:\\Users\\me\\.explainit', userHome: 'C:\\Users\\me', folders: ['C:\\work\\repo'] };
      const winHit = (cmd: string, cwd = 'C:\\work\\repo') => shellProtectedTarget(analyseCommand(cmd, { cwd, home: 'C:\\Users\\me' }), winCtx);
      assert.equal(winHit('cd C:\\Users\\me\\.claude && cat > settings.json')?.kind, 'directory');
      assert.equal(winHit('cd "C:\\Users\\me\\.explainit\\sessions" && echo x > 1.json')?.kind, 'directory');
      assert.equal(winHit('cd C:\\work\\repo\\.git\\hooks && ls')?.kind, 'directory');
      assert.equal(isProtectedDirectory('C:\\Users\\me\\.codex\\sub', winCtx), true);
      assert.equal(isProtectedDirectory('C:\\work\\repo\\src', winCtx), false);
      if (process.platform === 'win32') {
        // Windows file names are case-insensitive, so `.GIT\config` is `.git\config`.
        assert.equal(isGitHooksOrConfig('C:\\work\\repo\\.GIT\\Config'), true);
        assert.equal(isGitInfoExclude('C:\\work\\repo\\.Git\\info\\exclude'), true);
        assert.equal(isInsideGitDir('C:\\work\\repo\\.GIT\\refs\\heads\\main'), true);
      }
    });

    test('isProtectedDirectory: the ExplainIT home, the user-layer .claude / .codex folders, CODEX_HOME, and any .claude / .codex / .explainit / .git folder', () => {
      assert.equal(isProtectedDirectory(home, ctx), true);
      assert.equal(isProtectedDirectory(path.join(home, 'sessions'), ctx), true);
      assert.equal(isProtectedDirectory(path.join(userHome, '.claude'), ctx), true);
      assert.equal(isProtectedDirectory(path.join(userHome, '.codex', 'sub'), ctx), true);
      assert.equal(isProtectedDirectory(path.join(ws, '.git'), ctx), true);
      assert.equal(isProtectedDirectory(path.join(ws, 'packages', 'api', '.claude'), ctx), true);
      const codexHome = path.join(root, 'codex-home');
      assert.equal(isProtectedDirectory(codexHome, { ...ctx, codexHome }), true);
      assert.equal(isProtectedDirectory(codexHome, ctx), false);
      assert.equal(isProtectedDirectory(ws, ctx), false);
      assert.equal(isProtectedDirectory(path.join(ws, 'src'), ctx), false);
      assert.equal(isProtectedDirectory(userHome, ctx), false);
    });

    test('redirect, tee, heredoc and in-place targets are resolved against the cwd of their segment', () => {
      const claude = path.join(userHome, '.claude');
      // No cd in the command, but the agent already runs inside the protected folder.
      const redirect = hitOf('cat > settings.json', claude);
      assert.equal(redirect?.kind, 'file');
      assert.equal(redirect?.path, path.join(claude, 'settings.json'));
      assert.match(protectedShellReason(redirect!), /Claude Code settings/);
      assert.equal(hitOf('cat <<EOF > settings.local.json\n{}\nEOF', claude)?.kind, 'file');
      assert.equal(hitOf('printf x | tee -a config.toml', path.join(userHome, '.codex'))?.kind, 'file');
      assert.equal(hitOf('sed -i "s/a/b/" exclude', path.join(ws, '.git', 'info'))?.kind, 'file');
      assert.equal(hitOf('cd src && cd ../.git/info && echo "" > exclude')?.kind, 'directory', 'the cd into .git is refused first');
      assert.equal(hitOf('cp evil ../hooks/pre-commit', path.join(ws, '.git', 'info'))?.kind, 'file');
      assert.equal(hitOf('chmod +x .git/hooks/pre-commit')?.what, 'a git hook or the git config, which git runs outside any review');
      assert.equal(hitOf('echo x > $CODEX_HOME/hooks.json')?.path, path.join(userHome, '.codex', 'hooks.json'), 'CODEX_HOME unset: the default codex home is the user one');
      const codexHome = path.join(root, 'codex-home');
      const withHome = { ...ctx, codexHome };
      const spelled = shellProtectedTarget(analyseCommand('echo x > $CODEX_HOME/hooks.json', { cwd: ws, home: userHome, codexHome }), withHome);
      assert.equal(spelled?.path, path.join(codexHome, 'hooks.json'));
      assert.equal(shellProtectedTarget(analyseCommand('echo x > $EXPLAINIT_HOME/state.json', { cwd: ws, home: userHome, explainitHome: home }), ctx)?.kind, 'file');
    });

    test('git config writes .git/config (or the global git config); reads do not', () => {
      const local = hitOf('git config user.name "A"');
      assert.equal(local?.kind, 'file');
      assert.equal(local?.path, path.join(ws, '.git', 'config'));
      assert.equal(hitOf('git -C src config user.name "A"')?.path, path.join(ws, 'src', '.git', 'config'));
      const global = hitOf('git config --global user.email a@b.c');
      assert.equal(global?.path, path.join(userHome, '.gitconfig'));
      assert.match(global?.what ?? '', /global git config/);
      assert.equal(hitOf('git config --unset user.name')?.kind, 'file');
      assert.equal(hitOf('git config --file other.ini user.name x')?.kind, undefined, 'an ordinary file is not protected');
      assert.equal(hitOf('git config --get user.name'), undefined);
      assert.equal(hitOf('git config --list'), undefined);
      assert.equal(hitOf('git config -l'), undefined);
    });

    test('ordinary commands are not hit', () => {
      assert.equal(hitOf('cd src && echo x > a.py'), undefined);
      assert.equal(hitOf('npm test > log.txt'), undefined);
      assert.equal(hitOf('cd /tmp && ls'), undefined);
      assert.equal(hitOf('cd && ls'), undefined, 'a bare cd goes to the home folder, which is not protected');
      assert.equal(hitOf('pushd src; popd; echo x > notes.txt'), undefined);
    });
  });
});
