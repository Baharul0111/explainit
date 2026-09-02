import * as assert from 'node:assert';
import { codexHookHash, codexHookKey, lookupTrust, parseHookStates, splitTomlKey } from '../../../src/adapters/pure/codexTrust';

const KEY = '/Users/me/.codex/hooks.json:pre_tool_use:1:0';

suite('adapters/pure/codexTrust', () => {
  test('splitTomlKey honours quoted segments', () => {
    assert.deepStrictEqual(splitTomlKey('hooks.state."/a/b.json:pre_tool_use:0:0"'), ['hooks', 'state', '/a/b.json:pre_tool_use:0:0']);
    assert.deepStrictEqual(splitTomlKey("a.'b.c'.d"), ['a', 'b.c', 'd']);
    assert.deepStrictEqual(splitTomlKey('"esc\\"aped"'), ['esc"aped']);
  });

  test('codexHookKey matches the lib.rs format', () => {
    assert.strictEqual(codexHookKey('/Users/me/.codex/hooks.json', 'PreToolUse', 1, 0), KEY);
    assert.strictEqual(codexHookKey('C:\\Users\\me\\.codex\\hooks.json', 'PostToolUse', 0, 2), 'C:\\Users\\me\\.codex\\hooks.json:post_tool_use:0:2');
  });

  test('parseHookStates reads sub-table form', () => {
    const toml = `
model = "gpt-5"

[hooks.state."${KEY}"]
enabled = true
trusted_hash = "sha256:abc" # trailing comment

[projects."/x"]
trust_level = "trusted"
`;
    assert.deepStrictEqual(parseHookStates(toml), { [KEY]: { enabled: true, trusted_hash: 'sha256:abc' } });
  });

  test('parseHookStates reads inline-table and dotted forms', () => {
    const inline = `[hooks.state]\n"${KEY}" = { trusted_hash = "sha256:def", enabled = false }\n`;
    assert.deepStrictEqual(parseHookStates(inline), { [KEY]: { enabled: false, trusted_hash: 'sha256:def' } });
    const dotted = `[hooks]\nstate."${KEY}".trusted_hash = "sha256:ghi"\nstate."${KEY}".enabled = true\n`;
    assert.deepStrictEqual(parseHookStates(dotted), { [KEY]: { enabled: true, trusted_hash: 'sha256:ghi' } });
  });

  test('parseHookStates ignores malformed lines and unrelated tables', () => {
    const toml = `[hooks.state."${KEY}"]\nenabled = "not a bool"\ntrusted_hash = 12\nweird line\n[other]\ntrusted_hash = "sha256:no"\n`;
    assert.deepStrictEqual(parseHookStates(toml), { [KEY]: {} });
    assert.deepStrictEqual(parseHookStates(''), {});
  });

  test('codexHookHash is deterministic, prefixed and sensitive to the identity', () => {
    const h1 = codexHookHash('PreToolUse', 'apply_patch|Edit|Write|Bash', { command: '"/w.sh" --agent codex', timeout: 7200 });
    const h2 = codexHookHash('PreToolUse', 'apply_patch|Edit|Write|Bash', { command: '"/w.sh" --agent codex', timeout: 7200 });
    assert.strictEqual(h1, h2);
    assert.match(h1, /^sha256:[0-9a-f]{64}$/);
    assert.notStrictEqual(h1, codexHookHash('PreToolUse', 'apply_patch|Edit|Write|Bash', { command: '"/w.sh" --agent codex', timeout: 600 }));
    assert.notStrictEqual(h1, codexHookHash('PostToolUse', 'apply_patch|Edit|Write|Bash', { command: '"/w.sh" --agent codex', timeout: 7200 }));
    // A missing timeout hashes like Codex's normalised default of 600.
    assert.strictEqual(codexHookHash('PreToolUse', 'x', { command: 'c' }), codexHookHash('PreToolUse', 'x', { command: 'c', timeout: 600 }));
  });

  test('lookupTrust reports trusted / modified / untrusted / disabled', () => {
    const good = codexHookHash('PreToolUse', 'm', { command: 'c', timeout: 7200 });
    assert.strictEqual(lookupTrust({ [KEY]: { trusted_hash: good } }, 'PreToolUse', 1, 0, good).status, 'trusted');
    assert.strictEqual(lookupTrust({ [KEY]: { trusted_hash: 'sha256:other' } }, 'PreToolUse', 1, 0, good).status, 'modified');
    assert.strictEqual(lookupTrust({ [KEY]: { enabled: false, trusted_hash: good } }, 'PreToolUse', 1, 0, good).status, 'disabled');
    assert.strictEqual(lookupTrust({}, 'PreToolUse', 1, 0, good).status, 'untrusted');
    assert.strictEqual(lookupTrust({ [KEY]: {} }, 'PreToolUse', 1, 0, good).status, 'unknown');
    // wrong indexes or a non-hooks.json source never count
    assert.strictEqual(lookupTrust({ [KEY]: { trusted_hash: good } }, 'PreToolUse', 0, 0, good).status, 'untrusted');
    assert.strictEqual(lookupTrust({ '/Users/me/.codex/config.toml:pre_tool_use:1:0': { trusted_hash: good } }, 'PreToolUse', 1, 0, good).status, 'untrusted');
    // windows-style key source is accepted
    assert.strictEqual(lookupTrust({ ['C:\\Users\\me\\.codex\\hooks.json:pre_tool_use:1:0']: { trusted_hash: good } }, 'PreToolUse', 1, 0, good).status, 'trusted');
  });
});
