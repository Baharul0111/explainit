import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProposedWrite } from '../../../src/core/types';
import {
  checkWritePolicy,
  claudeHooksChanged,
  codexHookLines,
  codexHooksChanged,
  isGitInfoExclude,
  isInsideGitDir,
  protectedPathMentioned,
  type PolicyContext,
} from '../../../src/gate/pure/policy';
import { resolveTarget } from '../../../src/gate/pure/ingress';

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

  test('other .git/** writes -> ask with a warning', () => {
    assert.equal(isInsideGitDir(path.join(ws, '.git', 'config')), true);
    assert.equal(isInsideGitDir(path.join(ws, 'src', 'git.py')), false);
    const r = checkWritePolicy(modify(path.join(ws, '.git', 'hooks', 'pre-commit'), null, '#!/bin/sh'), ctx);
    assert.equal(r.action, 'ask');
    assert.match((r as { warning: string }).warning, /\.git folder/);
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
    test('benign commands are not flagged', () => {
      assert.equal(protectedPathMentioned('npm test', ctx), undefined);
      assert.equal(protectedPathMentioned('git status', ctx), undefined);
      assert.equal(protectedPathMentioned(`cat ${path.join(ws, 'src', 'app.py')}`, ctx), undefined);
    });
  });
});
