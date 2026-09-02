// ExplainIT install probe. Plain CommonJS, no build step, no dependencies beyond `vscode`.
// Loaded as the development extension by test/install-smoke/run.ts while ExplainIT itself is loaded
// from the VSIX installed into the throw-away profile. Each step is written to the JSON result file
// (EXPLAINIT_SMOKE_RESULT) as it completes, so a timeout still shows how far the probe got.
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const EXTENSION_ID = 'BaharulIslam.explainit';
const REQUIRED_COMMANDS = ['explainit.openTwin', 'explainit.doctor', 'explainit.pauseCheckpoint'];
const resultFile = process.env.EXPLAINIT_SMOKE_RESULT || '';
const workspaceDir = process.env.EXPLAINIT_SMOKE_WORKSPACE || '';

const result = { ok: false, startedAt: new Date().toISOString(), vscodeVersion: vscode.version, steps: [] };

function save() {
  if (!resultFile) return;
  try {
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('[probe] could not write result file', e);
  }
}

class StepFailed extends Error {
  constructor(name, detail) {
    super(`${name}: ${detail}`);
    this.recorded = true;
  }
}

/** Record a check without stopping (independent checks keep going so one report shows everything). */
function record(name, ok, detail, ms) {
  result.steps.push({ name, ok: ok === true, detail, ms });
  save();
  console.log(`[probe] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
  return ok === true;
}

/** Record a check and stop the probe when it fails (later steps depend on it). */
function step(name, ok, detail, ms) {
  if (!record(name, ok, detail, ms)) throw new StepFailed(name, detail || 'failed');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns a truthy value; the message says what we were waiting for. */
async function waitFor(what, probe, timeoutMs, everyMs) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      last = await probe();
    } catch (e) {
      last = undefined;
      result.lastError = String((e && e.message) || e);
    }
    if (last) return { value: last, ms: Date.now() - started };
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}.`);
    await sleep(everyMs || 250);
  }
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function runProbe() {
  if (!workspaceDir) throw new Error('EXPLAINIT_SMOKE_WORKSPACE is not set; the probe must be launched by test/install-smoke/run.ts.');

  // 1. The VSIX-installed extension is present (activation order between extensions is not guaranteed).
  const found = await waitFor('the ExplainIT extension to appear in the installed extensions', () => vscode.extensions.getExtension(EXTENSION_ID), 60000);
  const ext = found.value;
  result.extensionVersion = ext.packageJSON && ext.packageJSON.version;
  step('ExplainIT is installed from the VSIX', true, `version ${result.extensionVersion} at ${ext.extensionPath}`, found.ms);

  // 2. Activate and get the API.
  const t = Date.now();
  const api = await ext.activate();
  const hasApi = !!(api && api.gate && api.twin && api.router && api.structure && api.adapters && api.ux);
  step('ExplainIT activates and exports its API', hasApi, hasApi ? 'gate, twin, router, structure, adapters, ux present' : 'activate() returned an incomplete API', Date.now() - t);

  // 3. Commands.
  const all = new Set(await vscode.commands.getCommands(true));
  const missing = REQUIRED_COMMANDS.filter((c) => !all.has(c));
  step('Commands openTwin, doctor and pauseCheckpoint are registered', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : REQUIRED_COMMANDS.join(', '));

  // 4. The checkpoint gate is listening on loopback (goal item 12: a status people can rely on).
  const info = api.gate.info;
  step('Checkpoint gate is listening on 127.0.0.1', !!(info && info.port > 0 && info.folders), info ? `port ${info.port}, ${info.folders.length} folder(s)` : 'gate.info is undefined; the gate did not start');

  // 5. Open app.py from the temp workspace.
  const appPy = path.join(workspaceDir, 'src', 'app.py');
  if (!fs.existsSync(appPy)) step('src/app.py exists in the temp workspace', false, `missing: ${appPy}`);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(appPy));
  await vscode.window.showTextDocument(doc, { preview: false });
  step('Opens src/app.py', true, appPy);

  // 6. Trigger the twin explicitly (auto-open may already have started it; the command is idempotent).
  let commandError;
  const commandDone = Promise.resolve()
    .then(() => vscode.commands.executeCommand('explainit.openTwin'))
    .catch((e) => {
      commandError = String((e && e.message) || e);
    });

  // 7. The twin file appears beside the source with the first function explained by the fake assistant.
  const twinPath = path.join(workspaceDir, 'src', 'app_explain.txt');
  let twinText = '';
  try {
    const got = await waitFor(
      'app_explain.txt to contain "1. load_config" with a real explanation',
      () => {
        twinText = readIfExists(twinPath) || '';
        if (commandError) throw new Error(commandError);
        return twinText.includes('1. load_config') && !twinText.includes('(not explained yet') ? twinText : undefined;
      },
      120000,
      500,
    );
    record('Twin app_explain.txt is written beside app.py with "1. load_config" explained', true, firstSectionSummary(got.value), got.ms);
  } catch (e) {
    const why = commandError
      ? `the openTwin command failed: ${commandError}`
      : !twinText
        ? `no twin file at ${twinPath}. ${e.message}`
        : twinText.includes('(not explained yet')
          ? 'the twin exists but says "not explained yet": the fake assistant was not used. Check explainit.assistant.claudeCliPath in the temp settings.json and that node is on PATH.'
          : `the twin exists but has no "1. load_config" section. First lines: ${twinText.split(/\r?\n/).slice(0, 4).join(' | ')}`;
    record('Twin app_explain.txt is written beside app.py with "1. load_config" explained', false, why);
  }
  await Promise.race([commandDone, sleep(5000)]);

  // 8. The twin is open in an editor next to the code.
  try {
    const shown = await waitFor(
      'the twin to be visible in an editor',
      () => vscode.window.visibleTextEditors.some((ed) => ed.document.uri.fsPath.endsWith('app_explain.txt')),
      20000,
    );
    record('Twin is open in an editor beside the code', true, `${vscode.window.visibleTextEditors.length} visible editor(s)`, shown.ms);
  } catch (e) {
    record('Twin is open in an editor beside the code', false, `${e.message} Visible: ${vscode.window.visibleTextEditors.map((ed) => path.basename(ed.document.uri.fsPath)).join(', ') || 'none'}`);
  }

  // 9. Twins stay out of git: .git/info/exclude lists *_explain.txt (written at startup, asynchronously).
  const excludeFile = path.join(workspaceDir, '.git', 'info', 'exclude');
  try {
    const got = await waitFor('.git/info/exclude to contain *_explain.txt', () => ((readIfExists(excludeFile) || '').split(/\r?\n/).some((l) => l.trim() === '*_explain.txt') ? true : undefined), 30000, 500);
    record('.git/info/exclude contains *_explain.txt', true, excludeFile, got.ms);
  } catch (e) {
    const text = readIfExists(excludeFile);
    record('.git/info/exclude contains *_explain.txt', false, text === undefined ? `${excludeFile} does not exist. ${e.message}` : `current content: ${JSON.stringify(text)}`);
  }

  result.ok = result.steps.every((s) => s.ok);
  save();
}

async function quit() {
  // Nothing should be dirty (twins are written to disk), but never let a "save changes?" dialog block the quit.
  try {
    await vscode.workspace.saveAll(false);
  } catch {
    /* ignore */
  }
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  } catch {
    /* ignore */
  }
  await sleep(300);
  await vscode.commands.executeCommand('workbench.action.quit');
}

function firstSectionSummary(text) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('1. load_config'));
  return i >= 0 ? lines.slice(i, i + 2).join(' | ') : '';
}

function activate() {
  runProbe()
    .catch((e) => {
      const message = String((e && e.message) || e);
      result.error = message;
      if (!(e instanceof StepFailed)) result.steps.push({ name: 'Probe ran to completion', ok: false, detail: message });
      result.ok = false;
      console.error('[probe] FAIL', message);
    })
    .finally(async () => {
      result.finishedAt = new Date().toISOString();
      save();
      await quit();
    });
}

function deactivate() {}

module.exports = { activate, deactivate };
