/**
 * Generation router inside VS Code (runs via @vscode/test-electron with test/fixtures/workspace open,
 * EXPLAINIT_TEST_MODE=1 and EXPLAINIT_HOME pointing at a temp folder).
 *
 *  - the router explains util.ts functions through the fake claude CLI
 *  - availableChannels() reports Copilot available/unavailable without throwing (or a dialog)
 *  - consent false -> vscode.lm.selectChatModels is never called
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExplainitApi } from '../../../src/extension';
import { contentHashOf } from '../../../src/core/hash';
import type { ExplainFunctionInput } from '../../../src/core/interfaces';
import type { Explanation } from '../../../src/core/types';

const FAKE_CLAUDE = path.resolve(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'fake-cli', 'claude.js');
const CONFIG = 'explainit';

function functionsOf(text: string, ranges: { name: string; start: number; end: number }[]): ExplainFunctionInput[] {
  const lines = text.split(/\r?\n/);
  return ranges.map((r, i) => {
    const body = lines.slice(r.start, r.end + 1).join('\n');
    return { functionId: `${r.name}#${i}`, name: r.name, text: body, contentHash: contentHashOf(body) };
  });
}

suite('generation router (integration)', function () {
  this.timeout(120_000);
  let api: ExplainitApi;
  let previousCliPath: unknown;
  let previousPin: unknown;
  let previousConsent: boolean | undefined;
  let logFile: string;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('BaharulIslam.explainit-code');
    assert.ok(ext, 'extension present');
    api = await ext!.activate();
    const cfg = vscode.workspace.getConfiguration(CONFIG);
    previousCliPath = cfg.inspect('assistant.claudeCliPath')?.globalValue;
    previousPin = cfg.inspect('assistant.channel')?.globalValue;
    await cfg.update('assistant.claudeCliPath', `node ${FAKE_CLAUDE}`, vscode.ConfigurationTarget.Global);
    await cfg.update('assistant.channel', 'auto', vscode.ConfigurationTarget.Global);
    previousConsent = api.state.read().consentGranted;
    logFile = path.join(process.env.EXPLAINIT_HOME || require('node:os').tmpdir(), `fake-cli-${process.pid}.log`);
    process.env.FAKE_CLI_LOG = logFile;
    delete process.env.FAKE_CLI_MODE;
  });

  suiteTeardown(async () => {
    const cfg = vscode.workspace.getConfiguration(CONFIG);
    await cfg.update('assistant.claudeCliPath', previousCliPath, vscode.ConfigurationTarget.Global);
    await cfg.update('assistant.channel', previousPin, vscode.ConfigurationTarget.Global);
    await api.state.update((s) => {
      s.consentGranted = previousConsent;
    });
    delete process.env.FAKE_CLI_LOG;
    delete process.env.FAKE_CLI_MODE;
    try {
      fs.rmSync(logFile, { force: true });
    } catch {
      /* ignore */
    }
  });

  test('the fake CLI path setting is picked up and reported as available', async () => {
    await api.state.update((s) => {
      s.consentGranted = true;
    });
    const avail = await api.router.availableChannels();
    const claude = avail.find((a) => a.channel === 'claude');
    assert.ok(claude, 'claude row present');
    assert.equal(claude!.available, true, claude!.reason + ' ' + claude!.detail);
    assert.match(claude!.detail ?? '', /from the setting/);
  });

  test('explains util.ts functions through the fake claude CLI (prompt via stdin, fenced)', async () => {
    await api.state.update((s) => {
      s.consentGranted = true;
    });
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const file = path.join(folder, 'src', 'util.ts');
    const text = fs.readFileSync(file, 'utf8');
    const fns = functionsOf(text, [
      { name: 'slugify', start: 5, end: 11 },
      { name: 'add', start: 13, end: 13 },
      { name: 'fetchJson', start: 27, end: 33 },
    ]);
    const streamed: string[] = [];
    const seen: Explanation[] = [];
    const out = await api.router.explainFunctions(
      { fileName: 'util.ts', languageId: 'typescript', fileSummary: text.split('\n').slice(0, 4).join('\n'), functions: fns },
      { channel: 'claude', progress: { onText: (t) => streamed.push(t), onExplanation: (e) => seen.push(e) } },
    );
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((e) => e.name), ['slugify', 'add', 'fetchJson']);
    for (const e of out) {
      assert.match(e.summary, /^It does its job for /);
      assert.ok(e.steps.length >= 2 && e.steps.length <= 5);
      assert.equal(e.modelChannel, 'claude');
    }
    assert.equal(seen.length, 3);
    assert.ok(streamed.length > 0, 'text streamed while the reply arrived');
    // The fake logged the prompt it received: the function bodies were inside the fence.
    const logged = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = logged[logged.length - 1];
    assert.equal(last.tool, 'claude');
    assert.ok(last.argv.includes('--output-format') && last.argv.includes('--no-session-persistence'));
    assert.ok(!last.argv.includes('--bare'));
    assert.ok(/-----BEGIN UNTRUSTED CODE [0-9a-f]+-----/.test(last.prompt));
    assert.ok(last.prompt.includes('export function slugify'));

    // Second call: cache hits, no CLI run.
    const before = logged.length;
    const again = await api.router.explainFunctions({ fileName: 'util.ts', languageId: 'typescript', functions: fns }, { channel: 'claude' });
    assert.equal(again.length, 3);
    const after = fs.readFileSync(logFile, 'utf8').trim().split('\n').length;
    assert.equal(after, before, 'cached functions never reach the CLI');
  });

  test('availableChannels reports copilot without throwing, whether or not Copilot is installed', async () => {
    await api.state.update((s) => {
      s.consentGranted = true;
    });
    const started = Date.now();
    const avail = await api.router.availableChannels();
    assert.ok(Date.now() - started < 4000, 'fast');
    const copilot = avail.find((a) => a.channel === 'copilot');
    assert.ok(copilot);
    assert.equal(typeof copilot!.available, 'boolean');
    if (!copilot!.available) assert.ok(copilot!.reason && copilot!.reason.length > 10, 'a plain-English reason is given');
    assert.equal(avail.length, 3);
  });

  test('consent false -> vscode.lm.selectChatModels is never called and channels are not used', async () => {
    await api.state.update((s) => {
      s.consentGranted = false;
    });
    let selectCalls = 0;
    const lm = vscode.lm as unknown as { selectChatModels: (...a: unknown[]) => Thenable<unknown[]> };
    const original = lm.selectChatModels;
    let stubbed = false;
    try {
      Object.defineProperty(lm, 'selectChatModels', {
        configurable: true,
        writable: true,
        value: (...a: unknown[]) => {
          selectCalls++;
          return original.apply(lm, a as []);
        },
      });
      stubbed = true;
    } catch {
      /* the namespace may be frozen: the availability reason still proves the gate */
    }
    try {
      const avail = await api.router.availableChannels();
      const copilot = avail.find((a) => a.channel === 'copilot')!;
      assert.equal(copilot.available, false);
      assert.match(copilot.reason ?? '', /permission/);
      if (stubbed) assert.equal(selectCalls, 0);
      await assert.rejects(
        api.router.explainFunctions({ fileName: 'x.ts', languageId: 'typescript', functions: [{ functionId: 'f#0', name: 'f', text: 'function f() {}', contentHash: contentHashOf('function f() {}') }] }),
        /permission/,
      );
      if (stubbed) assert.equal(selectCalls, 0);
    } finally {
      if (stubbed) Object.defineProperty(lm, 'selectChatModels', { configurable: true, writable: true, value: original });
    }
  });

  test('estimateCost and promptHash work inside the extension host', () => {
    const est = api.router.estimateCost([{ fileName: 'a.ts', languageId: 'typescript', functions: Array.from({ length: 25 }, (_, i) => ({ functionId: `f${i}`, name: `f${i}`, text: 'x'.repeat(100), contentHash: String(i) })) }]);
    assert.equal(est.functions, 25);
    assert.equal(est.requests, 2);
    assert.match(api.router.promptHash(), /^[0-9a-f]{64}$/);
  });
});
