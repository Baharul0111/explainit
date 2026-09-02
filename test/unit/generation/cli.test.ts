import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codexAuthFile, codexHomeDir, codexSignIn, findExtensionBinary, findOnPath, parseSettingValue, platformDirMatches, probeVersion, resolveCli, runCli, withWindowsShim, type CliSpec } from '../../../src/generation/channels/cli';
import { ChannelError } from '../../../src/generation/channels/types';
import { CancelSource } from '../../../src/core/cancel';
import { FAKE_CLAUDE, FAKE_CODEX, rmDir, tmpDir } from './helpers';

const isWin = process.platform === 'win32';

function touchExec(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\necho fake\n');
  if (!isWin) fs.chmodSync(p, 0o755);
}

/** A fake extension layout: claude-code (native binary) + chatgpt (per-platform codex dirs). */
function layoutExtensions(root: string, exe = ''): { claude: string; codexMac: string; codexLinux: string; codexWin: string } {
  const claude = path.join(root, 'anthropic.claude-code-2.1.252-darwin-arm64', 'resources', 'native-binary', 'claude' + exe);
  touchExec(claude);
  // an older version too: the newest must win
  touchExec(path.join(root, 'anthropic.claude-code-2.0.9-darwin-arm64', 'resources', 'native-binary', 'claude' + exe));
  const cx = path.join(root, 'openai.chatgpt-26.825.51511-darwin-arm64', 'bin');
  const codexMac = path.join(cx, 'macos-aarch64', 'codex' + exe);
  const codexLinux = path.join(cx, 'linux-x86_64', 'codex' + exe);
  const codexWin = path.join(cx, 'windows-x86_64', 'codex.exe');
  touchExec(codexMac);
  touchExec(codexLinux);
  touchExec(codexWin);
  touchExec(path.join(cx, 'macos-aarch64', 'rg' + exe));
  return { claude, codexMac, codexLinux, codexWin };
}

const noPath = { PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

suite('generation/channels/cli', () => {
  let dir: string;
  setup(() => {
    dir = tmpDir();
  });
  teardown(() => rmDir(dir));

  suite('resolveCli', () => {
    test('setting "node /abs/path.js" runs the script through node', () => {
      const spec = resolveCli('claude', `node ${FAKE_CLAUDE}`, { noVscode: true, extensionRoots: [] });
      assert.equal(spec.source, 'setting');
      assert.deepEqual(spec.argsPrefix, [FAKE_CLAUDE]);
      assert.ok(spec.path.length > 0);
      assert.match(spec.detail, /from the setting/);
    });

    test('parseSettingValue splits on the first space only for .js values', () => {
      assert.deepEqual(parseSettingValue('node /a b/c.js'), { runtime: 'node', target: '/a b/c.js' });
      assert.deepEqual(parseSettingValue('/opt/my tools/claude'), { target: '/opt/my tools/claude' });
      assert.deepEqual(parseSettingValue('"/x/y.js"'), { target: '/x/y.js' });
      assert.deepEqual(parseSettingValue('node "/a b/c.js"'), { runtime: 'node', target: '/a b/c.js' });
      assert.deepEqual(parseSettingValue("node '/a b/c.js'"), { runtime: 'node', target: '/a b/c.js' });
      assert.deepEqual(parseSettingValue('"C:\\Program Files\\Claude\\claude.exe"'), { target: 'C:\\Program Files\\Claude\\claude.exe' });
      assert.deepEqual(parseSettingValue('"/x/my script.js"'), { target: '/x/my script.js' }, 'a quoted path without a runtime is not split');
    });

    test('a quoted "node <path with spaces>.js" setting resolves to the script', () => {
      const script = path.join(dir, 'my tools', 'fake claude.js');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, 'process.stdout.write("1.0.0")');
      const spec = resolveCli('claude', `node "${script}"`, { noVscode: true, extensionRoots: [] });
      assert.equal(spec.source, 'setting');
      assert.deepEqual(spec.argsPrefix, [script]);
    });

    test('an absolute setting path is used when it exists, otherwise the search continues with a note', () => {
      const bin = path.join(dir, 'bin', 'my-claude');
      touchExec(bin);
      const found = resolveCli('claude', bin, { noVscode: true, extensionRoots: [], env: noPath });
      assert.equal(found.source, 'setting');
      assert.equal(found.path, bin);
      const missing = resolveCli('claude', path.join(dir, 'nope'), { noVscode: true, extensionRoots: [], env: noPath, platform: 'linux' });
      assert.equal(missing.source, 'none');
      assert.match(missing.detail, /assistant\.claudeCliPath/);
      assert.match(missing.detail, /not found/);
    });

    test('PATH lookup finds the executable (which/where)', () => {
      const bin = path.join(dir, 'bin');
      touchExec(path.join(bin, 'claude'));
      const spec = resolveCli('claude', 'claude', { noVscode: true, extensionRoots: [], env: { PATH: `${path.join(dir, 'empty')}${path.delimiter}${bin}` }, platform: isWin ? 'win32' : process.platform });
      assert.equal(spec.source, 'path');
      assert.equal(spec.path, path.join(bin, 'claude'));
    });

    test('Windows PATH lookup honours PATHEXT', () => {
      const bin = path.join(dir, 'bin');
      touchExec(path.join(bin, 'codex.CMD'));
      const found = findOnPath('codex', { platform: 'win32', env: { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' } });
      // macOS/Windows file systems are case-insensitive, so either spelling may come back.
      assert.equal(found?.toLowerCase(), path.join(bin, 'codex.cmd').toLowerCase());
      assert.equal(findOnPath('codex', { platform: 'win32', env: { PATH: bin, PATHEXT: '.EXE' } }), undefined);
    });

    test('falls back to the bundled extension binary: claude native-binary (newest version wins)', () => {
      const root = path.join(dir, 'ext');
      const files = layoutExtensions(root);
      const spec = resolveCli('claude', 'claude', { noVscode: true, extensionRoots: [root], env: noPath, platform: 'darwin', arch: 'arm64' });
      assert.equal(spec.source, 'extension');
      assert.equal(spec.path, files.claude);
      assert.match(spec.detail, /anthropic\.claude-code-2\.1\.252/);
    });

    test('codex binary is picked from the bin/<platform-arch> folder matching the OS and CPU', () => {
      const root = path.join(dir, 'ext');
      const files = layoutExtensions(root);
      const mac = resolveCli('codex', 'codex', { noVscode: true, extensionRoots: [root], env: noPath, platform: 'darwin', arch: 'arm64' });
      assert.equal(mac.source, 'extension');
      assert.equal(mac.path, files.codexMac);
      const linux = findExtensionBinary('codex', { noVscode: true, extensionRoots: [root], platform: 'linux', arch: 'x64' });
      assert.equal(linux?.path, files.codexLinux);
      const win = findExtensionBinary('codex', { noVscode: true, extensionRoots: [root], platform: 'win32', arch: 'x64' });
      assert.equal(win?.path, files.codexWin);
      // no matching platform folder -> none
      assert.equal(findExtensionBinary('codex', { noVscode: true, extensionRoots: [root], platform: 'linux', arch: 'arm64' }), undefined);
    });

    test('vscode.extensions.all entries are honoured when supplied', () => {
      const root = path.join(dir, 'ext');
      const files = layoutExtensions(root);
      const spec = resolveCli('claude', 'claude', {
        noVscode: true,
        extensionRoots: [],
        env: noPath,
        platform: 'darwin',
        vscodeExtensions: [{ id: 'anthropic.claude-code', extensionPath: path.join(root, 'anthropic.claude-code-2.1.252-darwin-arm64') }],
      });
      assert.equal(spec.source, 'extension');
      assert.equal(spec.path, files.claude);
    });

    test('codex home: CODEX_HOME wins (trimmed, resolved), else <home>/.codex; auth.json lives there', () => {
      const custom = path.join(dir, 'codex-elsewhere');
      assert.equal(codexHomeDir({ env: { CODEX_HOME: `  ${custom}  ` }, homeDir: dir }), path.resolve(custom));
      assert.equal(codexHomeDir({ env: { CODEX_HOME: '   ' }, homeDir: dir }), path.join(dir, '.codex'));
      assert.equal(codexHomeDir({ env: {}, homeDir: dir }), path.join(dir, '.codex'));
      assert.equal(codexAuthFile({ env: { CODEX_HOME: custom } }), path.join(custom, 'auth.json'));
      assert.equal(codexAuthFile({ env: {}, homeDir: dir }), path.join(dir, '.codex', 'auth.json'));
    });

    test('codexSignIn: auth.json under the codex home, or an API key in the environment, else not signed in', () => {
      const custom = path.join(dir, 'codex-home');
      const none = codexSignIn({ env: { CODEX_HOME: custom }, homeDir: dir });
      assert.equal(none.signedIn, false);
      assert.equal(none.authFile, path.join(custom, 'auth.json'));
      assert.match(none.detail, /no sign-in file/);
      fs.mkdirSync(custom, { recursive: true });
      fs.writeFileSync(path.join(custom, 'auth.json'), '{}');
      assert.equal(codexSignIn({ env: { CODEX_HOME: custom }, homeDir: dir }).signedIn, true);
      // A directory named auth.json is not a sign-in file.
      const bad = path.join(dir, 'codex-bad');
      fs.mkdirSync(path.join(bad, 'auth.json'), { recursive: true });
      assert.equal(codexSignIn({ env: { CODEX_HOME: bad }, homeDir: dir }).signedIn, false);
      const key = codexSignIn({ env: { CODEX_HOME: bad, CODEX_API_KEY: 'k' }, homeDir: dir });
      assert.equal(key.signedIn, true);
      assert.match(key.detail, /CODEX_API_KEY/);
      assert.equal(codexSignIn({ env: { CODEX_HOME: bad, OPENAI_API_KEY: '   ' }, homeDir: dir }).signedIn, false);
    });

    test('nothing found -> source none with a plain-English next step', () => {
      const spec = resolveCli('codex', 'codex', { noVscode: true, extensionRoots: [path.join(dir, 'missing')], env: noPath, platform: 'linux' });
      assert.equal(spec.source, 'none');
      assert.equal(spec.path, '');
      assert.match(spec.detail, /Install the CLI or the extension/);
    });

    test('platformDirMatches', () => {
      assert.ok(platformDirMatches('macos-aarch64', 'darwin', 'arm64'));
      assert.ok(platformDirMatches('linux-x86_64', 'linux', 'x64'));
      assert.ok(platformDirMatches('windows-x86_64', 'win32', 'x64'));
      assert.ok(platformDirMatches('linux-aarch64', 'linux', 'arm64'));
      assert.ok(!platformDirMatches('macos-x86_64', 'darwin', 'arm64'));
      assert.ok(!platformDirMatches('linux-x86_64', 'darwin', 'x64'));
    });

    test('Windows .cmd npm shims are unwrapped to node + script; unknown shims go through the shell', () => {
      const shim = path.join(dir, 'claude.cmd');
      const script = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, '');
      fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
      const base: CliSpec = { kind: 'claude', path: shim, argsPrefix: [], source: 'path', detail: 'x' };
      const unwrapped = withWindowsShim(base, 'win32', { env: { PATH: '' }, execPath: process.execPath });
      assert.equal(unwrapped.shell, undefined);
      assert.equal(unwrapped.argsPrefix[0], script);
      fs.writeFileSync(shim, '@ECHO off\r\nsomething-else %*\r\n');
      const shell = withWindowsShim(base, 'win32', { env: { PATH: '' } });
      assert.equal(shell.shell, true);
      // non-Windows: untouched
      assert.equal(withWindowsShim(base, 'linux', {}).shell, undefined);
    });
  });

  suite('runCli', () => {
    const nodeSpec = (script: string): CliSpec => ({ kind: 'claude', path: process.execPath, argsPrefix: [script], source: 'setting', detail: 'test' });

    test('captures stdout/stderr and the exit code; non-zero exit is returned, not thrown or retried', async () => {
      const script = path.join(dir, 'exit3.js');
      fs.writeFileSync(script, 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3);');
      const r = await runCli(nodeSpec(script), [], { timeoutMs: 10_000 });
      assert.equal(r.code, 3);
      assert.equal(r.stdout, 'out');
      assert.equal(r.stderr, 'err');
      assert.equal(r.attempts, 1);
    });

    test('stdin is delivered and onStdout streams chunks', async () => {
      const script = path.join(dir, 'echo.js');
      fs.writeFileSync(script, 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{process.stdout.write("got:"+d)});');
      const chunks: string[] = [];
      const r = await runCli(nodeSpec(script), [], { timeoutMs: 10_000, stdin: 'héllo wörld', onStdout: (c) => chunks.push(c) });
      assert.equal(r.stdout, 'got:héllo wörld');
      assert.equal(chunks.join(''), 'got:héllo wörld');
    });

    test('timeout kills the child and throws a retryable ChannelError (after one jittered retry)', async () => {
      const script = path.join(dir, 'sleep.js');
      const pidFile = path.join(dir, 'pids.txt');
      fs.writeFileSync(script, `require("fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n"); setInterval(()=>{}, 1000);`);
      const started = Date.now();
      await assert.rejects(
        runCli(nodeSpec(script), [], { timeoutMs: 300, retryDelayMs: 10 }),
        (e: unknown) => e instanceof ChannelError && e.reason === 'timeout' && e.retryable,
      );
      assert.ok(Date.now() - started < 5000);
      const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
      assert.equal(pids.length, 2, 'spawned twice: one retry');
      await new Promise((r) => setTimeout(r, 200));
      for (const pid of pids) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        assert.ok(!alive, `child ${pid} was killed`);
      }
    });

    test('retry: false means a single attempt', async () => {
      const script = path.join(dir, 'sleep2.js');
      const pidFile = path.join(dir, 'pids2.txt');
      fs.writeFileSync(script, `require("fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n"); setInterval(()=>{}, 1000);`);
      await assert.rejects(runCli(nodeSpec(script), [], { timeoutMs: 200, retry: false }));
      assert.equal(fs.readFileSync(pidFile, 'utf8').trim().split('\n').length, 1);
    });

    test('spawn error (missing executable) is retried once then reported as unavailable', async () => {
      const spec: CliSpec = { kind: 'codex', path: path.join(dir, 'does-not-exist'), argsPrefix: [], source: 'setting', detail: 'test' };
      await assert.rejects(runCli(spec, [], { timeoutMs: 1000, retryDelayMs: 5 }), (e: unknown) => e instanceof ChannelError && e.reason === 'unavailable' && /not found/.test(e.message));
    });

    test('source none is refused up front', async () => {
      const spec: CliSpec = { kind: 'codex', path: '', argsPrefix: [], source: 'none', detail: 'Codex was not found.' };
      await assert.rejects(runCli(spec, [], { timeoutMs: 1000 }), (e: unknown) => e instanceof ChannelError && e.reason === 'unavailable');
    });

    test('cancellation kills the child and is never retried', async () => {
      const script = path.join(dir, 'sleep3.js');
      const pidFile = path.join(dir, 'pids3.txt');
      fs.writeFileSync(script, `require("fs").appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n"); setInterval(()=>{}, 1000);`);
      const src = new CancelSource();
      const p = runCli(nodeSpec(script), [], { timeoutMs: 10_000, token: src.token });
      setTimeout(() => src.cancel(), 150);
      await assert.rejects(p, (e: unknown) => e instanceof ChannelError && e.reason === 'cancelled');
      assert.equal(fs.readFileSync(pidFile, 'utf8').trim().split('\n').length, 1);
    });

    test('shell mode quotes an executable path that contains spaces', async function () {
      if (isWin) this.skip(); // the POSIX shell shows the same quoting need as cmd.exe; the .cmd path is covered by withWindowsShim
      const script = path.join(dir, 'with space', 'run.sh');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, '#!/bin/sh\necho ok\n');
      fs.chmodSync(script, 0o755);
      const spec: CliSpec = { kind: 'claude', path: script, argsPrefix: [], source: 'path', detail: 'test', shell: true };
      const r = await runCli(spec, [], { timeoutMs: 10_000, retry: false });
      assert.equal(r.code, 0);
      assert.equal(r.stdout.trim(), 'ok');
    });

    test('probeVersion against the fake CLIs', async () => {
      const claude: CliSpec = { kind: 'claude', path: process.execPath, argsPrefix: [FAKE_CLAUDE], source: 'setting', detail: 'fake' };
      const codex: CliSpec = { kind: 'codex', path: process.execPath, argsPrefix: [FAKE_CODEX], source: 'setting', detail: 'fake' };
      const a = await probeVersion(claude);
      assert.ok(a.ok && a.version === '1.0.0', a.detail);
      const b = await probeVersion(codex);
      assert.ok(b.ok, b.detail);
    });
  });
});
