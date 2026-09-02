import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { categorize, commandText, resolveTarget, targetPathOf, validateEnvelope } from '../../../src/gate/pure/ingress';

const payload = (toolName: string, toolInput: unknown, extra: Record<string, unknown> = {}) => ({
  session_id: 's',
  cwd: '/ws',
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 't1',
  ...extra,
});

suite('gate/pure/ingress: validateEnvelope', () => {
  test('valid claude Write envelope', () => {
    const r = validateEnvelope({ agent: 'claude', event: 'PreToolUse', payload: payload('Write', { file_path: 'a.py', content: 'x' }) });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.category, 'write');
      assert.equal(r.sessionId, 's');
      assert.equal(r.cwd, '/ws');
      assert.equal(r.toolUseId, 't1');
    }
  });

  const bad: [string, unknown, RegExp][] = [
    ['non-object body', 'hello', /envelope is not valid/],
    ['null body', null, /envelope is not valid/],
    ['unknown agent', { agent: 'copilot', event: 'PreToolUse', payload: payload('Write', {}) }, /Unknown agent "copilot"/],
    ['bad event', { agent: 'claude', event: 'Stop', payload: payload('Write', {}) }, /event/],
    ['missing payload', { agent: 'claude', event: 'PreToolUse' }, /payload/],
    ['payload without tool_name', { agent: 'claude', event: 'PreToolUse', payload: { tool_input: {} } }, /tool_name/],
    ['tool_input not an object', { agent: 'claude', event: 'PreToolUse', payload: payload('Write', 'str') }, /tool_input/],
    ['Write without content', { agent: 'claude', event: 'PreToolUse', payload: payload('Write', { file_path: 'a' }) }, /content/],
    ['Edit with numeric file_path', { agent: 'claude', event: 'PreToolUse', payload: payload('Edit', { file_path: 3, old_string: 'a', new_string: 'b' }) }, /file_path/],
    ['MultiEdit with empty edits', { agent: 'claude', event: 'PreToolUse', payload: payload('MultiEdit', { file_path: 'a', edits: [] }) }, /edits/],
    ['Bash without command', { agent: 'claude', event: 'PreToolUse', payload: payload('Bash', { description: 'x' }) }, /Bash/],
    ['codex apply_patch without any patch field', { agent: 'codex', event: 'PreToolUse', payload: payload('apply_patch', { foo: 1 }) }, /apply_patch/],
  ];
  for (const [name, body, re] of bad) {
    test(`400 shape: ${name}`, () => {
      const r = validateEnvelope(body);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.status, 400);
        assert.match(r.error, re);
      }
    });
  }

  test('irrelevant tools are accepted without tool_input validation', () => {
    const r = validateEnvelope({ agent: 'claude', event: 'PreToolUse', payload: payload('Read', { whatever: 1 }) });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.category, 'irrelevant');
  });

  test('missing session_id and cwd fall back to defaults', () => {
    const r = validateEnvelope({ agent: 'claude', event: 'PostToolUse', payload: { tool_name: 'Write', tool_input: { file_path: 'a', content: '' } } });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.sessionId, 'unknown-session');
      assert.ok(path.isAbsolute(r.cwd));
    }
  });
});

suite('gate/pure/ingress: categorize', () => {
  test('claude tools', () => {
    assert.equal(categorize('claude', 'Write'), 'write');
    assert.equal(categorize('claude', 'Edit'), 'edit');
    assert.equal(categorize('claude', 'MultiEdit'), 'multiedit');
    assert.equal(categorize('claude', 'NotebookEdit'), 'notebook');
    assert.equal(categorize('claude', 'Bash'), 'shell');
    assert.equal(categorize('claude', 'Read'), 'irrelevant');
    assert.equal(categorize('claude', 'apply_patch'), 'irrelevant');
  });
  test('codex tools, including apply_patch through the shell', () => {
    assert.equal(categorize('codex', 'apply_patch'), 'patch');
    assert.equal(categorize('codex', 'shell', { command: ['bash', '-lc', 'ls'] }), 'shell');
    assert.equal(categorize('codex', 'shell', { command: ['apply_patch', '*** Begin Patch\n*** End Patch'] }), 'patch');
    assert.equal(categorize('codex', 'local_shell', { command: 'ls' }), 'shell');
    assert.equal(categorize('codex', 'shell_command', { command: 'ls' }), 'shell');
    assert.equal(categorize('codex', 'Write'), 'write');
    assert.equal(categorize('codex', 'view_image'), 'irrelevant');
    assert.equal(categorize('copilot', 'Write'), 'irrelevant');
  });
});

suite('gate/pure/ingress: helpers', () => {
  test('commandText joins argv arrays', () => {
    assert.equal(commandText({ command: ['bash', '-lc', 'ls -la'] }), 'bash -lc ls -la');
    assert.equal(commandText({ command: 'ls' }), 'ls');
    assert.equal(commandText({}), '');
  });
  test('targetPathOf prefers file_path, then notebook_path, then path', () => {
    assert.equal(targetPathOf({ file_path: 'a', notebook_path: 'b' }), 'a');
    assert.equal(targetPathOf({ notebook_path: 'b' }), 'b');
    assert.equal(targetPathOf({ path: 'c' }), 'c');
    assert.equal(targetPathOf({}), undefined);
  });
  test('resolveTarget resolves relative paths against cwd and reports confinement', () => {
    const cwd = process.cwd();
    const inside = resolveTarget('src/x.py', cwd, [cwd]);
    assert.equal(inside.confinement, 'inside');
    assert.ok(path.isAbsolute(inside.path));
    const outside = resolveTarget(path.join(cwd, '..', 'elsewhere.py'), cwd, [cwd]);
    assert.equal(outside.confinement, 'outside');
  });
});
