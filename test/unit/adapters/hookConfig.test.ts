import * as assert from 'node:assert';
import {
  claudeEntrySpecs,
  codexEntrySpecs,
  configHashFor,
  entriesMatch,
  findOurEntries,
  isOurHook,
  parseJsonFile,
  removeOurEntries,
  stringifyJsonFile,
  upsertOurEntries,
} from '../../../src/adapters/pure/hookConfig';

const WRAPPER = '"/Users/me/.explainit/hooks/explainit-hook.sh"';

function userSettings(): Record<string, any> {
  return {
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/lint-guard.sh', timeout: 30 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
    },
  };
}

suite('adapters/pure/hookConfig', () => {
  test('claude specs carry the watchdog and PostToolUse variant', () => {
    const specs = claudeEntrySpecs(WRAPPER, 90);
    assert.strictEqual(specs.length, 2);
    assert.strictEqual(specs[0].event, 'PreToolUse');
    assert.strictEqual(specs[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|Bash');
    assert.strictEqual(specs[0].command, `${WRAPPER} --agent claude --watchdog 90`);
    assert.strictEqual(specs[0].timeout, 7200);
    assert.strictEqual(specs[1].event, 'PostToolUse');
    assert.strictEqual(specs[1].matcher, 'Write|Edit|MultiEdit|NotebookEdit');
    assert.strictEqual(specs[1].command, `${WRAPPER} --agent claude --event PostToolUse`);
    assert.strictEqual(specs[1].timeout, 10);
  });

  test('codex specs use the codex matchers and agent flag', () => {
    const specs = codexEntrySpecs(WRAPPER, 120);
    assert.strictEqual(specs[0].matcher, 'apply_patch|Edit|Write|Bash');
    assert.strictEqual(specs[0].command, `${WRAPPER} --agent codex --watchdog 120`);
    assert.strictEqual(specs[1].matcher, 'apply_patch|Edit|Write');
    assert.ok(specs[1].command.includes('--event PostToolUse'));
  });

  test('watchdog below 30 s is clamped and a bad value falls back to 120', () => {
    assert.ok(claudeEntrySpecs(WRAPPER, 5)[0].command.endsWith('--watchdog 30'));
    assert.ok(claudeEntrySpecs(WRAPPER, NaN)[0].command.endsWith('--watchdog 120'));
  });

  test('isOurHook recognises only commands containing explainit-hook', () => {
    assert.ok(isOurHook({ type: 'command', command: `${WRAPPER} --agent claude` }));
    assert.ok(!isOurHook({ type: 'command', command: '/bin/other.sh' }));
    assert.ok(!isOurHook({ type: 'prompt', prompt: 'explainit-hook' }));
    assert.ok(!isOurHook(null));
  });

  test('upsert preserves unrelated hooks and settings, appends ours', () => {
    const root = userSettings();
    const changed = upsertOurEntries(root, claudeEntrySpecs(WRAPPER, 120));
    assert.ok(changed);
    assert.strictEqual(root.model, 'opus');
    assert.deepStrictEqual(root.permissions, { allow: ['Bash(npm test)'] });
    assert.strictEqual(root.hooks.PreToolUse.length, 2);
    assert.strictEqual(root.hooks.PreToolUse[0].hooks[0].command, '/usr/local/bin/lint-guard.sh');
    assert.strictEqual(root.hooks.PreToolUse[1].matcher, 'Write|Edit|MultiEdit|NotebookEdit|Bash');
    assert.strictEqual(root.hooks.PostToolUse.length, 1);
    assert.strictEqual(root.hooks.SessionStart.length, 1);
    assert.strictEqual(findOurEntries(root).length, 2);
  });

  test('upsert is idempotent and replaces stale entries of ours', () => {
    const root = userSettings();
    upsertOurEntries(root, claudeEntrySpecs(WRAPPER, 120));
    const again = upsertOurEntries(root, claudeEntrySpecs(WRAPPER, 120));
    assert.strictEqual(again, false);
    const replaced = upsertOurEntries(root, claudeEntrySpecs(WRAPPER, 300));
    assert.ok(replaced);
    const ours = findOurEntries(root);
    assert.strictEqual(ours.length, 2);
    assert.ok(ours.find((e) => e.event === 'PreToolUse')!.command.endsWith('--watchdog 300'));
    assert.strictEqual(root.hooks.PreToolUse.length, 2, 'stale group removed, not duplicated');
  });

  test('removal leaves other hooks intact and drops empty containers', () => {
    const root = userSettings();
    upsertOurEntries(root, claudeEntrySpecs(WRAPPER, 120));
    assert.ok(removeOurEntries(root));
    assert.deepStrictEqual(root.hooks, userSettings().hooks);
    assert.strictEqual(removeOurEntries(root), false);
    const only: Record<string, any> = { hooks: {} };
    upsertOurEntries(only, codexEntrySpecs(WRAPPER, 120));
    removeOurEntries(only);
    assert.strictEqual(only.hooks, undefined, 'empty hooks object removed');
  });

  test('a mixed group keeps the other handler when ours is removed', () => {
    const root: Record<string, any> = {
      hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'a.sh' }, { type: 'command', command: 'x/explainit-hook.sh --agent claude' }] }] },
    };
    removeOurEntries(root);
    assert.deepStrictEqual(root.hooks.PreToolUse, [{ matcher: 'Write', hooks: [{ type: 'command', command: 'a.sh' }] }]);
  });

  test('entriesMatch detects missing, changed and extra entries', () => {
    const specs = claudeEntrySpecs(WRAPPER, 120);
    const root = userSettings();
    assert.strictEqual(entriesMatch(root, specs).ok, false);
    upsertOurEntries(root, specs);
    assert.strictEqual(entriesMatch(root, specs).ok, true);
    root.hooks.PreToolUse[1].hooks[0].timeout = 5;
    const m = entriesMatch(root, specs);
    assert.strictEqual(m.ok, false);
    assert.match(m.detail, /PreToolUse/);
    root.hooks.PreToolUse[1].hooks[0].timeout = 7200;
    root.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'x/explainit-hook.sh --agent claude' }] });
    assert.match(entriesMatch(root, specs).detail, /unexpected/);
  });

  test('configHashFor is stable and changes with the watchdog', () => {
    assert.strictEqual(configHashFor(claudeEntrySpecs(WRAPPER, 120)), configHashFor(claudeEntrySpecs(WRAPPER, 120)));
    assert.notStrictEqual(configHashFor(claudeEntrySpecs(WRAPPER, 120)), configHashFor(claudeEntrySpecs(WRAPPER, 121)));
  });

  test('parseJsonFile keeps indent, EOL and trailing newline; stringify reproduces them', () => {
    const text = '{\r\n\t"a": 1\r\n}\r\n';
    const p = parseJsonFile(text);
    assert.deepStrictEqual(p.value, { a: 1 });
    assert.strictEqual(p.indent, '\t');
    assert.strictEqual(p.eol, '\r\n');
    assert.strictEqual(p.trailingNewline, true);
    assert.strictEqual(stringifyJsonFile(p.value!, p), text);
    const noNl = parseJsonFile('{"a":1}');
    assert.strictEqual(noNl.trailingNewline, false);
    assert.strictEqual(stringifyJsonFile({ a: 1 }, noNl), '{\n  "a": 1\n}');
  });

  test('parseJsonFile handles missing, empty, BOM and invalid files', () => {
    assert.deepStrictEqual(parseJsonFile(undefined).value, {});
    assert.deepStrictEqual(parseJsonFile('  \n').value, {});
    assert.deepStrictEqual(parseJsonFile('﻿{"x":true}').value, { x: true });
    const bad = parseJsonFile('{ nope');
    assert.strictEqual(bad.value, undefined);
    assert.ok(bad.error);
    assert.strictEqual(parseJsonFile('[1]').value, undefined);
  });
});
