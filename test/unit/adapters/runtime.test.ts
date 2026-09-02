import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256 } from '../../../src/core/hash';
import { candidateNames, findOnPath, splitCliValue, wellKnownNodeLocations } from '../../../src/adapters/pure/pathLookup';
import { cmdQuote, shQuote, wrapperCmdContent, wrapperNameFor, wrapperShContent } from '../../../src/adapters/pure/wrappers';
import { resolveNodeRuntime, writeWrappers } from '../../../src/adapters/runtime';

suite('adapters/pure/pathLookup', () => {
  test('findOnPath walks PATH in order on posix', () => {
    const files = new Set(['/usr/local/bin/node', '/opt/homebrew/bin/node']);
    const hit = findOnPath('node', { pathEnv: '/opt/homebrew/bin:/usr/local/bin', platform: 'darwin', isFile: (p) => files.has(p) });
    assert.strictEqual(hit, '/opt/homebrew/bin/node');
    assert.strictEqual(findOnPath('node', { pathEnv: '/nowhere', platform: 'linux', isFile: () => false }), undefined);
    assert.strictEqual(findOnPath('node', { pathEnv: undefined, platform: 'linux', isFile: () => true }), undefined);
  });

  test('findOnPath applies PATHEXT on windows', () => {
    const files = new Set(['C:\\nodejs\\node.exe'.toLowerCase()]);
    const isFile = (p: string): boolean => files.has(p.toLowerCase());
    const hit = findOnPath('node', { pathEnv: 'C:\\Windows;C:\\nodejs', pathExt: '.COM;.EXE;.BAT;.CMD', platform: 'win32', isFile });
    assert.ok(hit && hit.toLowerCase().endsWith('node.exe'), String(hit));
    assert.deepStrictEqual(candidateNames('node', 'win32', '.EXE;.CMD'), ['node.exe', 'node.cmd', 'node']);
    assert.deepStrictEqual(candidateNames('node.exe', 'win32', '.EXE;.CMD'), ['node.exe']);
    assert.deepStrictEqual(candidateNames('node', 'linux'), ['node']);
  });

  test('explicit paths bypass PATH', () => {
    assert.strictEqual(findOnPath('/x/node', { pathEnv: '', platform: 'linux', isFile: (p) => p === '/x/node' }), '/x/node');
    assert.strictEqual(findOnPath('/x/node', { pathEnv: '', platform: 'linux', isFile: () => false }), undefined);
  });

  test('wellKnownNodeLocations per platform', () => {
    assert.ok(wellKnownNodeLocations('darwin', '/Users/me', {}).includes('/opt/homebrew/bin/node'));
    const win = wellKnownNodeLocations('win32', 'C:\\Users\\me', { ProgramFiles: 'C:\\Program Files' });
    assert.ok(win.some((p) => p.includes('nodejs')));
  });

  test('splitCliValue splits "node script.js" only for .js values', () => {
    assert.deepStrictEqual(splitCliValue('node /a/b/fake.js'), { cmd: 'node', args: ['/a/b/fake.js'] });
    assert.deepStrictEqual(splitCliValue('/usr/local/bin/claude'), { cmd: '/usr/local/bin/claude', args: [] });
    assert.deepStrictEqual(splitCliValue('C:\\Program Files\\claude.exe'), { cmd: 'C:\\Program Files\\claude.exe', args: [] });
  });
});

suite('adapters/pure/wrappers', () => {
  const input = { runtime: '/opt/homebrew/bin/node', script: '/Users/me/.explainit/hooks/explainit-hook.js', electron: false, explainitHome: '/Users/me/.explainit' };

  test('sh wrapper execs the runtime with quoting and passes args', () => {
    const sh = wrapperShContent(input);
    assert.ok(sh.startsWith('#!/bin/sh\n'));
    assert.ok(sh.endsWith('exec "/opt/homebrew/bin/node" "/Users/me/.explainit/hooks/explainit-hook.js" "$@"\n'));
    assert.ok(!sh.includes('ELECTRON_RUN_AS_NODE'));
    assert.ok(!sh.includes('\r'));
  });

  test('sh wrapper pins EXPLAINIT_HOME before exec so a shell profile cannot redirect the hook', () => {
    const sh = wrapperShContent(input);
    assert.ok(sh.includes('EXPLAINIT_HOME="/Users/me/.explainit"\nexport EXPLAINIT_HOME\nexec '), sh);
    const odd = wrapperShContent({ ...input, explainitHome: '/h/$weird "dir"' });
    assert.ok(odd.includes('EXPLAINIT_HOME="/h/\\$weird \\"dir\\""\n'), odd);
  });

  test('sh wrapper sets ELECTRON_RUN_AS_NODE only for electron runtimes and escapes specials', () => {
    const sh = wrapperShContent({ runtime: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', script: '/h/$weird "dir"/explainit-hook.js', electron: true, explainitHome: '/h/$weird "dir"' });
    assert.ok(sh.includes('ELECTRON_RUN_AS_NODE=1\nexport ELECTRON_RUN_AS_NODE\n'));
    assert.ok(sh.includes('"/Applications/Visual Studio Code.app/Contents/MacOS/Electron"'));
    assert.ok(sh.includes('"/h/\\$weird \\"dir\\"/explainit-hook.js"'));
  });

  test('cmd wrapper uses CRLF, @echo off, %*, pins EXPLAINIT_HOME and the electron flag only when needed', () => {
    const cmd = wrapperCmdContent({ runtime: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\me\\.explainit\\hooks\\explainit-hook.js', electron: false, explainitHome: 'C:\\Users\\me\\.explainit' });
    assert.ok(cmd.startsWith('@echo off\r\n'));
    assert.ok(cmd.includes('set "EXPLAINIT_HOME=C:\\Users\\me\\.explainit"\r\n'), cmd);
    assert.ok(cmd.endsWith('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\.explainit\\hooks\\explainit-hook.js" %*\r\n'));
    assert.ok(!cmd.includes('ELECTRON_RUN_AS_NODE'));
    const el = wrapperCmdContent({ runtime: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', script: 'C:\\x\\explainit-hook.js', electron: true, explainitHome: 'C:\\x' });
    assert.ok(el.includes('set ELECTRON_RUN_AS_NODE=1\r\n'));
  });

  test('quoting helpers', () => {
    assert.strictEqual(shQuote('a b'), '"a b"');
    assert.strictEqual(shQuote('a`b'), '"a\\`b"');
    assert.strictEqual(cmdQuote('C:\\a b'), '"C:\\a b"');
    assert.strictEqual(wrapperNameFor('win32'), 'explainit-hook.cmd');
    assert.strictEqual(wrapperNameFor('darwin'), 'explainit-hook.sh');
  });
});

suite('adapters/runtime', () => {
  test('resolveNodeRuntime prefers node on PATH', () => {
    const r = resolveNodeRuntime({ env: { PATH: '/fake/bin' }, platform: 'linux', execPath: '/usr/share/code/code', homeDir: '/home/me', isFile: (p) => p === '/fake/bin/node' });
    assert.deepStrictEqual(r, { path: '/fake/bin/node', electron: false, source: 'path' });
  });

  test('resolveNodeRuntime falls back to well-known locations, then electron', () => {
    const wk = resolveNodeRuntime({ env: { PATH: '/usr/bin' }, platform: 'darwin', execPath: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', homeDir: '/Users/me', isFile: (p) => p === '/opt/homebrew/bin/node' });
    assert.deepStrictEqual(wk, { path: '/opt/homebrew/bin/node', electron: false, source: 'well-known' });
    const el = resolveNodeRuntime({ env: { PATH: '/usr/bin' }, platform: 'darwin', execPath: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', homeDir: '/Users/me', isFile: () => false });
    assert.deepStrictEqual(el, { path: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', electron: true, source: 'electron' });
    const plainNode = resolveNodeRuntime({ env: { PATH: '' }, platform: 'linux', execPath: '/tmp/node', homeDir: '/home/me', isFile: () => false });
    assert.strictEqual(plainNode.electron, false);
  });

  test('writeWrappers writes both files with matching hashes and an executable .sh', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-wrappers-'));
    try {
      const w = writeWrappers(dir, { path: process.execPath, electron: false, source: 'path' }, path.join(dir, 'explainit-hook.js'));
      assert.strictEqual(w.sh.path, path.join(dir, 'explainit-hook.sh'));
      // The home defaults to the parent of the hooks folder and is pinned into both wrappers.
      assert.ok(fs.readFileSync(w.sh.path, 'utf8').includes(`EXPLAINIT_HOME="${path.dirname(dir)}"`));
      assert.ok(fs.readFileSync(w.cmd.path, 'utf8').includes(`set "EXPLAINIT_HOME=${path.dirname(dir)}"`));
      const pinned = writeWrappers(dir, { path: process.execPath, electron: false, source: 'path' }, path.join(dir, 'explainit-hook.js'), path.join(dir, 'other-home'));
      assert.ok(fs.readFileSync(pinned.sh.path, 'utf8').includes(`EXPLAINIT_HOME="${path.join(dir, 'other-home')}"`));
      assert.strictEqual(w.cmd.path, path.join(dir, 'explainit-hook.cmd'));
      assert.strictEqual(sha256(fs.readFileSync(w.sh.path)), w.sh.hash);
      assert.strictEqual(sha256(fs.readFileSync(w.cmd.path)), w.cmd.hash);
      if (process.platform !== 'win32') assert.ok(fs.statSync(w.sh.path).mode & 0o100, 'sh wrapper is executable');
      assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp files left behind');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
