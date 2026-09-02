/**
 * Pure helpers for the fresh-install smoke test (test/install-smoke/run.ts).
 * No `vscode` import, no file system, no child processes: everything here is a plain function so it
 * can be unit-tested on any OS without downloading VS Code.
 */
import * as path from 'node:path';

export const EXTENSION_ID = 'BaharulIslam.explainit';
/** Commands the probe must find registered after ExplainIT activates. */
export const REQUIRED_COMMANDS = ['explainit.openTwin', 'explainit.doctor', 'explainit.pauseCheckpoint'];
/** Default wall-clock budget for the probe run (VS Code launch -> quit). */
export const DEFAULT_PROBE_TIMEOUT_MS = 3 * 60 * 1000;
/** Budget for one CLI command (install / list). */
export const CLI_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// VSIX discovery
// ---------------------------------------------------------------------------------------------

export interface VsixCandidate {
  name: string;
  mtimeMs: number;
}

const VSIX_RE = /^explainit-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.vsix$/i;

/** "explainit-0.1.0.vsix" -> "0.1.0"; anything else -> undefined. */
export function versionFromVsixName(name: string): string | undefined {
  const m = VSIX_RE.exec(name);
  return m ? m[1] : undefined;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Newest explainit-*.vsix by modification time (a rebuilt package must win over an older, higher
 * version number left behind); the version number breaks ties. Non-matching names are ignored.
 */
export function pickNewestVsix(candidates: VsixCandidate[]): VsixCandidate | undefined {
  const matching = candidates.filter((c) => VSIX_RE.test(c.name));
  matching.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return compareVersions(versionFromVsixName(b.name) ?? '0', versionFromVsixName(a.name) ?? '0');
  });
  return matching[0];
}

export function noVsixMessage(dir: string): string {
  return `No explainit-*.vsix found in ${dir}. Run "npm run package" first, then run this smoke test again.`;
}

// ---------------------------------------------------------------------------------------------
// VS Code CLI invocation
// ---------------------------------------------------------------------------------------------

export interface CliInvocation {
  command: string;
  /** Arguments that always come first (e.g. the cli.js script when running Electron as Node). */
  argsPrefix: string[];
  env: Record<string, string>;
  /** Only set on Windows when Code.exe could not be found and the .cmd shim has to go through cmd.exe. */
  shell: boolean;
}

/**
 * How to run the VS Code CLI that @vscode/test-electron resolved for us.
 * On Windows the CLI is `bin/code.cmd`, which Node refuses to spawn without a shell. The shim is
 * only `ELECTRON_RUN_AS_NODE=1 Code.exe resources/app/out/cli.js %*`, so we run exactly that with an
 * argument array (no shell, no quoting problems with spaces in temp paths). The macOS and Linux CLIs
 * are executable scripts and run directly.
 */
export function cliInvocation(cliPath: string, platform: NodeJS.Platform, exists: (p: string) => boolean): CliInvocation {
  if (platform === 'win32' && /\.cmd$/i.test(cliPath)) {
    const root = path.resolve(path.dirname(cliPath), '..');
    const codeExe = path.join(root, 'Code.exe');
    const cliJs = path.join(root, 'resources', 'app', 'out', 'cli.js');
    if (exists(codeExe) && exists(cliJs)) {
      return { command: codeExe, argsPrefix: [cliJs], env: { ELECTRON_RUN_AS_NODE: '1' }, shell: false };
    }
    return { command: cliPath, argsPrefix: [], env: {}, shell: true };
  }
  return { command: cliPath, argsPrefix: [], env: {}, shell: false };
}

/** Quote an argument for cmd.exe (only used on the Windows shell fallback; never with agent text). */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '\\"') + '"';
}

export function installArgs(vsix: string, userDataDir: string, extensionsDir: string): string[] {
  return ['--install-extension', vsix, '--user-data-dir', userDataDir, '--extensions-dir', extensionsDir, '--force'];
}

export function listArgs(userDataDir: string, extensionsDir: string): string[] {
  return ['--list-extensions', '--show-versions', '--user-data-dir', userDataDir, '--extensions-dir', extensionsDir];
}

/** `--list-extensions --show-versions` output -> [{ id (lower-case), version }]. Noise lines are dropped. */
export function parseListExtensions(stdout: string): { id: string; version?: string }[] {
  const out: { id: string; version?: string }[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    // Extension ids look like publisher.name[@version]; anything else is a log line.
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*)(?:@(\S+))?$/.exec(line);
    if (m) out.push({ id: m[1].toLowerCase(), version: m[2] });
  }
  return out;
}

export function hasExtension(list: { id: string }[], id: string): boolean {
  const want = id.toLowerCase();
  return list.some((e) => e.id === want);
}

// ---------------------------------------------------------------------------------------------
// Fresh profile: settings, state, workspace, launch
// ---------------------------------------------------------------------------------------------

/**
 * User settings for the throw-away profile. ExplainIT is pointed at the fake Claude CLI
 * (`node <script>`; the resolver splits on the first space when the value ends with .js) and the
 * assistant channel is pinned to claude so no other assistant is consulted. The rest keeps VS Code
 * quiet and offline: no welcome page, no update checks, no telemetry, no trust prompt.
 */
export function buildUserSettings(fakeClaudeCli: string): Record<string, unknown> {
  return {
    'explainit.assistant.claudeCliPath': `node ${fakeClaudeCli}`,
    'explainit.assistant.channel': 'claude',
    'explainit.twin.autoOpen': true,
    'explainit.checkpoint.enabled': true,
    'explainit.logLevel': 'debug',
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'update.showReleaseNotes': false,
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.ignoreRecommendations': true,
    'workbench.startupEditor': 'none',
    'workbench.enableExperiments': false,
    'window.restoreWindows': 'none',
    'files.hotExit': 'off',
    'git.autoRepositoryDetection': false,
  };
}

/**
 * ExplainIT state pre-seeded as if the person had already granted permission in onboarding
 * (the one setup step goal.md allows: their existing assistant sign-in/permission).
 */
export function seedState(now: string): Record<string, unknown> {
  return { version: 1, consentGranted: true, consentAt: now, onboardingDone: true };
}

export interface ProbeEnvOptions {
  home: string;
  resultFile: string;
  workspaceDir: string;
  repoRoot: string;
}

/** Environment for the VS Code process that runs the probe. Never leaks Electron-as-Node into the UI. */
export function probeEnv(base: NodeJS.ProcessEnv, o: ProbeEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.EXPLAINIT_TEST_MODE = '1';
  env.EXPLAINIT_HOME = o.home;
  env.EXPLAINIT_TEST_ANSWERS = JSON.stringify({ consent: 'Allow' });
  env.EXPLAINIT_SMOKE_RESULT = o.resultFile;
  env.EXPLAINIT_SMOKE_WORKSPACE = o.workspaceDir;
  env.EXPLAINIT_SMOKE_REPO = o.repoRoot;
  return env;
}

export interface LaunchOptions {
  probeDir: string;
  userDataDir: string;
  extensionsDir: string;
  workspaceDir: string;
  platform: NodeJS.Platform;
}

/** Arguments for launching VS Code with the probe as the development extension and the VSIX-installed ExplainIT loaded normally. */
export function launchArgs(o: LaunchOptions): string[] {
  const args = [
    `--extensionDevelopmentPath=${o.probeDir}`,
    '--user-data-dir',
    o.userDataDir,
    '--extensions-dir',
    o.extensionsDir,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-telemetry',
    '--disable-gpu',
    '--new-window',
  ];
  // Headless CI containers (xvfb) have no user namespace for the Chromium sandbox.
  if (o.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
  args.push(o.workspaceDir);
  return args;
}

/** Files copied into the temp workspace: everything from the fixture except stray twins. */
export function shouldCopyFixtureFile(relativePath: string): boolean {
  const base = path.basename(relativePath);
  if (base.endsWith('_explain.txt')) return false;
  if (relativePath.split(/[\\/]/).includes('.git')) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Probe result
// ---------------------------------------------------------------------------------------------

export interface ProbeStep {
  name: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}

export interface ProbeResult {
  ok: boolean;
  startedAt?: string;
  finishedAt?: string;
  vscodeVersion?: string;
  extensionVersion?: string;
  error?: string;
  steps: ProbeStep[];
}

export function parseProbeResult(text: string | undefined): { result?: ProbeResult; problem?: string } {
  if (text === undefined) return { problem: 'the probe never wrote its result file' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { problem: `the probe result file is not valid JSON: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as ProbeResult).steps)) {
    return { problem: 'the probe result file has an unexpected shape' };
  }
  const r = parsed as ProbeResult;
  return { result: { ...r, ok: r.ok === true, steps: r.steps.map((s) => ({ ...s, ok: s.ok === true })) } };
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}

/** Accumulates checks and renders the final PASS/FAIL block with reasons. */
export class Report {
  readonly checks: Check[] = [];
  private readonly notes: string[] = [];

  check(name: string, ok: boolean, detail?: string, ms?: number): boolean {
    this.checks.push({ name, ok, detail, ms });
    return ok;
  }

  note(text: string): void {
    this.notes.push(text);
  }

  get ok(): boolean {
    return this.checks.length > 0 && this.checks.every((c) => c.ok);
  }

  get failures(): Check[] {
    return this.checks.filter((c) => !c.ok);
  }

  render(): string {
    const lines: string[] = [];
    for (const c of this.checks) {
      const time = c.ms !== undefined ? ` (${formatMs(c.ms)})` : '';
      lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${time}${c.detail ? `\n        ${c.detail.replace(/\n/g, '\n        ')}` : ''}`);
    }
    for (const n of this.notes) lines.push(`  note  ${n}`);
    const verdict = this.ok ? 'PASS' : 'FAIL';
    const summary = this.ok
      ? `${verdict}: ExplainIT installs from its package into a fresh VS Code and works (${this.checks.length} checks).`
      : `${verdict}: ${this.failures.length} of ${this.checks.length} checks failed:\n${this.failures.map((f) => `  - ${f.name}${f.detail ? `: ${f.detail.split('\n')[0]}` : ''}`).join('\n')}`;
    return `${lines.join('\n')}\n\n${summary}`;
  }
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// ---------------------------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------------------------

export interface SmokeArgs {
  /** Keep the temp profile/workspace after the run (also EXPLAINIT_SMOKE_KEEP=1). */
  keep: boolean;
  /** VS Code version to download (VSCODE_TEST_VERSION env or --version). */
  version: string;
  timeoutMs: number;
  /** Explicit VSIX path instead of the newest one in the repo root. */
  vsix?: string;
  help: boolean;
  /** Unknown flags, reported as an error. */
  unknown: string[];
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = {}): SmokeArgs {
  const out: SmokeArgs = {
    keep: env.EXPLAINIT_SMOKE_KEEP === '1',
    version: env.VSCODE_TEST_VERSION && env.VSCODE_TEST_VERSION.trim() ? env.VSCODE_TEST_VERSION.trim() : 'stable',
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    help: false,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version') out.version = next() ?? out.version;
    else if (a.startsWith('--version=')) out.version = a.slice('--version='.length);
    else if (a === '--vsix') out.vsix = next();
    else if (a.startsWith('--vsix=')) out.vsix = a.slice('--vsix='.length);
    else if (a === '--timeout' || a.startsWith('--timeout=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : next();
      const secs = Number(v);
      if (Number.isFinite(secs) && secs > 0) out.timeoutMs = Math.round(secs * 1000);
      else out.unknown.push(`--timeout needs a number of seconds, got "${v ?? ''}"`);
    } else out.unknown.push(a);
  }
  return out;
}

export const USAGE = `ExplainIT fresh-install smoke test

  node out/test/install-smoke/run.js [--vsix <file>] [--version stable|insiders|1.100.0] [--timeout <seconds>] [--keep]

Downloads VS Code (cached in .vscode-test), installs the newest explainit-*.vsix from the repo root
into a throw-away profile, checks it is listed, then launches VS Code with a tiny probe extension
that drives ExplainIT end to end (activate, commands, open app.py, twin written by the fake
assistant, .git/info/exclude) and quits. Prints PASS or FAIL with the reasons.

Environment: VSCODE_TEST_VERSION, EXPLAINIT_SMOKE_KEEP=1 (keep temp dirs), CI (quieter download log).`;
