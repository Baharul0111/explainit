/**
 * Pure helpers for the fresh-install smoke test (test/install-smoke/run.ts).
 * No `vscode` import, no file system, no child processes: everything here is a plain function so it
 * can be unit-tested on any OS without downloading VS Code.
 */
import * as path from 'node:path';

export const EXTENSION_ID = 'BaharulIslam.explainit';
/** Commands the probe must find registered after ExplainIT activates. */
export const REQUIRED_COMMANDS = ['explainit.openTwin', 'explainit.doctor', 'explainit.pauseCheckpoint'];
/**
 * Every step the probe (probe/extension.js) must record, by exact name. run.ts fails the run when
 * one is missing from the result, so a probe that stops early (or a step that was quietly removed)
 * is a FAIL with the step named, never a shorter list of green ticks. The probe carries the same
 * strings as plain JS; smoke.test.ts checks the two lists stay in step.
 */
export const REQUIRED_STEPS = [
  'ExplainIT is installed from the VSIX',
  'ExplainIT activates and exports its API',
  'Commands openTwin, doctor and pauseCheckpoint are registered',
  'Checkpoint gate is listening on 127.0.0.1',
  'Opens src/app.py',
  'Twin app_explain.txt is written beside app.py with "1. load_config" explained by the assistant',
  'Twin is open in an editor beside the code',
  '.git/info/exclude contains *_explain.txt',
  'Claude Code hook installs through the installed extension (wrapper, hook script and settings.json in the temp user home)',
  'Installed hook: a Write that changes greet() is denied when the person rejects it, with the reason given, and app.py is unchanged',
  'Installed hook: the same Write is allowed when the person accepts it, and a restore point for app.py was saved first',
];
/** Default wall-clock budget for the probe run (VS Code launch -> quit); the two checkpoint round trips add about a minute. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5 * 60 * 1000;
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
    'explainit.assistant.claudeCliPath': `node ${quoteScriptPath(fakeClaudeCli)}`,
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
 * The resolver splits `node <script>` on the first space, so a script path that itself contains
 * whitespace (a repo under "My Projects", a Windows user name with a space) must be double-quoted:
 * `node "C:\\My Projects\\explainit\\test\\fixtures\\fake-cli\\claude.js"`. Paths without whitespace are left bare.
 */
export function quoteScriptPath(scriptPath: string): string {
  if (!/\s/.test(scriptPath)) return scriptPath;
  return `"${scriptPath.replace(/"/g, '')}"`;
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
  /**
   * Where the installed extension writes the assistants' user-layer config (~/.claude/settings.json):
   * a folder inside the temp profile, so the smoke test never touches the person's real Claude settings.
   */
  userHome: string;
}

/** Environment for the VS Code process that runs the probe. Never leaks Electron-as-Node into the UI. */
export function probeEnv(base: NodeJS.ProcessEnv, o: ProbeEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.EXPLAINIT_TEST_MODE = '1';
  env.EXPLAINIT_HOME = o.home;
  env.EXPLAINIT_USER_HOME = o.userHome;
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
// Twin content checks (mirror docs/dev/CONTRACTS.md "Twin file contract")
// ---------------------------------------------------------------------------------------------

export const TWIN_EXCLUDE_PATTERN = '*_explain.txt';
export const TWIN_WHAT_PREFIX = 'What it does: ';
export const TWIN_HOW_LINE = 'How it works:';

export type TwinSectionState = 'missing' | 'pending' | 'unavailable' | 'incomplete' | 'complete';

export interface TwinSectionStatus {
  state: TwinSectionState;
  /** Plain English: the summary line when complete, otherwise what is wrong and what to look at. */
  detail: string;
  summary?: string;
  steps: number;
}

/**
 * Is section `<index>. <name>` of a twin fully explained by an assistant? Complete means: a
 * "What it does:" sentence that is not the "(explaining...)" or "(not explained yet ...)" placeholder,
 * plus a "How it works:" list of 2..5 "- " lines. The probe (probe/extension.js) carries a plain-JS
 * copy of this function because it has no build step - keep the two in step.
 */
export function twinSectionStatus(text: string | undefined, index: number, name: string): TwinSectionStatus {
  if (text === undefined || text === '') return { state: 'missing', detail: 'the twin file does not exist yet', steps: 0 };
  const lines = text.split(/\r?\n/);
  const header = `${index}. ${name}`;
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return { state: 'missing', detail: `no "${header}" section (first lines: ${lines.slice(0, 3).join(' | ')})`, steps: 0 };
  const section: string[] = [];
  for (let i = start + 1; i < lines.length && lines[i].trim() !== '' && !/^\d+\. /.test(lines[i]); i++) section.push(lines[i]);
  const what = section.find((l) => l.startsWith(TWIN_WHAT_PREFIX));
  if (!what) return { state: 'incomplete', detail: `the "${header}" section has no "What it does:" line`, steps: 0 };
  const summary = what.slice(TWIN_WHAT_PREFIX.length).trim();
  if (summary.startsWith('(explaining')) return { state: 'pending', detail: 'the section still says "(explaining...)": the assistant has not answered yet', steps: 0 };
  if (summary.startsWith('(not explained yet')) return { state: 'unavailable', detail: 'the section says "(not explained yet ...)": no assistant was used', steps: 0 };
  const howAt = section.indexOf(TWIN_HOW_LINE);
  const steps = howAt < 0 ? 0 : section.slice(howAt + 1).filter((l) => l.startsWith('- ')).length;
  if (howAt < 0 || steps < 2) return { state: 'incomplete', detail: `the section has ${steps} "How it works" step(s); at least 2 expected`, summary, steps };
  if (steps > 5) return { state: 'incomplete', detail: `the section has ${steps} "How it works" steps; at most 5 expected`, summary, steps };
  if (!/[.!?]$/.test(summary)) return { state: 'incomplete', detail: `the summary is not a sentence: "${summary}"`, summary, steps };
  return { state: 'complete', detail: `${what} (${steps} steps)`, summary, steps };
}

/** The twin header names its source file: "ExplainIT — plain-English twin of app.py". */
export function twinHeaderMatches(text: string | undefined, sourceName: string): boolean {
  if (!text) return false;
  const first = text.split(/\r?\n/)[0] ?? '';
  return first.startsWith('ExplainIT ') && first.endsWith(` twin of ${sourceName}`);
}

/** True when a .git/info/exclude (or .gitignore) text has the `*_explain.txt` line. */
export function hasTwinExcludeEntry(text: string | undefined): boolean {
  if (!text) return false;
  return text.split(/\r?\n/).some((l) => l.trim() === TWIN_EXCLUDE_PATTERN);
}

// ---------------------------------------------------------------------------------------------
// Checkpoint round trip through the installed hook (mirrored as plain JS in probe/extension.js)
// ---------------------------------------------------------------------------------------------

/** The wrapper the installer writes for this platform, inside `<home>/hooks/`. */
export function installedWrapperPath(home: string, platform: NodeJS.Platform): string {
  return path.join(home, 'hooks', platform === 'win32' ? 'explainit-hook.cmd' : 'explainit-hook.sh');
}

export const HOOK_MARK = 'explainit-hook';

/**
 * The PreToolUse command ExplainIT wrote into `~/.claude/settings.json`: the entry whose command
 * names the hook and is not the PostToolUse variant. Running that exact text through the shell is
 * how Claude Code runs it, so the smoke test does the same instead of assembling its own command.
 */
export function hookCommandFromSettings(settingsText: string | undefined): { command?: string; problem?: string } {
  if (settingsText === undefined) return { problem: 'settings.json does not exist' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsText);
  } catch (e) {
    return { problem: `settings.json is not valid JSON: ${(e as Error).message}` };
  }
  const groups = (parsed as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return { problem: 'settings.json has no hooks.PreToolUse list' };
  for (const g of groups) {
    const hooks = (g as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      const command = (h as { command?: unknown } | null)?.command;
      if (typeof command === 'string' && command.includes(HOOK_MARK) && !/--event\s+PostToolUse/.test(command)) return { command };
    }
  }
  return { problem: `no PreToolUse entry whose command contains "${HOOK_MARK}"` };
}

export interface ShellInvocation {
  command: string;
  args: string[];
  /** Hand the command line to cmd.exe verbatim (spawn must not re-quote it). */
  windowsVerbatimArguments: boolean;
}

/**
 * How to run a hook command line the way the agents do: `sh -c` on POSIX, `cmd.exe /d /s /c` on
 * Windows. Only ever used with the command ExplainIT itself wrote into the settings file.
 */
export function shellInvocation(commandLine: string, platform: NodeJS.Platform, comSpec?: string): ShellInvocation {
  if (platform === 'win32') return { command: comSpec && comSpec.trim() ? comSpec : 'cmd.exe', args: ['/d', '/s', '/c', `"${commandLine}"`], windowsVerbatimArguments: true };
  return { command: 'sh', args: ['-c', commandLine], windowsVerbatimArguments: false };
}

/** The synthetic Claude Code PreToolUse payload for a Write, in the shape Claude Code sends on stdin. */
export function claudeWritePayload(o: { cwd: string; filePath: string; content: string; sessionId: string; toolUseId: string }): Record<string, unknown> {
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

export const GREET_BEFORE = 'message = "Hello, " + name';
export const GREET_AFTER = 'message = "Hi there, " + name';

/** app.py with one line inside greet() changed (one function hunk, one review card); undefined when the line is not there. */
export function changeGreet(appPy: string | undefined): string | undefined {
  if (!appPy || !appPy.includes(GREET_BEFORE)) return undefined;
  return appPy.replace(GREET_BEFORE, GREET_AFTER);
}

export interface HookOutput {
  decision?: 'allow' | 'deny' | 'ask';
  reason?: string;
  problem?: string;
}

/** The hook's stdout -> its decision. Empty stdout means "no opinion" (the agent's own flow), which is a problem here. */
export function parseHookStdout(stdout: string | undefined): HookOutput {
  const text = (stdout ?? '').trim();
  if (!text) return { problem: 'the hook printed nothing, so the assistant would have used its own permission prompt (no ExplainIT decision)' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { problem: `the hook printed something that is not JSON (${(e as Error).message}): ${text.slice(0, 200)}` };
  }
  const out = (parsed as { hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown } } | null)?.hookSpecificOutput;
  const decision = out?.permissionDecision;
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') return { problem: `the hook printed no permissionDecision: ${text.slice(0, 200)}` };
  return { decision, reason: typeof out?.permissionDecisionReason === 'string' ? out.permissionDecisionReason : undefined };
}

/** Restore points recorded for `fileName` in a checkpoints/index.json text (any workspace key). */
export function checkpointsFor(indexText: string | undefined, fileName: string): { id: string; path: string; ts?: string }[] {
  if (!indexText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(indexText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((c): c is { id: string; path: string; ts?: string } => !!c && typeof c === 'object' && typeof (c as { path?: unknown }).path === 'string' && path.basename((c as { path: string }).path) === fileName);
}

/** Names from REQUIRED_STEPS that the probe never recorded (a step that failed is present, so it is not "missing"). */
export function missingRequiredSteps(result: ProbeResult | undefined, required: readonly string[] = REQUIRED_STEPS): string[] {
  const seen = new Set((result?.steps ?? []).map((s) => s.name));
  return required.filter((name) => !seen.has(name));
}

// ---------------------------------------------------------------------------------------------
// One jittered retry (CONTRACTS: every external call has a timeout and at most one jittered retry)
// ---------------------------------------------------------------------------------------------

export interface RetryOptions<T> {
  /** True when the attempt's result is good enough to stop. A thrown attempt is never ok. */
  isOk: (value: T) => boolean;
  /** Base wait before the retry; the actual wait is jittered to 50%..150% of it. */
  baseWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (message: string) => void;
}

export function jitterMs(base: number, random: () => number = Math.random): number {
  return Math.round(base * (0.5 + random()));
}

/**
 * Run `fn` once; if it throws or its result is not ok, wait a jittered moment and run it exactly once
 * more. The second attempt's outcome (result or error) is returned as is: never more than two tries.
 */
export async function withRetry<T>(what: string, fn: () => Promise<T>, o: RetryOptions<T>): Promise<T> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let reason: string;
  try {
    const first = await fn();
    if (o.isOk(first)) return first;
    reason = 'did not succeed';
  } catch (e) {
    reason = (e as Error).message || String(e);
  }
  const wait = jitterMs(o.baseWaitMs ?? 2000, o.random);
  o.log?.(`${what} failed (${reason}); retrying once in ${formatMs(wait)}`);
  await sleep(wait);
  return fn();
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

/** What the probe saw when it ran the installed hook once (raw, so run.ts can judge it again after VS Code quit). */
export interface HookRunRecord {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}

export interface ProbeResult {
  ok: boolean;
  startedAt?: string;
  finishedAt?: string;
  vscodeVersion?: string;
  extensionVersion?: string;
  error?: string;
  steps: ProbeStep[];
  /** The installed hook command and the two round trips (reject, then accept). */
  hook?: { command?: string; wrapper?: string; reject?: HookRunRecord; accept?: HookRunRecord };
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
assistant, .git/info/exclude, then installs the Claude Code hook and runs it against the checkpoint:
one Write rejected, one accepted with a restore point) and quits. Prints PASS or FAIL with the reasons.

Environment: VSCODE_TEST_VERSION, EXPLAINIT_SMOKE_KEEP=1 (keep temp dirs), CI (quieter download log).`;
