import * as assert from 'node:assert';
import * as path from 'node:path';
import { claudeBundledBinary, codexBundledBinary, codexPlatformFolder, pickExtensionDir, versionFromDirName, versionFromOutput } from '../../../src/adapters/pure/extensionDirs';

suite('adapters/pure/extensionDirs', () => {
  test('versionFromDirName parses publisher.name-version[-platform]', () => {
    assert.strictEqual(versionFromDirName('anthropic.claude-code-2.1.252-darwin-arm64', 'anthropic.claude-code'), '2.1.252');
    assert.strictEqual(versionFromDirName('openai.chatgpt-26.825.51511-darwin-arm64', 'openai.chatgpt'), '26.825.51511');
    assert.strictEqual(versionFromDirName('Anthropic.Claude-Code-2.1.0', 'anthropic.claude-code'), '2.1.0');
    assert.strictEqual(versionFromDirName('anthropic.claude-codex-1.0.0', 'anthropic.claude-code'), undefined);
    assert.strictEqual(versionFromDirName('other-1.0.0', 'anthropic.claude-code'), undefined);
  });

  test('pickExtensionDir picks the newest version', () => {
    const root = '/ext';
    const hit = pickExtensionDir(root, ['anthropic.claude-code-2.1.9-darwin-arm64', 'anthropic.claude-code-2.1.252-darwin-arm64', 'foo.bar-1.0.0'], 'anthropic.claude-code');
    assert.deepStrictEqual(hit, { path: path.join(root, 'anthropic.claude-code-2.1.252-darwin-arm64'), version: '2.1.252' });
    assert.strictEqual(pickExtensionDir(root, ['foo.bar-1.0.0'], 'anthropic.claude-code'), undefined);
  });

  test('bundled binary locations', () => {
    assert.strictEqual(claudeBundledBinary('/e', 'darwin'), path.join('/e', 'resources', 'native-binary', 'claude'));
    assert.strictEqual(claudeBundledBinary('/e', 'win32'), path.join('/e', 'resources', 'native-binary', 'claude.exe'));
    assert.strictEqual(codexPlatformFolder('darwin', 'arm64'), 'macos-aarch64');
    assert.strictEqual(codexPlatformFolder('win32', 'x64'), 'windows-x86_64');
    assert.strictEqual(codexPlatformFolder('linux', 'x64'), 'linux-x86_64');
    assert.strictEqual(codexBundledBinary('/e', ['macos-aarch64', 'linux-x86_64'], 'darwin', 'arm64'), path.join('/e', 'bin', 'macos-aarch64', 'codex'));
    assert.strictEqual(codexBundledBinary('/e', ['macos-x86_64'], 'darwin', 'arm64'), path.join('/e', 'bin', 'macos-x86_64', 'codex'), 'same-OS fallback');
    assert.strictEqual(codexBundledBinary('/e', ['windows-x86_64'], 'win32', 'x64'), path.join('/e', 'bin', 'windows-x86_64', 'codex.exe'));
    assert.strictEqual(codexBundledBinary('/e', ['linux-x86_64'], 'darwin', 'arm64'), undefined);
  });

  test('versionFromOutput extracts semver from CLI banners', () => {
    assert.strictEqual(versionFromOutput('2.1.252 (Claude Code)\n'), '2.1.252');
    assert.strictEqual(versionFromOutput('codex-cli 0.152.0'), '0.152.0');
    assert.strictEqual(versionFromOutput('no version here'), undefined);
  });
});
