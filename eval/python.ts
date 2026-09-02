/**
 * Runs a HumanEval test program in a Python subprocess: fresh temp dir, isolated interpreter flags
 * (-I ignores the user's site-packages and environment, -B writes no bytecode), a minimal
 * environment, a hard timeout that kills the process, and an in-program socket block. Argument
 * arrays only — nothing from a model ever reaches a shell.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PythonRunResult {
  passed: boolean;
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface PythonSpec {
  path: string;
  version: string;
}

const CANDIDATES = process.platform === 'win32' ? ['python3', 'python', 'py'] : ['python3', 'python'];
const OUTPUT_CAP = 64 * 1024;

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONHASHSEED: '0',
    LANG: process.env.LANG ?? 'C.UTF-8',
  };
  // Windows needs these to start any process; harmless elsewhere.
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'PATHEXT', 'ComSpec']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

function runOnce(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; stdin?: string }): Promise<PythonRunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: minimalEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ passed: false, code: null, timedOut: false, stdout: '', stderr: `Could not start ${cmd}: ${(e as Error).message}`, durationMs: 0 });
      return;
    }
    const finish = (r: Omit<PythonRunResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
      } catch {
        /* gone */
      }
      finish({ passed: false, code: null, timedOut: true, stdout, stderr: stderr + `\n(stopped after ${Math.round(opts.timeoutMs / 1000)} s)` });
    }, opts.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < OUTPUT_CAP) stdout += d;
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < OUTPUT_CAP) stderr += d;
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish({ passed: false, code: null, timedOut: false, stdout, stderr: e.code === 'ENOENT' ? `${cmd} was not found.` : `Could not run ${cmd}: ${e.message}` });
    });
    child.on('close', (code) => {
      if (timedOut) return;
      finish({ passed: code === 0, code, timedOut: false, stdout, stderr });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.stdin ?? '');
  });
}

let cachedSpec: PythonSpec | undefined | null;

/** Find a Python 3 interpreter (python3, python, py -3). Cached per process. */
export async function findPython(): Promise<PythonSpec | undefined> {
  if (cachedSpec !== undefined) return cachedSpec ?? undefined;
  for (const cmd of CANDIDATES) {
    const args = cmd === 'py' ? ['-3', '--version'] : ['--version'];
    const r = await runOnce(cmd, args, { timeoutMs: 10_000 });
    const text = (r.stdout + ' ' + r.stderr).trim();
    const m = /Python (3\.\d+(?:\.\d+)?)/.exec(text);
    if (r.code === 0 && m) {
      cachedSpec = { path: cmd, version: m[1] };
      return cachedSpec;
    }
  }
  cachedSpec = null;
  return undefined;
}

export function pythonMissingMessage(): string {
  return 'Python 3 was not found (tried python3, python). Install Python 3 and make sure it is on your PATH, then run the eval again.';
}

/**
 * Write the program to a fresh temp dir and run it. `passed` is true only when the process exited 0
 * within the timeout (default 10 s). The temp dir is removed afterwards.
 */
export async function runPythonProgram(program: string, opts: { timeoutMs?: number; python?: PythonSpec } = {}): Promise<PythonRunResult> {
  const py = opts.python ?? (await findPython());
  if (!py) return { passed: false, code: null, timedOut: false, stdout: '', stderr: pythonMissingMessage(), durationMs: 0 };
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'explainit-eval-py-'));
  const file = path.join(dir, 'program.py');
  try {
    await fs.promises.writeFile(file, program, 'utf8');
    const args = py.path === 'py' ? ['-3', '-I', '-B', file] : ['-I', '-B', file];
    return await runOnce(py.path, args, { cwd: dir, timeoutMs: opts.timeoutMs ?? 10_000 });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Last lines of stderr, trimmed, for the results file and the table notes. */
export function stderrTail(text: string, maxChars = 400): string {
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (t.length <= maxChars) return t;
  return '…' + t.slice(-maxChars);
}
