// ExplainIT install probe. Plain CommonJS, no build step, no dependencies beyond `vscode`.
// Loaded as the development extension by test/install-smoke/run.ts while ExplainIT itself is loaded
// from the VSIX installed into the throw-away profile. Each step is written to the JSON result file
// (EXPLAINIT_SMOKE_RESULT) as it completes, so a timeout still shows how far the probe got.
// The last three steps exercise the checkpoint exactly as Claude Code would after a real install:
// the hook is installed through the installed extension's API, the wrapper it wrote is run through
// the shell with a PreToolUse Write payload on stdin, and the review is driven through the same
// test hook the integration tests use (EXPLAINIT_TEST_MODE=1 exposes globalThis.__explainitReviewTestHook,
// shared with this probe because every extension runs in the same extension host).
'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXTENSION_ID = 'BaharulIslam.explainit-code';
const REQUIRED_COMMANDS = ['explainit.openTwin', 'explainit.doctor', 'explainit.pauseCheckpoint'];
const resultFile = process.env.EXPLAINIT_SMOKE_RESULT || '';
const workspaceDir = process.env.EXPLAINIT_SMOKE_WORKSPACE || '';
const explainitHome = process.env.EXPLAINIT_HOME || '';
// The installed extension writes ~/.claude/settings.json under this folder (installer.userHomeDir()).
const userHome = process.env.EXPLAINIT_USER_HOME || path.join(explainitHome, 'user-home');

// Step names: keep in step with REQUIRED_STEPS in ../pure/smoke.ts (smoke.test.ts checks they match).
const STEP_INSTALLED = 'ExplainIT is installed from the VSIX';
const STEP_ACTIVATES = 'ExplainIT activates and exports its API';
const STEP_COMMANDS = 'Commands openTwin, doctor and pauseCheckpoint are registered';
const STEP_GATE = 'Checkpoint gate is listening on 127.0.0.1';
const STEP_OPENS = 'Opens src/app.py';
const STEP_TWIN = 'Twin app_explain.txt is written beside app.py with "1. load_config" explained by the assistant';
const STEP_TWIN_OPEN = 'Twin is open in an editor beside the code';
const STEP_EXCLUDE = '.git/info/exclude contains *_explain.txt';
const STEP_HOOK_INSTALL = 'Claude Code hook installs through the installed extension (wrapper, hook script and settings.json in the temp user home)';
const STEP_HOOK_REJECT = 'Installed hook: a Write that changes greet() is denied when the person rejects it, with the reason given, and app.py is unchanged';
const STEP_HOOK_ACCEPT = 'Installed hook: the same Write is allowed when the person accepts it, and a restore point for app.py was saved first';

const HOOK_MARK = 'explainit-hook';
const GREET_BEFORE = 'message = "Hello, " + name';
const GREET_AFTER = 'message = "Hi there, " + name';
const REJECT_REASON = 'keep it';
const HOOK_TIMEOUT_MS = 120000;
const REVIEW_TIMEOUT_MS = 60000;

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

/**
 * Copy of twinSectionStatus() from ../pure/smoke.ts (the probe has no build step, so it cannot import
 * the TypeScript helper). Keep the two in step. Complete = a real "What it does:" sentence (not the
 * "(explaining...)" / "(not explained yet ...)" placeholder) and 2..5 "How it works" steps.
 */
function twinSectionStatus(text, index, name) {
  if (text === undefined || text === '') return { state: 'missing', detail: 'the twin file does not exist yet', steps: 0 };
  const lines = text.split(/\r?\n/);
  const header = `${index}. ${name}`;
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return { state: 'missing', detail: `no "${header}" section (first lines: ${lines.slice(0, 3).join(' | ')})`, steps: 0 };
  const section = [];
  for (let i = start + 1; i < lines.length && lines[i].trim() !== '' && !/^\d+\. /.test(lines[i]); i++) section.push(lines[i]);
  const what = section.find((l) => l.startsWith('What it does: '));
  if (!what) return { state: 'incomplete', detail: `the "${header}" section has no "What it does:" line`, steps: 0 };
  const summary = what.slice('What it does: '.length).trim();
  if (summary.startsWith('(explaining')) return { state: 'pending', detail: 'the section still says "(explaining...)": the assistant has not answered yet', steps: 0 };
  if (summary.startsWith('(not explained yet')) return { state: 'unavailable', detail: 'the section says "(not explained yet ...)": no assistant was used', steps: 0 };
  const howAt = section.indexOf('How it works:');
  const steps = howAt < 0 ? 0 : section.slice(howAt + 1).filter((l) => l.startsWith('- ')).length;
  if (howAt < 0 || steps < 2) return { state: 'incomplete', detail: `the section has ${steps} "How it works" step(s); at least 2 expected`, summary, steps };
  if (steps > 5) return { state: 'incomplete', detail: `the section has ${steps} "How it works" steps; at most 5 expected`, summary, steps };
  if (!/[.!?]$/.test(summary)) return { state: 'incomplete', detail: `the summary is not a sentence: "${summary}"`, summary, steps };
  return { state: 'complete', detail: `${what} (${steps} steps)`, summary, steps };
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

// ---- checkpoint round trip helpers (copies of the pure helpers in ../pure/smoke.ts) -------------

/** The PreToolUse command ExplainIT wrote into settings.json (the entry naming the hook, not the PostToolUse one). */
function hookCommandFromSettings(settingsText) {
  if (settingsText === undefined) return { problem: 'settings.json does not exist' };
  let parsed;
  try {
    parsed = JSON.parse(settingsText);
  } catch (e) {
    return { problem: `settings.json is not valid JSON: ${e.message}` };
  }
  const groups = parsed && parsed.hooks && parsed.hooks.PreToolUse;
  if (!Array.isArray(groups)) return { problem: 'settings.json has no hooks.PreToolUse list' };
  for (const g of groups) {
    const hooks = g && g.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      const command = h && h.command;
      if (typeof command === 'string' && command.includes(HOOK_MARK) && !/--event\s+PostToolUse/.test(command)) return { command };
    }
  }
  return { problem: `no PreToolUse entry whose command contains "${HOOK_MARK}"` };
}

/** Run a hook command line the way Claude Code does: through the shell, payload on stdin. */
function shellInvocation(commandLine) {
  if (process.platform === 'win32') return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${commandLine}"`], windowsVerbatimArguments: true };
  return { command: 'sh', args: ['-c', commandLine], windowsVerbatimArguments: false };
}

function parseHookStdout(stdout) {
  const text = (stdout || '').trim();
  if (!text) return { problem: 'the hook printed nothing, so the assistant would have used its own permission prompt (no ExplainIT decision)' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { problem: `the hook printed something that is not JSON (${e.message}): ${text.slice(0, 200)}` };
  }
  const out = parsed && parsed.hookSpecificOutput;
  const decision = out && out.permissionDecision;
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') return { problem: `the hook printed no permissionDecision: ${text.slice(0, 200)}` };
  return { decision, reason: typeof out.permissionDecisionReason === 'string' ? out.permissionDecisionReason : undefined };
}

function claudeWritePayload(o) {
  return {
    session_id: o.sessionId,
    transcript_path: path.join(o.cwd, '.transcript.jsonl'),
    cwd: o.cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: o.filePath, content: o.content },
    tool_use_id: o.toolUseId,
  };
}

/** Spawn the installed hook with the payload on stdin; resolves with what it printed (never rejects). */
function runHook(commandLine, payload) {
  return new Promise((resolve) => {
    const started = Date.now();
    const inv = shellInvocation(commandLine);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (code, signal, extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: (stderr + (extra || '')).trim(), code, signal, ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      try {
        child && child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      finish(null, 'timeout', `\nthe hook did not exit within ${HOOK_TIMEOUT_MS / 1000} s`);
    }, HOOK_TIMEOUT_MS);
    try {
      child = spawn(inv.command, inv.args, { cwd: workspaceDir, env: process.env, windowsHide: true, windowsVerbatimArguments: inv.windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish(null, null, `\nspawn failed: ${e.message}`);
    }
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => finish(null, null, `\nspawn error: ${e.message}`));
    child.on('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

function reviewHook() {
  return globalThis.__explainitReviewTestHook;
}

function shortRun(r) {
  const out = r.stdout.trim().slice(0, 300) || '(nothing)';
  const err = r.stderr ? ` stderr: ${r.stderr.slice(0, 300)}` : '';
  return `exit ${r.code === null ? r.signal : r.code} after ${Math.round(r.ms / 1000)} s; stdout: ${out}${err}`;
}

function samePath(a, b) {
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const x = real(a);
  const y = real(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * One checkpoint round trip: spawn the installed hook with a Write for app.py, drive the review the
 * way a person would (wait for it to show; for accept wait until the explanation rendered), and
 * return what the hook printed.
 */
async function roundTrip(commandLine, payload, decide) {
  const h = reviewHook();
  if (!h) throw new Error('the review test hook (globalThis.__explainitReviewTestHook) is not installed; is EXPLAINIT_TEST_MODE=1 set for VS Code?');
  if (h.current()) throw new Error(`a review is already open (${h.current().cards.map((c) => c.title).join(', ')}); the checkpoint is not idle`);
  const hookDone = runHook(commandLine, payload);
  let shown;
  try {
    shown = await waitFor('the review to show for the hook\'s Write', () => h.current(), REVIEW_TIMEOUT_MS, 100);
  } catch (e) {
    const r = await Promise.race([hookDone, sleep(2000).then(() => undefined)]);
    throw new Error(`${e.message}${r ? ` The hook already finished: ${shortRun(r)}` : ' The hook is still running.'}`);
  }
  const view = shown.value;
  const card = view.cards[view.hunkIndex];
  const cardInfo = `${view.cards.length} card(s): ${view.cards.map((c) => c.title).join(', ')}`;
  if (decide === 'accept') {
    await h.waitForExplained();
    if (!h.decide('accept')) throw new Error(`Accept was refused for card "${card && card.title}" (${cardInfo})`);
  } else {
    if (!h.decide('reject', REJECT_REASON)) throw new Error(`Reject was refused for card "${card && card.title}" (${cardInfo})`);
  }
  const run = await hookDone;
  return { run, cardInfo, shownMs: shown.ms };
}

async function checkpointSteps(api, appPy) {
  // A. Install the Claude Code hook through the installed extension's own API.
  const t0 = Date.now();
  const install = await api.adapters.install('claude');
  const wrapper = path.join(explainitHome, 'hooks', process.platform === 'win32' ? 'explainit-hook.cmd' : 'explainit-hook.sh');
  const script = path.join(explainitHome, 'hooks', 'explainit-hook.js');
  const settingsFile = path.join(userHome, '.claude', 'settings.json');
  const found = hookCommandFromSettings(readIfExists(settingsFile));
  result.hook = { command: found.command, wrapper };
  const problems = [];
  if (!install.ok) problems.push(`install('claude') failed: ${install.detail || 'no detail'}`);
  if (!fs.existsSync(wrapper)) problems.push(`wrapper missing: ${wrapper}`);
  if (!fs.existsSync(script)) problems.push(`hook script missing: ${script}`);
  if (!found.command) problems.push(`${settingsFile}: ${found.problem}`);
  else if (!found.command.includes('--home')) problems.push(`the hook command does not pin --home: ${found.command}`);
  step(STEP_HOOK_INSTALL, problems.length === 0, problems.length ? problems.join('; ') : `${install.detail || 'installed'}; command: ${found.command}`, Date.now() - t0);

  // B. Reject: the hook must print deny with the person's words, and app.py must not change.
  const before = readIfExists(appPy);
  if (before === undefined || !before.includes(GREET_BEFORE)) step(STEP_HOOK_REJECT, false, `${appPy} does not contain the greet() line to change: ${GREET_BEFORE}`);
  const after = before.replace(GREET_BEFORE, GREET_AFTER);
  const kit = api.kits()[0];
  const cpBefore = kit ? (await kit.checkpoints.list()).filter((c) => samePath(c.path, appPy)).length : 0;
  try {
    const { run, cardInfo, shownMs } = await roundTrip(found.command, claudeWritePayload({ cwd: workspaceDir, filePath: appPy, content: after, sessionId: 'install-smoke-reject', toolUseId: 'toolu_smoke_reject' }), 'reject');
    result.hook.reject = { stdout: run.stdout, stderr: run.stderr, code: run.code, ms: run.ms };
    const out = parseHookStdout(run.stdout);
    const unchanged = readIfExists(appPy) === before;
    const ok = run.code === 0 && out.decision === 'deny' && !!out.reason && out.reason.includes(REJECT_REASON) && unchanged;
    const why = out.problem
      ? out.problem
      : out.decision !== 'deny'
        ? `expected deny, got ${out.decision} (${out.reason || 'no reason'})`
        : !out.reason || !out.reason.includes(REJECT_REASON)
          ? `the deny reason does not carry the person's words "${REJECT_REASON}": ${out.reason}`
          : !unchanged
            ? 'app.py changed on disk although the write was rejected'
            : run.code !== 0
              ? `hook exit code ${run.code}`
              : '';
    record(STEP_HOOK_REJECT, ok, ok ? `deny: "${out.reason}"; review showed after ${Math.round(shownMs)} ms with ${cardInfo}; ${shortRun(run)}` : `${why}. ${shortRun(run)}`, run.ms);
  } catch (e) {
    record(STEP_HOOK_REJECT, false, e.message);
  }

  // C. Accept: allow, and a restore point of the pre-change app.py exists (the agent does the write itself).
  try {
    const { run, cardInfo, shownMs } = await roundTrip(found.command, claudeWritePayload({ cwd: workspaceDir, filePath: appPy, content: after, sessionId: 'install-smoke-accept', toolUseId: 'toolu_smoke_accept' }), 'accept');
    result.hook.accept = { stdout: run.stdout, stderr: run.stderr, code: run.code, ms: run.ms };
    const out = parseHookStdout(run.stdout);
    const cps = kit ? (await kit.checkpoints.list()).filter((c) => samePath(c.path, appPy)) : [];
    const restorePoint = cps.length > cpBefore;
    let snapshotOk = false;
    if (restorePoint && kit) {
      const read = await kit.checkpoints.read(cps[cps.length - 1].id);
      snapshotOk = !!read && read.content === before;
    }
    const unchanged = readIfExists(appPy) === before;
    const ok = run.code === 0 && out.decision === 'allow' && restorePoint && snapshotOk && unchanged;
    const why = out.problem
      ? out.problem
      : out.decision !== 'allow'
        ? `expected allow, got ${out.decision} (${out.reason || 'no reason'})`
        : !kit
          ? 'api.kits() is empty: no safety kit for the workspace folder'
          : !restorePoint
            ? `no new restore point for app.py in api.kits()[0].checkpoints.list() (${cps.length} before and after)`
            : !snapshotOk
              ? 'the restore point does not hold the pre-change app.py'
              : !unchanged
                ? 'app.py changed on disk although only the agent writes on allow'
                : `hook exit code ${run.code}`;
    record(STEP_HOOK_ACCEPT, ok, ok ? `allow; restore point ${cps[cps.length - 1].id} holds the pre-change app.py; review showed after ${Math.round(shownMs)} ms with ${cardInfo}; ${shortRun(run)}` : `${why}. ${shortRun(run)}`, run.ms);
  } catch (e) {
    record(STEP_HOOK_ACCEPT, false, e.message);
  }
}

async function runProbe() {
  if (!workspaceDir) throw new Error('EXPLAINIT_SMOKE_WORKSPACE is not set; the probe must be launched by test/install-smoke/run.ts.');

  // 1. The VSIX-installed extension is present (activation order between extensions is not guaranteed).
  const found = await waitFor('the ExplainIT extension to appear in the installed extensions', () => vscode.extensions.getExtension(EXTENSION_ID), 60000);
  const ext = found.value;
  result.extensionVersion = ext.packageJSON && ext.packageJSON.version;
  step(STEP_INSTALLED, true, `version ${result.extensionVersion} at ${ext.extensionPath}`, found.ms);

  // 2. Activate and get the API.
  const t = Date.now();
  const api = await ext.activate();
  const hasApi = !!(api && api.gate && api.twin && api.router && api.structure && api.adapters && api.ux && typeof api.kits === 'function');
  step(STEP_ACTIVATES, hasApi, hasApi ? 'gate, twin, router, structure, adapters, ux, kits present' : 'activate() returned an incomplete API', Date.now() - t);

  // 3. Commands.
  const all = new Set(await vscode.commands.getCommands(true));
  const missing = REQUIRED_COMMANDS.filter((c) => !all.has(c));
  step(STEP_COMMANDS, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : REQUIRED_COMMANDS.join(', '));

  // 4. The checkpoint gate is listening on loopback (goal item 12: a status people can rely on).
  const info = api.gate.info;
  step(STEP_GATE, !!(info && info.port > 0 && info.folders), info ? `port ${info.port}, ${info.folders.length} folder(s)` : 'gate.info is undefined; the gate did not start');

  // 5. Open app.py from the temp workspace.
  const appPy = path.join(workspaceDir, 'src', 'app.py');
  if (!fs.existsSync(appPy)) step('src/app.py exists in the temp workspace', false, `missing: ${appPy}`);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(appPy));
  await vscode.window.showTextDocument(doc, { preview: false });
  step(STEP_OPENS, true, appPy);

  // 6. Trigger the twin explicitly (auto-open may already have started it; the command is idempotent).
  let commandError;
  const commandDone = Promise.resolve()
    .then(() => vscode.commands.executeCommand('explainit.openTwin'))
    .catch((e) => {
      commandError = String((e && e.message) || e);
    });

  // 7. The twin file appears beside the source with the first function fully explained by the fake
  //    assistant (a placeholder such as "(explaining...)" does not count). "(not explained yet)" means
  //    no assistant was used; give the engine a short grace period, then stop waiting.
  const twinPath = path.join(workspaceDir, 'src', 'app_explain.txt');
  const TWIN_STEP = STEP_TWIN;
  let status = { state: 'missing', detail: 'not checked yet', steps: 0 };
  let unavailableSince;
  try {
    const got = await waitFor(
      'app_explain.txt to contain a complete "1. load_config" section',
      () => {
        if (commandError) throw new Error(`the openTwin command failed: ${commandError}`);
        status = twinSectionStatus(readIfExists(twinPath), 1, 'load_config');
        if (status.state === 'unavailable') {
          unavailableSince = unavailableSince || Date.now();
          if (Date.now() - unavailableSince > 15000) throw new Error(status.detail);
        } else unavailableSince = undefined;
        return status.state === 'complete' ? status : undefined;
      },
      120000,
      500,
    );
    record(TWIN_STEP, true, got.value.detail, got.ms);
  } catch (e) {
    const hint =
      status.state === 'unavailable'
        ? ' Check explainit.assistant.claudeCliPath in the temp settings.json and that node is on PATH.'
        : status.state === 'pending'
          ? ' The fake assistant did not answer in time; run with EXPLAINIT_SMOKE_VERBOSE=1 and look at the ExplainIT log.'
          : '';
    record(TWIN_STEP, false, `${status.detail}. ${e.message}${hint}`);
  }
  await Promise.race([commandDone, sleep(5000)]);

  // 8. The twin is open in an editor next to the code.
  try {
    const shown = await waitFor(
      'the twin to be visible in an editor',
      () => vscode.window.visibleTextEditors.some((ed) => ed.document.uri.fsPath.endsWith('app_explain.txt')),
      20000,
    );
    record(STEP_TWIN_OPEN, true, `${vscode.window.visibleTextEditors.length} visible editor(s)`, shown.ms);
  } catch (e) {
    record(STEP_TWIN_OPEN, false, `${e.message} Visible: ${vscode.window.visibleTextEditors.map((ed) => path.basename(ed.document.uri.fsPath)).join(', ') || 'none'}`);
  }

  // 9. Twins stay out of git: .git/info/exclude lists *_explain.txt (written at startup, asynchronously).
  const excludeFile = path.join(workspaceDir, '.git', 'info', 'exclude');
  try {
    const got = await waitFor('.git/info/exclude to contain *_explain.txt', () => ((readIfExists(excludeFile) || '').split(/\r?\n/).some((l) => l.trim() === '*_explain.txt') ? true : undefined), 30000, 500);
    record(STEP_EXCLUDE, true, excludeFile, got.ms);
  } catch (e) {
    const text = readIfExists(excludeFile);
    record(STEP_EXCLUDE, false, text === undefined ? `${excludeFile} does not exist. ${e.message}` : `current content: ${JSON.stringify(text)}`);
  }

  // 10-12. The checkpoint after a real install: hook installed through the extension, then the
  // installed wrapper is run with a Claude Code Write payload, rejected once and accepted once.
  await checkpointSteps(api, appPy);

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
