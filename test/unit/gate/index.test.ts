import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createGateServer, HEARTBEAT_MS } from '../../../src/gate';
import { HOME_LAYOUT } from '../../../src/core/paths';
import { claudeEnvelope, makeHarness, type Harness } from './fakes';

suite('gate/index: createGateServer', () => {
  let h: Harness;
  setup(() => {
    h = makeHarness();
  });
  teardown(() => h.cleanup());

  test('starts, exposes info, answers handle() without HTTP, and stop() removes the session file', async () => {
    const gate = createGateServer(h.deps);
    const info = await gate.start();
    assert.equal(gate.info, info);
    assert.equal(info.pid, process.pid);
    assert.match(info.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(info.folders, [h.workspace]);
    const file = path.join(HOME_LAYOUT.sessions(), `${process.pid}.json`);
    assert.ok(file.startsWith(h.home), 'the session file lives under the temp EXPLAINIT_HOME');
    assert.ok(fs.existsSync(file));
    const d = await gate.handle(claudeEnvelope('Read', { file_path: 'x' }, h.workspace));
    assert.deepEqual(d, { permissionDecision: 'none' });
    await gate.stop();
    assert.equal(fs.existsSync(file), false);
    assert.equal(gate.info, undefined);
  });

  test('setPaused is reflected in handle() and emits a heartbeat with the pending count', async () => {
    const gate = createGateServer(h.deps);
    await gate.start();
    const beats: { ts: string; pending: number }[] = [];
    const sub = gate.onHeartbeat((e) => beats.push(e));
    gate.setPaused(true);
    assert.equal(gate.paused, true);
    assert.equal(beats.length, 1);
    assert.equal(beats[0].pending, 0);
    assert.match(beats[0].ts, /^\d{4}-/);
    sub.dispose();
    gate.setPaused(false);
    assert.equal(beats.length, 1, 'disposed listener no longer fires');
    await gate.stop();
  });

  test('a changed workspace folder list is written back to the session file on the next heartbeat', async () => {
    const extra = path.join(h.root, 'ws2');
    fs.mkdirSync(extra, { recursive: true });
    let folders = [h.workspace];
    const gate = createGateServer({ ...h.deps, workspaceFolders: () => folders });
    await gate.start();
    folders = [h.workspace, extra];
    gate.setPaused(false); // triggers a beat without waiting HEARTBEAT_MS
    const file = path.join(HOME_LAYOUT.sessions(), `${process.pid}.json`);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).folders, [h.workspace, extra]);
    assert.deepEqual(gate.info!.folders, [h.workspace, extra]);
    await gate.stop();
  });

  test('every timer and the server are pushed to disposables (REQ-001)', async () => {
    const gate = createGateServer(h.deps);
    await gate.start();
    assert.ok(h.deps.disposables.length >= 3, `controller, server and heartbeat interval: ${h.deps.disposables.length}`);
    assert.ok(HEARTBEAT_MS === 5_000);
    for (const d of h.deps.disposables) d.dispose();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(gate.info, undefined, 'disposing stops the server');
  });
});
