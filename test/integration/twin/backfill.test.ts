import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackfillStatus } from '../../../src/core/interfaces';
import { canonicalPath, HOME_LAYOUT } from '../../../src/core/paths';
import { isCodeFilePath } from '../../../src/twin/pure/languages';
import { closeAllEditors, deleteTwins, getApi, pyFile, setSetting, stubRouter, tempFolder, waitFor, workspaceRoot, type RouterStub } from './helpers';
import type { ExplainitApi } from '../../../src/extension';

suite('twin backfill (integration)', function () {
  this.timeout(180_000);
  let api: ExplainitApi;
  let router: RouterStub;
  const statuses: BackfillStatus[] = [];
  let sub: { dispose(): void } | undefined;
  const recordFile = () => HOME_LAYOUT.backfill(canonicalPath(workspaceRoot()));

  suiteSetup(async () => {
    api = await getApi();
    await setSetting('twin.autoOpen', false);
    await closeAllEditors();
    await deleteTwins(workspaceRoot());
    api.twin.backfill.cancel();
    await waitFor(() => !fs.existsSync(recordFile()), 5000, 'no leftover backfill record');
    sub = api.twin.backfill.onStatus((s) => statuses.push({ ...s }));
  });

  suiteTeardown(async () => {
    sub?.dispose();
    router?.restore();
    api.twin.backfill.cancel();
    await deleteTwins(workspaceRoot());
    fs.rmSync(recordFile(), { force: true });
  });

  function codeFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('twin-tmp-')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (isCodeFilePath(p) && !e.name.endsWith('_explain.txt')) out.push(p);
      }
    };
    walk(workspaceRoot());
    return out.sort();
  }

  test('estimate, confirm (auto-answered in test mode), progress, pause, persist, resume, done', async () => {
    router = stubRouter(api, { delayMs: 350 });
    const expected = codeFiles();
    assert.ok(expected.length >= 5, `fixture workspace has ${expected.length} code files`);

    const started = api.twin.backfill.start();
    await waitFor(() => statuses.some((s) => s.state === 'estimating'), 10_000, 'estimating state');
    await waitFor(() => {
      const s = api.twin.backfill.status();
      return s.state === 'running' && s.doneFiles >= 1;
    }, 90_000, 'first file done');
    const running = api.twin.backfill.status();
    assert.ok(running.estimate, 'estimate attached to status');
    assert.ok(running.estimate!.functions > 0 && running.estimate!.requests > 0);
    assert.strictEqual(running.estimate!.channel, 'claude');
    assert.ok(running.totalFiles >= running.doneFiles && running.totalFiles > 0);
    assert.ok(running.currentFile, 'current file reported while running');

    api.twin.backfill.pause();
    await waitFor(() => api.twin.backfill.status().state === 'paused', 60_000, 'paused');
    await started;
    const paused = api.twin.backfill.status();
    assert.ok(paused.doneFiles >= 1 && paused.doneFiles < paused.totalFiles, `paused at ${paused.doneFiles}/${paused.totalFiles}`);
    assert.ok(fs.existsSync(recordFile()), 'progress persisted while paused');
    const record = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
    assert.strictEqual(record.done.length, paused.doneFiles);
    const callsAtPause = router.explain.callCount;
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(router.explain.callCount, callsAtPause, 'no requests while paused');

    await api.twin.backfill.resume();
    await waitFor(() => api.twin.backfill.status().state === 'done', 120_000, 'done');
    const done = api.twin.backfill.status();
    assert.strictEqual(done.doneFiles, done.totalFiles);
    assert.ok(!fs.existsSync(recordFile()), 'record cleared when done');
    for (const req of router.requests) assert.ok(req.functions.length <= 20, `request with ${req.functions.length} functions`);
    for (const f of expected) {
      const twin = await api.twin.twinPathFor(f);
      assert.ok(fs.existsSync(twin), `missing twin for ${path.relative(workspaceRoot(), f)}`);
    }
    assert.ok(fs.existsSync(path.join(workspaceRoot(), 'web', 'index.ts_explain.txt')), 'collision naming applied during backfill');
    const seen = statuses.map((s) => s.state);
    assert.ok(seen.includes('running') && seen.includes('paused') && seen.includes('done'), seen.join(','));
  });

  test('a second run skips every file that already has a fresh twin', async () => {
    router.explain.resetHistory();
    await api.twin.backfill.start();
    await waitFor(() => ['done', 'idle'].includes(api.twin.backfill.status().state), 60_000, 'second run finished');
    assert.strictEqual(router.explain.callCount, 0, 'nothing sent when every twin is fresh');
  });

  test('cancel clears a paused run', async () => {
    router.restore();
    router = stubRouter(api, { delayMs: 400 });
    await deleteTwins(workspaceRoot());
    const started = api.twin.backfill.start();
    await waitFor(() => api.twin.backfill.status().state === 'running', 60_000, 'running');
    api.twin.backfill.cancel();
    await started;
    await waitFor(() => api.twin.backfill.status().state === 'cancelled', 30_000, 'cancelled');
    await waitFor(() => !fs.existsSync(recordFile()), 5000, 'record removed');
    await api.twin.backfill.resume();
    assert.strictEqual(api.twin.backfill.status().state, 'idle', 'nothing to resume after cancel');
  });

  test('a 500-file workspace is scanned and backfilled within budget (REQ-021)', async function () {
    this.timeout(600_000);
    router.restore();
    router = stubRouter(api);
    await deleteTwins(workspaceRoot());
    const t = tempFolder('load');
    const FILES = 500;
    const fileAt = (i: number): string => path.join(t.dir, `mod_${String(i).padStart(3, '0')}.py`);
    try {
      for (let i = 0; i < FILES; i++) fs.writeFileSync(fileAt(i), pyFile([`f${i}_a`, `f${i}_b`, `f${i}_c`]));
      statuses.length = 0;
      const startedAt = Date.now();
      const started = api.twin.backfill.start();
      await waitFor(() => statuses.some((s) => s.state === 'estimating'), 10_000, 'estimating state');
      // The estimate ends when the run starts (the confirmation is auto-answered in test mode) or the scan gives up.
      await waitFor(() => ['running', 'done', 'error', 'cancelled'].includes(api.twin.backfill.status().state), 60_000, 'estimate finished');
      const estimateMs = Date.now() - startedAt;
      const afterEstimate = api.twin.backfill.status();
      assert.ok(['running', 'done'].includes(afterEstimate.state), `state after the estimate: ${afterEstimate.state} ${afterEstimate.error ?? ''}`);
      assert.ok(estimateMs < 20_000, `scan + estimate of ${FILES} files took ${estimateMs}ms`);
      assert.ok(afterEstimate.totalFiles >= FILES, `${afterEstimate.totalFiles} files planned`);
      assert.ok(afterEstimate.estimate && afterEstimate.estimate.functions >= FILES * 3, `estimated ${afterEstimate.estimate?.functions} functions`);

      await started;
      await waitFor(() => api.twin.backfill.status().state === 'done', 300_000, `backfill of ${FILES} files done`);
      const totalMs = Date.now() - startedAt;
      const done = api.twin.backfill.status();
      assert.strictEqual(done.doneFiles, done.totalFiles);
      assert.ok(router.requests.length >= FILES, `${router.requests.length} requests`);
      for (const req of router.requests) assert.ok(req.functions.length >= 1 && req.functions.length <= 20, `request with ${req.functions.length} functions`);
      for (let i = 0; i < FILES; i++) assert.ok(fs.existsSync(path.join(t.dir, `mod_${String(i).padStart(3, '0')}_explain.txt`)), `missing twin for file ${i}`);
      assert.ok(!fs.existsSync(recordFile()), 'record cleared when done');
      console.log(`[load] ${FILES} files: estimate ${estimateMs}ms, whole run ${totalMs}ms, ${router.requests.length} requests`);
    } finally {
      t.rm();
      await deleteTwins(workspaceRoot());
    }
  });
});
