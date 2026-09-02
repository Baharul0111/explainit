import * as assert from 'node:assert';
import { CLAUDE_JSON_ARGS, RESYNTH_TASK_HEADER, buildResynthPrompt, codexExecArgs, parseClaudeJsonReply } from './resynth';

suite('eval/resynth: prompt and CLI plumbing', () => {
  const input = {
    entryPoint: 'flip_case',
    signature: 'def flip_case(string: str) -> str:',
    context: 'from typing import List',
    explanation: { summary: 'Swaps the case of every letter in a piece of text.', steps: ['It goes through each character.', 'It flips capitals and small letters.'], warnings: ['Digits are left alone.'], uncertainty: 'Accents may not flip.' },
  };

  test('the prompt carries name, signature, context and explanation — never a body', () => {
    const p = buildResynthPrompt(input);
    assert.ok(p.startsWith(RESYNTH_TASK_HEADER + '\n'));
    assert.ok(p.includes('Function name: flip_case\n'));
    assert.ok(p.includes('def flip_case(string: str) -> str:\n'));
    assert.ok(p.includes('from typing import List'));
    assert.ok(p.includes('What it does: Swaps the case of every letter in a piece of text.'));
    assert.ok(p.includes('- It goes through each character.\n- It flips capitals and small letters.'));
    assert.ok(p.includes('Watch out:\n- Digits are left alone.'));
    assert.ok(p.includes('Note: Accents may not flip.'));
    assert.ok(p.includes('```python'));
    assert.ok(!p.includes('swapcase'), 'no implementation detail from the original code');
  });

  test('optional parts are omitted cleanly', () => {
    const p = buildResynthPrompt({ ...input, context: '   ', explanation: { summary: 'x.', steps: ['a.', 'b.'] } });
    assert.ok(!p.includes('Context that already exists'));
    assert.ok(!p.includes('Watch out:'));
    assert.ok(!p.includes('Note:'));
  });

  test('CLI flags match CONTRACTS "Channels"', () => {
    assert.deepStrictEqual(CLAUDE_JSON_ARGS, ['-p', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--output-format', 'json']);
    assert.ok(!CLAUDE_JSON_ARGS.includes('--bare'), '--bare disables the OAuth sign-in');
    assert.deepStrictEqual(codexExecArgs('/home/tmp', '/t/out.txt'), ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', '/home/tmp', '-o', '/t/out.txt', '-']);
  });

  test('parseClaudeJsonReply', () => {
    assert.deepStrictEqual(parseClaudeJsonReply('{"type":"result","subtype":"success","is_error":false,"result":"hi"}'), { text: 'hi' });
    assert.deepStrictEqual(parseClaudeJsonReply('noise\n{"type":"system"}\n{"type":"result","result":"there"}\n'), { text: 'there' });
    assert.deepStrictEqual(parseClaudeJsonReply('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Not logged in"}'), { error: 'Not logged in' });
    assert.deepStrictEqual(parseClaudeJsonReply('{"type":"result","subtype":"error_during_execution","is_error":true}'), { error: 'error_during_execution' });
    assert.deepStrictEqual(parseClaudeJsonReply(''), { error: 'no output' });
    assert.ok(/unexpected output/.test(parseClaudeJsonReply('garbage').error!));
    assert.deepStrictEqual(parseClaudeJsonReply('{"type":"result"}'), { text: undefined });
  });
});
