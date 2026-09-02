/**
 * Small child-process helper: argument arrays only, hard timeout, at most one jittered retry.
 */
import { spawn } from 'node:child_process';
import { jitter, sleep } from '../core/cancel';

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

export interface RunOptions {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Retry once (with jitter) after a timeout or a non-zero exit. Default false. */
  retry?: boolean;
  maxOutput?: number;
}

function runOnce(cmd: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const cap = o.maxOutput ?? 64 * 1024;
    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;
    const finish = (r: RunResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    // Windows .cmd/.bat shims (npm-installed CLIs) can only be started through the shell.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const command = needsShell && /\s/.test(cmd) ? `"${cmd}"` : cmd;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: needsShell });
    } catch (e) {
      finish({ ok: false, code: null, stdout, stderr, error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1500).unref();
      } catch { /* already gone */ }
    }, o.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < cap) stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < cap) stderr += d.toString('utf8'); });
    child.on('error', (e) => finish({ ok: false, code: null, stdout, stderr, error: e.message, timedOut }));
    child.on('close', (code) => finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut, error: timedOut ? `timed out after ${o.timeoutMs}ms` : undefined }));
  });
}

export async function runCommand(cmd: string, args: string[], o: RunOptions): Promise<RunResult> {
  const first = await runOnce(cmd, args, o);
  if (first.ok || !o.retry) return first;
  // ENOENT and similar spawn failures are final; timeouts and crashes get one more try.
  if (first.error && !first.timedOut && first.code === null) return first;
  await sleep(jitter(400));
  return runOnce(cmd, args, o);
}
