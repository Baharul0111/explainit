/**
 * Doctor glue: gathers the real inputs (files, HTTP, hook script child process, module calls) and
 * hands them to the pure composition in pure/doctorChecks.ts; then renders the report and offers
 * "Fix all". Must finish in < 15 s: every check has its own timeout and they run concurrently.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { DoctorReport, GateSessionInfo } from '../core/interfaces';
import type { AgentKind } from '../core/types';
import { HOME_LAYOUT, explainitHome } from '../core/paths';
import type { Logger } from '../core/log';
import { applyAllFixes, runDoctorChecks, type DoctorDeps, type InstructionFileProbe } from './pure/doctorChecks';
import { probeHealthWithRetry } from './pure/health';
import { MESSAGES, msg, describeError } from './pure/messages';
import { planHookLaunch } from './pure/hookLaunch';
import { HOOK_OUTPUT_CAP, codexPathsFor, interpretHookOutput, parseSessionFile, syntheticWritePayload, type HookOutcome } from './pure/parsers';
import { renderDoctorMarkdown } from './pure/render';
import type { Prompter } from './prompts';
import type { UxDeps } from './deps';
import type { VirtualDocs } from './virtualDocs';

export interface DoctorGlueDeps {
  ux: UxDeps;
  prompter: Prompter;
  virtualDocs: VirtualDocs;
  logger: Logger;
  folders: () => string[];
  runOnboarding: () => Promise<void>;
  resumeCheckpoint: () => Promise<void>;
}

export const DOCTOR_DOC_NAME = 'ExplainIT Doctor report.md';
const FIX_ALL = 'Fix all';
const OPEN_REPORT = 'Open report';

/**
 * Run the hook with a synthetic twin-file Write for `folder`; the gate answers twin writes by itself, so no
 * human is needed. The hook is exercised the way the assistants run it: through the installed wrapper
 * (pinned runtime, pinned home) when one exists, else the script directly with this process's Node
 * (see pure/hookLaunch.ts). It always runs as `--agent claude` with a Claude-shaped payload: Claude hook
 * semantics print every answer, whereas under `--agent codex` a bare allow prints nothing (see parsers.ts).
 */
export async function hookLiveTest(ux: UxDeps, folder: string, logger: Logger, timeoutMs = 7000): Promise<HookOutcome> {
  let script = '';
  try {
    script = ux.adapters.hookScriptPath();
  } catch {
    script = '';
  }
  if (!script || !fs.existsSync(script)) script = path.join(ux.extensionPath, 'hooks', 'explainit-hook.js');

  const watchdog = Math.max(3, Math.floor(timeoutMs / 1000) - 1);
  const adapters = ux.state.read().adapters ?? {};
  const plan = planHookLaunch({
    wrapperCandidates: [adapters.claude?.wrapperPath, adapters.codex?.wrapperPath],
    scriptPath: script,
    platform: process.platform,
    execPath: process.execPath,
    exists: (p) => fs.existsSync(p),
    watchdogSeconds: watchdog,
    home: explainitHome(),
    agent: 'claude',
  });
  if ('error' in plan) return { answered: false, problem: plan.error };
  const via = plan.description;

  const target = path.join(folder, 'explainit-doctor-probe_explain.txt');
  const payload = syntheticWritePayload(folder, target, 'explainit-doctor-probe.py');
  return new Promise<HookOutcome>((resolve) => {
    let settled = false;
    const done = (o: HookOutcome) => {
      if (settled) return;
      settled = true;
      resolve({ ...o, via });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Argument array only; never a shell string built from anything an agent wrote. EXPLAINIT_HOME is
      // set for older hook builds; the `--home` argument is what the current hook prefers.
      child = spawn(plan.command, plan.args, {
        cwd: folder,
        env: { ...process.env, EXPLAINIT_HOME: explainitHome(), ...plan.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (e) {
      return done({ answered: false, problem: `could not start the hook ${via}: ${describeError(e)}` });
    }
    let out = '';
    let err = '';
    // Keep only a bounded prefix: a misbehaving script that floods stdout must not eat memory.
    child.stdout?.on('data', (c: Buffer) => {
      if (out.length < HOOK_OUTPUT_CAP) out += c.toString('utf8').slice(0, HOOK_OUTPUT_CAP - out.length);
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (err.length < HOOK_OUTPUT_CAP) err += c.toString('utf8').slice(0, HOOK_OUTPUT_CAP - err.length);
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done({ answered: false, problem: `the hook script did not finish within ${Math.round(timeoutMs / 1000)} seconds` });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ answered: false, problem: `could not run the hook script: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      logger.debug('hook live test finished', { code, out: out.slice(0, 300), err: err.slice(0, 300) });
      done(interpretHookOutput(out, code, err));
    });
    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      done({ answered: false, problem: `could not send the test payload: ${describeError(e)}` });
    }
  });
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function readSessionFile(pid: number): Promise<GateSessionInfo | undefined> {
  return parseSessionFile(await readText(path.join(HOME_LAYOUT.sessions(), `${pid}.json`)));
}

async function freeBytesAt(p: string): Promise<number> {
  let cur = p;
  for (;;) {
    try {
      const st = await fs.promises.statfs(cur);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) throw new Error(`could not read free space for ${p}`);
      cur = parent;
    }
  }
}

async function gitExcludeText(folder: string): Promise<string | undefined | 'no-git'> {
  const gitDir = path.join(folder, '.git');
  try {
    const st = await fs.promises.stat(gitDir);
    if (st.isFile()) {
      // worktree / submodule: ".git" is a file pointing at the real git dir
      const ptr = (await readText(gitDir)) ?? '';
      const m = /gitdir:\s*(.+)/i.exec(ptr);
      if (!m) return 'no-git';
      const real = path.resolve(folder, m[1].trim());
      return (await readText(path.join(real, 'info', 'exclude'))) ?? '';
    }
  } catch {
    return 'no-git';
  }
  return (await readText(path.join(gitDir, 'info', 'exclude'))) ?? '';
}

async function instructionFiles(folder: string): Promise<InstructionFileProbe[]> {
  const specs: { agent: AgentKind; file: string }[] = [
    { agent: 'claude', file: 'CLAUDE.md' },
    { agent: 'codex', file: 'AGENTS.md' },
    { agent: 'copilot', file: path.join('.github', 'copilot-instructions.md') },
  ];
  return Promise.all(specs.map(async (s) => ({ agent: s.agent, file: s.file, text: await readText(path.join(folder, s.file)) })));
}

export function buildDoctorDeps(g: DoctorGlueDeps): DoctorDeps {
  const { ux } = g;
  const folders = g.folders();
  // Memoise detection so the several checks that need it share one (bounded) call.
  let detectP: ReturnType<typeof ux.adapters.detect> | undefined;
  let statesP: ReturnType<typeof ux.adapters.states> | undefined;
  let integrityP: ReturnType<typeof ux.adapters.verifyIntegrity> | undefined;
  const detect = () => (detectP ??= ux.adapters.detect());
  const states = () => (statesP ??= ux.adapters.states());
  const verifyIntegrity = () => (integrityP ??= ux.adapters.verifyIntegrity());

  return {
    consentGranted: () => ux.consent.granted(),
    detect,
    channels: () => ux.router.availableChannels(),
    gateInfo: () => ux.gate.info,
    gatePaused: () => ux.gate.paused,
    healthProbe: (port) => probeHealthWithRetry(port, 2000),
    readSessionFile,
    verifyIntegrity,
    adapterStates: states,
    // Codex honours CODEX_HOME; show the same files the adapters read (never a hard-coded ~/.codex).
    codexPaths: codexPathsFor(process.env, os.homedir(), explainitHome()),
    hookLiveTest: (folder) => hookLiveTest(ux, folder, g.logger),
    folders,
    // Match each kit to its folder by identity (safetyFor returns the same kit object per folder).
    kits: ux.kits().map((k) => ({
      folder: folders.find((f) => ux.safetyFor(f) === k) ?? path.dirname(k.journal.file),
      verifyChain: () => k.journal.verifyChain(),
      selfTest: () => k.checkpoints.selfTest(),
    })),
    gitExcludeText,
    instructionFiles,
    sectionText: (agent) => {
      try {
        return ux.instructions.sectionText(agent);
      } catch {
        return '';
      }
    },
    watchdogSeconds: ux.settings.get('gateWatchdogSeconds'),
    freeBytes: () => freeBytesAt(explainitHome()),
    checkpointsMaxTotalMB: ux.settings.get('checkpointsMaxTotalMB'),
    fixes: {
      runOnboarding: g.runOnboarding,
      installHook: async (agent) => {
        const r = await ux.adapters.install(agent);
        if (!r.ok) throw new Error(r.detail || `the ${agent} hook could not be installed`);
        if (r.nextSteps.length) void g.prompter.notify(msg('onboardingConnected', { agent, steps: r.nextSteps.join(' ') }), 'info');
      },
      rearm: async () => {
        const r = await ux.adapters.rearm();
        if (!r.ok) throw new Error(r.checks.filter((c) => !c.ok).map((c) => c.name).join(', ') || 're-arm did not succeed');
      },
      addGitExclude: async (folder) => {
        const r = await ux.twin.ensureGitExclude(folder);
        if (r === 'error') throw new Error('could not write .git/info/exclude');
      },
      updateInstructions: async (folder) => {
        await ux.instructions.ensure(folder);
      },
      resumeCheckpoint: g.resumeCheckpoint,
      resetWatchdog: () => ux.settings.set('gateWatchdogSeconds', 120),
    },
  };
}

export async function runDoctor(g: DoctorGlueDeps): Promise<DoctorReport> {
  g.logger.info('doctor started');
  void g.prompter.notify(MESSAGES.doctorRunning, 'info');
  const started = Date.now();
  const report = await runDoctorChecks(buildDoctorDeps(g));
  g.logger.info(`doctor finished in ${Date.now() - started} ms: ${report.checks.filter((c) => !c.ok).length} problem(s) in ${report.checks.length} checks`);

  const markdown = renderDoctorMarkdown(report, g.ux.version);
  await g.virtualDocs.show(DOCTOR_DOC_NAME, markdown, { preview: true, silent: g.prompter.testMode });

  const fixable = report.checks.some((c) => !c.ok && c.fix);
  const summary = report.ok
    ? msg('doctorAllOk', { count: report.checks.length })
    : msg('doctorProblems', { failed: report.checks.filter((c) => !c.ok).length, count: report.checks.length });
  const buttons = report.ok ? [] : fixable ? [FIX_ALL, OPEN_REPORT] : [OPEN_REPORT];
  void g.prompter.notify(summary, report.ok ? 'info' : 'warning', ...buttons).then(async (choice) => {
    if (choice === OPEN_REPORT) await g.virtualDocs.show(DOCTOR_DOC_NAME, markdown, { preview: true });
    if (choice === FIX_ALL) {
      const r = await applyAllFixes(report);
      for (const f of r.failed) void g.prompter.notify(msg('doctorFixFailed', { name: f.name, detail: describeError(f.detail) }), 'error');
      void g.prompter.notify(msg('doctorFixed', { count: r.applied.length }), 'info');
    }
  });
  return report;
}
