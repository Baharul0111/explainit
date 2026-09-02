/**
 * Shared CLI plumbing for the claude and codex channels (REQ-007, REQ-022).
 *
 *  resolveCli(kind, settingValue)  setting value -> PATH lookup -> binary bundled in the VS Code
 *                                  extension (anthropic.claude-code / openai.chatgpt), on any OS.
 *  runCli(spec, args, opts)        spawn with an argument array only, stdin for the prompt (so agent
 *                                  text never hits a shell and Windows' 32K argv limit is irrelevant),
 *                                  hard timeout that kills the child, one jittered retry on spawn
 *                                  error or timeout only.
 *
 * `vscode` is required lazily inside a try/catch: outside VS Code (unit tests, eval harness) the
 * extension directories are scanned on disk instead.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CancelToken } from '../../core/interfaces';
import { jitter, sleep } from '../../core/cancel';
import { ChannelError, isCancelled } from './types';

export type CliKind = 'claude' | 'codex';
export type CliSource = 'setting' | 'path' | 'extension' | 'none';

export interface CliSpec {
  kind: CliKind;
  /** Executable to spawn. Empty when source is 'none'. */
  path: string;
  /** Arguments that always come first (e.g. the script path when running `node script.js`). */
  argsPrefix: string[];
  source: CliSource;
  /** Plain English: where it was found, or why nothing was found. */
  detail: string;
  /** Extra environment (e.g. ELECTRON_RUN_AS_NODE=1 when VS Code's own executable runs a script). */
  env?: Record<string, string>;
  /** Windows-only: a .cmd/.bat shim that has to go through cmd.exe. Only fixed args are ever passed then. */
  shell?: boolean;
}

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Extension roots to scan instead of the defaults (tests). */
  extensionRoots?: string[];
  /** Installed extensions (from vscode.extensions.all) — overrides the directory scan. */
  vscodeExtensions?: { id: string; extensionPath: string }[];
  /** Skip the lazy `require('vscode')` (tests). */
  noVscode?: boolean;
  execPath?: string;
}

export const DEFAULT_SETTING: Record<CliKind, string> = { claude: 'claude', codex: 'codex' };

const EXTENSION_ID_PREFIX: Record<CliKind, string> = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' };

// ---------------------------------------------------------------------------------------------
// PATH lookup (which / where)
// ---------------------------------------------------------------------------------------------

function isExecutableFile(p: string, platform: NodeJS.Platform): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Equivalent of `which` / `where`: PATH split on the platform delimiter, PATHEXT on Windows. */
export function findOnPath(name: string, opts: ResolveOptions = {}): string | undefined {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = pathVar.split(delimiter).filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const candidates = (base: string): string[] => {
    if (platform !== 'win32') return [base];
    const out = [base];
    for (const e of exts) out.push(base + e.toLowerCase(), base + e);
    return out;
  };
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) {
    const abs = path.resolve(name);
    return candidates(abs).find((c) => isExecutableFile(c, platform));
  }
  for (const d of dirs) {
    const found = candidates(path.join(d, name)).find((c) => isExecutableFile(c, platform));
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Bundled extension binaries
// ---------------------------------------------------------------------------------------------

function defaultExtensionRoots(homeDir: string): string[] {
  return [
    path.join(homeDir, '.vscode', 'extensions'),
    path.join(homeDir, '.vscode-insiders', 'extensions'),
    path.join(homeDir, '.cursor', 'extensions'),
    path.join(homeDir, '.vscode-server', 'extensions'),
    path.join(homeDir, '.vscode-server-insiders', 'extensions'),
    path.join(homeDir, '.vscode-oss', 'extensions'),
  ];
}

function versionKey(dirName: string, prefix: string): number[] {
  const rest = dirName.slice(prefix.length).replace(/^-/, '');
  return rest.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
}

function compareVersionsDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function tryVscodeExtensions(): { id: string; extensionPath: string }[] | undefined {
  try {
    // Lazy and guarded: absent in plain Node (unit tests, eval harness).
    const vscode = require('vscode') as typeof import('vscode');
    if (!vscode?.extensions?.all) return undefined;
    return vscode.extensions.all.map((e) => ({ id: e.id, extensionPath: e.extensionPath }));
  } catch {
    return undefined;
  }
}

/** Directories of installed extensions whose id starts with the prefix, newest version first. */
function candidateExtensionDirs(kind: CliKind, opts: ResolveOptions): string[] {
  const prefix = EXTENSION_ID_PREFIX[kind];
  const fromApi = opts.vscodeExtensions ?? (opts.noVscode ? undefined : tryVscodeExtensions());
  const dirs: { dir: string; key: number[] }[] = [];
  if (fromApi) {
    for (const e of fromApi) {
      if (e.id.toLowerCase().startsWith(prefix)) dirs.push({ dir: e.extensionPath, key: versionKey(path.basename(e.extensionPath), prefix) });
    }
  }
  const roots = opts.extensionRoots ?? defaultExtensionRoots(opts.homeDir ?? os.homedir());
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.toLowerCase().startsWith(prefix + '-')) dirs.push({ dir: path.join(root, name), key: versionKey(name, prefix) });
    }
  }
  const seen = new Set<string>();
  return dirs
    .sort((a, b) => compareVersionsDesc(a.key, b.key))
    .map((d) => d.dir)
    .filter((d) => (seen.has(d) ? false : (seen.add(d), true)));
}

/** Platform folder names used by the Codex extension: macos-aarch64, linux-x86_64, windows-x86_64, ... */
export function platformDirMatches(name: string, platform: NodeJS.Platform, arch: string): boolean {
  const n = name.toLowerCase();
  const platOk =
    platform === 'darwin' ? /macos|darwin|osx/.test(n) : platform === 'win32' ? /windows|win32|win/.test(n) : platform === 'linux' ? /linux/.test(n) : n.includes(platform);
  const archOk = arch === 'arm64' ? /aarch64|arm64/.test(n) : arch === 'x64' ? /x86_64|x64|amd64/.test(n) : n.includes(arch);
  return platOk && archOk;
}

export function findExtensionBinary(kind: CliKind, opts: ResolveOptions = {}): { path: string; extensionDir: string } | undefined {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const exe = platform === 'win32' ? '.exe' : '';
  for (const dir of candidateExtensionDirs(kind, opts)) {
    if (kind === 'claude') {
      const p = path.join(dir, 'resources', 'native-binary', 'claude' + exe);
      if (isExecutableFile(p, platform)) return { path: p, extensionDir: dir };
      continue;
    }
    const bin = path.join(dir, 'bin');
    let subs: string[] = [];
    try {
      subs = fs.readdirSync(bin);
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (!platformDirMatches(sub, platform, arch)) continue;
      const p = path.join(bin, sub, 'codex' + exe);
      if (isExecutableFile(p, platform)) return { path: p, extensionDir: dir };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Setting values: "/abs/claude", "claude-dev", "node /abs/fake/claude.js"
// ---------------------------------------------------------------------------------------------

function resolveNode(opts: ResolveOptions): { path: string; env?: Record<string, string> } | undefined {
  const onPath = findOnPath('node', opts);
  if (onPath) return { path: onPath };
  // Inside VS Code there may be no `node` on PATH; the Electron binary runs as Node with this flag.
  const execPath = opts.execPath ?? process.execPath;
  if (execPath && fs.existsSync(execPath)) return { path: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  return undefined;
}

/** Split "node <path>.js" style values on the first space (only when the value ends with .js). */
export function parseSettingValue(value: string): { runtime?: string; target: string } {
  const v = value.trim();
  const unquote = (s: string): string => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  // `node /abs/claude.js` or `node "/path with spaces/claude.js"`: split on the first space only.
  if (/\.js["']?$/i.test(v) && v.includes(' ') && !/^["']/.test(v)) {
    const i = v.indexOf(' ');
    return { runtime: v.slice(0, i).trim(), target: unquote(v.slice(i + 1)) };
  }
  return { target: unquote(v) };
}

function fromSetting(kind: CliKind, value: string, opts: ResolveOptions): { spec?: CliSpec; problem?: string } {
  const { runtime, target } = parseSettingValue(value);
  const platform = opts.platform ?? process.platform;
  if (runtime) {
    if (!fs.existsSync(target)) return { problem: `the script "${target}" does not exist` };
    const isNode = runtime.toLowerCase() === 'node' || runtime.toLowerCase() === 'node.exe';
    let rt: { path: string; env?: Record<string, string> } | undefined;
    if (isNode) rt = resolveNode(opts);
    else {
      const p = findOnPath(runtime, opts);
      rt = p ? { path: p } : undefined;
    }
    if (!rt) return { problem: `the runtime "${runtime}" was not found` };
    return { spec: { kind, path: rt.path, argsPrefix: [path.resolve(target)], source: 'setting', detail: `${runtime} ${target} (from the setting)`, env: rt.env } };
  }
  const found = findOnPath(target, opts);
  if (!found) return { problem: `"${target}" was not found` };
  return { spec: withWindowsShim({ kind, path: found, argsPrefix: [], source: 'setting', detail: `${found} (from the setting)` }, platform, opts) };
}

/**
 * Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980). npm shims point at a .js file we
 * can run with node directly; otherwise fall back to cmd.exe with our fixed flags only (the prompt
 * always travels over stdin, never through the shell).
 */
export function withWindowsShim(spec: CliSpec, platform: NodeJS.Platform, opts: ResolveOptions): CliSpec {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(spec.path)) return spec;
  try {
    const text = fs.readFileSync(spec.path, 'utf8');
    const m = /"%(?:~)?dp0%?\\([^"]+\.js)"/i.exec(text) ?? /%(?:~)?dp0%?\\(\S+\.js)/i.exec(text);
    if (m) {
      const script = path.join(path.dirname(spec.path), ...m[1].split(/[\\/]+/));
      const node = resolveNode(opts);
      if (node && fs.existsSync(script)) {
        return { ...spec, path: node.path, argsPrefix: [script, ...spec.argsPrefix], env: { ...(spec.env ?? {}), ...(node.env ?? {}) }, detail: `${spec.detail} via node ${script}` };
      }
    }
  } catch {
    /* fall through to the shell */
  }
  return { ...spec, shell: true };
}

// ---------------------------------------------------------------------------------------------
// resolveCli
// ---------------------------------------------------------------------------------------------

export function resolveCli(kind: CliKind, settingValue: string | undefined, opts: ResolveOptions = {}): CliSpec {
  const platform = opts.platform ?? process.platform;
  const notes: string[] = [];
  const value = (settingValue ?? '').trim();
  if (value && value !== DEFAULT_SETTING[kind]) {
    const r = fromSetting(kind, value, opts);
    if (r.spec) return r.spec;
    notes.push(`The setting assistant.${kind}CliPath is "${value}" but ${r.problem}.`);
  }
  const onPath = findOnPath(DEFAULT_SETTING[kind], opts);
  if (onPath) return withWindowsShim({ kind, path: onPath, argsPrefix: [], source: 'path', detail: `${onPath} (found on PATH)${notes.length ? ' — ' + notes.join(' ') : ''}` }, platform, opts);
  const ext = findExtensionBinary(kind, opts);
  if (ext) return { kind, path: ext.path, argsPrefix: [], source: 'extension', detail: `${ext.path} (bundled in the ${path.basename(ext.extensionDir)} extension)${notes.length ? ' — ' + notes.join(' ') : ''}` };
  const what = kind === 'claude' ? 'Claude Code' : 'Codex';
  const extName = kind === 'claude' ? 'Claude Code' : 'ChatGPT / Codex';
  notes.push(`${what} was not found on PATH and the ${extName} VS Code extension is not installed. Install the CLI or the extension, or set assistant.${kind}CliPath to its location.`);
  return { kind, path: '', argsPrefix: [], source: 'none', detail: notes.join(' ') };
}

// ---------------------------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------------------------

export interface RunCliOptions {
  stdin?: string;
  timeoutMs: number;
  token?: CancelToken;
  onStdout?: (chunk: string) => void;
  cwd?: string;
  env?: Record<string, string>;
  /** One jittered retry on spawn error / timeout (default true). */
  retry?: boolean;
  /** Base delay before the retry (default 400 ms, jittered). */
  retryDelayMs?: number;
}

export interface RunCliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  attempts: number;
}

const STDERR_CAP = 64 * 1024;
const STDOUT_CAP = 32 * 1024 * 1024;

function killTree(child: ChildProcess, spec: CliSpec): void {
  try {
    if (process.platform === 'win32') {
      if (spec.shell && child.pid) {
        // cmd.exe shims: kill the whole tree, otherwise the real process keeps running.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
      }
      child.kill();
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

function attemptOnce(spec: CliSpec, args: string[], opts: RunCliOptions, attempt: number): Promise<RunCliResult> {
  return new Promise<RunCliResult>((resolve, reject) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let fullArgs = [...spec.argsPrefix, ...args];
    if (spec.shell) {
      if (fullArgs.some((a) => /[&|<>^%!"\r\n]/.test(a))) {
        reject(new ChannelError(spec.kind, 'failed', 'Refusing to pass unusual characters through the Windows command shell.'));
        return;
      }
      // cmd.exe joins args with spaces: an empty value (`--tools ""`) must be quoted or it vanishes.
      fullArgs = fullArgs.map((a) => (a === '' ? '""' : /\s/.test(a) ? `"${a}"` : a));
    }
    // cmd.exe splits the command line on spaces: a shim under "C:\Users\Jane Doe\..." must be quoted.
    const command = spec.shell && /\s/.test(spec.path) && !/^".*"$/.test(spec.path) ? `"${spec.path}"` : spec.path;
    let child: ChildProcess;
    try {
      child = spawn(command, fullArgs, {
        cwd: opts.cwd,
        env: { ...process.env, ...(spec.env ?? {}), ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: spec.shell === true,
      });
    } catch (e) {
      reject(new ChannelError(spec.kind, 'failed', `Could not start ${spec.path}: ${(e as Error).message}`, true));
      return;
    }
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelSub?.dispose();
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, spec);
      // 'close' may never come for a stuck grandchild holding the pipes; settle now.
      finish(() => reject(new ChannelError(spec.kind, 'timeout', `${spec.kind} did not answer within ${Math.round(opts.timeoutMs / 1000)} seconds and was stopped.`, true)));
    }, opts.timeoutMs);
    const cancelSub = opts.token?.onCancellationRequested(() => {
      cancelled = true;
      killTree(child, spec);
      finish(() => reject(new ChannelError(spec.kind, 'cancelled', 'Cancelled.')));
    });
    if (isCancelled(opts.token)) {
      cancelled = true;
      killTree(child, spec);
      finish(() => reject(new ChannelError(spec.kind, 'cancelled', 'Cancelled.')));
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < STDOUT_CAP) stdout += d;
      try {
        opts.onStdout?.(d);
      } catch {
        /* progress callbacks must never break the run */
      }
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < STDERR_CAP) stderr += d;
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      const msg = e.code === 'ENOENT' ? `${spec.path} was not found.` : `Could not run ${spec.path}: ${e.message}`;
      finish(() => reject(new ChannelError(spec.kind, e.code === 'ENOENT' ? 'unavailable' : 'failed', msg, true)));
    });
    child.on('close', (code, signal) => {
      if (timedOut || cancelled) return;
      finish(() => resolve({ code, signal, stdout, stderr, durationMs: Date.now() - started, attempts: attempt }));
    });
    if (child.stdin) {
      child.stdin.on('error', () => undefined); // EPIPE when the child exits early: the close handler reports it
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin, 'utf8');
      else child.stdin.end();
    }
  });
}

/**
 * Run a resolved CLI. Resolves with the exit code and captured output (a non-zero exit with output
 * is the caller's business — never retried). Rejects with ChannelError on spawn error, timeout or
 * cancel; spawn error and timeout are retried exactly once after a jittered delay.
 */
export async function runCli(spec: CliSpec, args: string[], opts: RunCliOptions): Promise<RunCliResult> {
  if (!spec.path || spec.source === 'none') throw new ChannelError(spec.kind, 'unavailable', spec.detail);
  const maxAttempts = opts.retry === false ? 1 : 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptOnce(spec, args, opts, attempt);
    } catch (e) {
      lastErr = e;
      const retryable = isChannelErrorRetryable(e) && !isCancelled(opts.token);
      if (!retryable || attempt === maxAttempts) break;
      await sleep(jitter(opts.retryDelayMs ?? 400));
    }
  }
  throw lastErr;
}

function isChannelErrorRetryable(e: unknown): boolean {
  return e instanceof ChannelError && e.retryable && e.reason !== 'cancelled';
}

/** Working directory for the CLIs: outside every repo so project CLAUDE.md / hooks / MCP never load. */
export function cliWorkDir(homeDir: string): string {
  const dir = path.join(homeDir, 'tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort; spawn will report if it is unusable */
  }
  return dir;
}

// ---------------------------------------------------------------------------------------------
// Sign-in: where Codex keeps its sign-in file, and the plain-English "not signed in" messages
// ---------------------------------------------------------------------------------------------

/** What the person sees (and what the router logs) when a CLI is installed but not signed in. */
export const SIGN_IN_MESSAGE: Record<CliKind, string> = {
  claude: 'Claude Code is not signed in on this computer. Run "claude" in a terminal and sign in, then try again.',
  codex: 'Codex is not signed in on this computer. Run "codex login" in a terminal, then try again.',
};

/**
 * Codex keeps its sign-in file (auth.json), hooks.json and config.toml under CODEX_HOME when that
 * is set (Codex honours it), else under ~/.codex — the same rule as src/adapters/codex.ts.
 */
export function codexHomeDir(opts: Pick<ResolveOptions, 'env' | 'homeDir'> = {}): string {
  const env = opts.env ?? process.env;
  const raw = env.CODEX_HOME;
  if (raw && raw.trim()) return path.resolve(raw.trim());
  return path.join(opts.homeDir ?? os.homedir(), '.codex');
}

/** The Codex sign-in file written by `codex login` (also by `codex login --with-api-key`). */
export function codexAuthFile(opts: Pick<ResolveOptions, 'env' | 'homeDir'> = {}): string {
  return path.join(codexHomeDir(opts), 'auth.json');
}

export interface CodexSignIn {
  signedIn: boolean;
  authFile: string;
  /** Plain English: what was found (for logs and the availability detail). */
  detail: string;
}

/** Best-effort sign-in check without running codex: the auth.json file, or an API key in the environment. */
export function codexSignIn(opts: Pick<ResolveOptions, 'env' | 'homeDir'> = {}): CodexSignIn {
  const env = opts.env ?? process.env;
  const authFile = codexAuthFile(opts);
  let present = false;
  try {
    present = fs.statSync(authFile).isFile();
  } catch {
    present = false;
  }
  if (present) return { signedIn: true, authFile, detail: `sign-in file found at ${authFile}` };
  const key = ['OPENAI_API_KEY', 'CODEX_API_KEY'].find((k) => (env[k] ?? '').trim());
  if (key) return { signedIn: true, authFile, detail: `API key from ${key} (no sign-in file at ${authFile})` };
  return { signedIn: false, authFile, detail: `no sign-in file at ${authFile}` };
}

/** `<cli> --version` within 10 s. */
export async function probeVersion(spec: CliSpec, timeoutMs = 10_000): Promise<{ ok: boolean; version?: string; detail: string }> {
  try {
    const r = await runCli(spec, ['--version'], { timeoutMs, retry: false });
    const text = (r.stdout + ' ' + r.stderr).trim();
    const m = /(\d+\.\d+(?:\.\d+)?[\w.-]*)/.exec(text);
    if (r.code === 0) return { ok: true, version: m?.[1], detail: m ? `version ${m[1]}` : text.slice(0, 120) };
    return { ok: false, detail: `"--version" exited with code ${r.code}: ${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
