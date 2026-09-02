import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pidAlive, purgeDeadSessions, readSessions, removeSessionFile, sessionFilePath, writeSessionFile } from '../../../src/gate/pure/sessionFile';

suite('gate/pure/sessionFile', () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-sessions-'));
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const info = (pid: number) => ({ pid, port: 4321, token: 'ab'.repeat(32), folders: ['/ws'], startedAt: new Date().toISOString(), version: '0.0.0' });

  test('writes <pid>.json with mode 0600 and reads it back', () => {
    const file = writeSessionFile(dir, info(process.pid));
    assert.equal(file, sessionFilePath(dir, process.pid));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readSessions(dir).map((s) => s.pid), [process.pid]);
  });

  test('removeSessionFile deletes it and tolerates a missing file', () => {
    writeSessionFile(dir, info(process.pid));
    removeSessionFile(dir, process.pid);
    removeSessionFile(dir, process.pid);
    assert.equal(fs.existsSync(sessionFilePath(dir, process.pid)), false);
  });

  test('purgeDeadSessions removes dead pids, corrupt files, keeps live ones', () => {
    writeSessionFile(dir, info(process.pid));
    writeSessionFile(dir, info(999999));
    fs.writeFileSync(path.join(dir, '12345.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const removed = purgeDeadSessions(dir, (pid) => pid === process.pid);
    assert.deepEqual(removed.sort(), ['12345.json', '999999.json']);
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${process.pid}.json`, 'notes.txt']);
  });

  test('purgeDeadSessions creates the directory when missing', () => {
    const sub = path.join(dir, 'nested', 'sessions');
    assert.deepEqual(purgeDeadSessions(sub), []);
    assert.equal(fs.existsSync(sub), true);
  });

  test('pidAlive is true for this process and false for nonsense', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(-1), false);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(2147483646), false);
  });
});
