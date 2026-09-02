/**
 * Fresh-install smoke test (goal.md: "installs from its package into a fresh copy of VS Code").
 *
 *  1. Find the newest explainit-*.vsix in the repo root (fail clearly if none).
 *  2. Download VS Code with @vscode/test-electron (cached in .vscode-test).
 *  3. Install the VSIX into a brand-new user-data-dir + extensions-dir and check it is listed.
 *  4. Launch VS Code with test/install-smoke/probe as the development extension. The probe waits
 *     for the VSIX-installed ExplainIT, activates it, checks its commands, opens app.py in a
 *     git-initialised copy of the fixture workspace, triggers the twin (fake Claude CLI), checks the
 *     twin and .git/info/exclude, writes a JSON result and quits.
 *  5. Print PASS / FAIL with every check and reason. Exit 1 on failure.
 *
 * Every child process is spawned with an argument array and a timeout. Works on Windows paths.
 * Run: npm run test:install   (after npm run package). On Linux CI it runs under xvfb-run.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';
import {
  CLI_TIMEOUT_MS,
  EXTENSION_ID,
  Report,
  USAGE,
  buildUserSettings,
  cliInvocation,
  formatMs,
  hasExtension,
  installArgs,
  launchArgs,
  listArgs,
  noVsixMessage,
  parseArgs,
  parseListExtensions,
  parseProbeResult,
  pickNewestVsix,
  probeEnv,
  quoteForCmd,
  seedState,
  shouldCopyFixtureFile,
  hasTwinExcludeEntry,
  twinHeaderMatches,
  twinSectionStatus,
  withRetry,
} from './pure/smoke';

interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  shell?: boolean;
  /** Echo child output live (the VS Code launch), in addition to capturing it. */
  echo?: boolean;
}

const log = (msg: string): void => console.log(`[install-smoke] ${msg}`);

/** spawn with an argument array, a hard timeout and full output capture. Never throws on a non-zero exit. */
function run(command: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finalArgs = o.shell ? args.map(quoteForCmd) : args;
    const child = spawn(o.shell ? quoteForCmd(command) : command, finalArgs, {
      cwd: o.cwd,
      env: o.env ?? process.env,
      shell: o.shell === true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // Give the process a moment to die; resolve regardless so the runner never hangs.
      setTimeout(() => finish(null, 'SIGKILL'), 3000);
    }, o.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (o.echo) process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (o.echo) process.stderr.write(d);
    });
    child.on('error', (e) => {
      stderr += `\nspawn error: ${e.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** Kill a process and its children (VS Code spawns several). Argument arrays only. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

function copyWorkspace(src: string, dst: string): void {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => shouldCopyFixtureFile(path.relative(src, p) || '.'),
  });
}

async function gitInit(dir: string): Promise<string> {
  const r = await run('git', ['init', '-q'], { cwd: dir, timeoutMs: 30_000 });
  if (r.code === 0) return 'git init';
  // No git on this machine: a minimal .git layout is enough for the exclude check (ensureGitExclude looks for .git/).
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return `git was not available (${r.stderr.trim().split('\n')[0] || 'exit ' + r.code}); created a minimal .git folder instead`;
}

function removeDir(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 500 });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.unknown.length) {
    console.error(`Unknown argument(s): ${args.unknown.join(', ')}\n\n${USAGE}`);
    return 2;
  }

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const report = new Report();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-smoke-'));
  const userDataDir = path.join(tmpRoot, 'user-data');
  const extensionsDir = path.join(tmpRoot, 'extensions');
  const home = path.join(tmpRoot, 'explainit-home');
  const workspaceDir = path.join(tmpRoot, 'workspace');
  const resultFile = path.join(tmpRoot, 'probe-result.json');
  const probeDir = path.join(repoRoot, 'test', 'install-smoke', 'probe');
  const fakeCli = path.join(repoRoot, 'test', 'fixtures', 'fake-cli', 'claude.js');
  for (const d of [userDataDir, extensionsDir, home]) fs.mkdirSync(d, { recursive: true });
  log(`temp profile: ${tmpRoot}`);

  try {
    // 1. VSIX
    let vsix = args.vsix ? path.resolve(args.vsix) : undefined;
    if (!vsix) {
      // A broken symlink or an unreadable entry in the repo root must not stop the search.
      const candidates: { name: string; mtimeMs: number }[] = [];
      for (const name of fs.readdirSync(repoRoot)) {
        try {
          const st = fs.statSync(path.join(repoRoot, name));
          if (st.isFile()) candidates.push({ name, mtimeMs: st.mtimeMs });
        } catch {
          /* skip */
        }
      }
      const newest = pickNewestVsix(candidates);
      if (!newest) {
        report.check('VSIX package present', false, noVsixMessage(repoRoot));
        return finish(report);
      }
      vsix = path.join(repoRoot, newest.name);
    }
    if (!fs.existsSync(vsix)) {
      report.check('VSIX package present', false, `${vsix} does not exist. ${noVsixMessage(repoRoot)}`);
      return finish(report);
    }
    report.check('VSIX package present', true, `${path.basename(vsix)} (${(fs.statSync(vsix).size / 1024 / 1024).toFixed(1)} MB)`);
    if (!fs.existsSync(probeDir) || !fs.existsSync(path.join(probeDir, 'extension.js'))) {
      report.check('Probe extension present', false, `expected ${probeDir}/extension.js`);
      return finish(report);
    }
    if (!fs.existsSync(fakeCli)) {
      report.check('Fake assistant CLI present', false, `expected ${fakeCli}`);
      return finish(report);
    }

    // 2. VS Code
    const t0 = Date.now();
    const cachePath = path.join(repoRoot, '.vscode-test');
    let exe: string;
    try {
      // The download is the one step that talks to the outside: idle timeout 60 s, one jittered retry.
      exe = await withRetry('VS Code download', () => downloadAndUnzipVSCode({ version: args.version, cachePath, timeout: 60_000 }), { isOk: () => true, log });
    } catch (e) {
      report.check('VS Code downloaded', false, `${(e as Error).message}. Check your network, or set VSCODE_TEST_VERSION to a version already in .vscode-test.`);
      return finish(report);
    }
    report.check('VS Code downloaded', true, exe, Date.now() - t0);
    const cliPath = resolveCliPathFromVSCodeExecutablePath(exe);
    const cli = cliInvocation(cliPath, process.platform, (p) => fs.existsSync(p));
    const cliEnv: NodeJS.ProcessEnv = { ...process.env, ...cli.env };
    delete cliEnv.NODE_OPTIONS;

    // 3. Install + list
    const install = await withRetry(
      'VSIX install',
      () => run(cli.command, [...cli.argsPrefix, ...installArgs(vsix!, userDataDir, extensionsDir)], { env: cliEnv, timeoutMs: CLI_TIMEOUT_MS, shell: cli.shell }),
      { isOk: (r) => r.code === 0, log },
    );
    const installOk = report.check(
      'VSIX installs into a fresh profile (exit 0)',
      install.code === 0,
      install.code === 0 ? lastLine(install.stdout) : `exit ${install.code ?? install.signal}${install.timedOut ? ' (timed out)' : ''}: ${tail(install.stderr || install.stdout)}`,
      install.ms,
    );
    if (!installOk) return finish(report);

    const list = await run(cli.command, [...cli.argsPrefix, ...listArgs(userDataDir, extensionsDir)], { env: cliEnv, timeoutMs: CLI_TIMEOUT_MS, shell: cli.shell });
    const listed = parseListExtensions(list.stdout);
    const found = listed.find((e) => e.id === EXTENSION_ID.toLowerCase());
    const listOk = report.check(
      `--list-extensions shows ${EXTENSION_ID}`,
      list.code === 0 && hasExtension(listed, EXTENSION_ID),
      found ? `version ${found.version ?? '?'}` : `listed: [${listed.map((e) => e.id).join(', ') || 'nothing'}]${list.stderr ? ` stderr: ${tail(list.stderr)}` : ''}`,
      list.ms,
    );
    if (!listOk) return finish(report);

    // 4. Probe
    copyWorkspace(path.join(repoRoot, 'test', 'fixtures', 'workspace'), workspaceDir);
    report.note(await gitInit(workspaceDir));
    fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify(buildUserSettings(fakeCli), null, 2));
    fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify(seedState(new Date().toISOString()), null, 2));

    const env = probeEnv(process.env, { home, resultFile, workspaceDir, repoRoot });
    const launch = launchArgs({ probeDir, userDataDir, extensionsDir, workspaceDir, platform: process.platform });
    log(`launching VS Code (timeout ${formatMs(args.timeoutMs)})`);
    const vs = await run(exe, launch, { env, timeoutMs: args.timeoutMs, echo: process.env.EXPLAINIT_SMOKE_VERBOSE === '1' });
    const resultText = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : undefined;
    const probe = parseProbeResult(resultText);

    if (vs.timedOut) {
      const progress = probe.result ? `steps completed before the timeout: ${probe.result.steps.map((s) => `${s.ok ? 'ok' : 'FAIL'} ${s.name}`).join('; ') || 'none'}` : probe.problem ?? '';
      report.check('VS Code with the probe finishes within the time limit', false, `killed after ${formatMs(args.timeoutMs)}. ${progress}${vsOutputHint(vs)}`);
    } else {
      report.check('VS Code with the probe exits', true, `exit ${vs.code ?? vs.signal}`, vs.ms);
    }
    if (!probe.result) {
      report.check('Probe wrote its result', false, `${probe.problem}.${vsOutputHint(vs)} Re-run with EXPLAINIT_SMOKE_VERBOSE=1 to see VS Code's output, or --keep to inspect ${tmpRoot}.`);
      return finish(report);
    }
    for (const s of probe.result.steps) report.check(s.name, s.ok, s.detail, s.ms);
    if (probe.result.error && !probe.result.steps.some((s) => !s.ok)) report.check('Probe completed without errors', false, probe.result.error);
    report.check('Probe verdict', probe.result.ok, probe.result.ok ? `VS Code ${probe.result.vscodeVersion ?? '?'}, ExplainIT ${probe.result.extensionVersion ?? '?'}` : probe.result.error ?? 'one or more probe steps failed');

    // 5. Independent re-check from outside VS Code, after it quit: what is on disk is what the person keeps.
    const twinPath = path.join(workspaceDir, 'src', 'app_explain.txt');
    const twinText = readIfExists(twinPath);
    const status = twinSectionStatus(twinText, 1, 'load_config');
    report.check('On disk after quit: app_explain.txt names app.py in its header', twinHeaderMatches(twinText, 'app.py'), twinText ? twinText.split(/\r?\n/)[0] : `${twinPath} does not exist`);
    report.check('On disk after quit: "1. load_config" is fully explained (summary + 2..5 steps)', status.state === 'complete', status.detail);
    const excludePath = path.join(workspaceDir, '.git', 'info', 'exclude');
    const excludeText = readIfExists(excludePath);
    report.check('On disk after quit: .git/info/exclude lists *_explain.txt', hasTwinExcludeEntry(excludeText), excludeText === undefined ? `${excludePath} does not exist` : excludePath);
    return finish(report);
  } finally {
    if (args.keep || (!report.ok && process.env.EXPLAINIT_SMOKE_KEEP_ON_FAIL === '1')) {
      log(`keeping temp profile at ${tmpRoot}`);
    } else if (!removeDir(tmpRoot)) {
      log(`could not remove ${tmpRoot} (a VS Code process may still hold it); delete it by hand`);
    }
  }
}

function finish(report: Report): number {
  console.log('\n' + report.render() + '\n');
  return report.ok ? 0 : 1;
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function tail(text: string, lines = 8): string {
  const all = text.trim().split(/\r?\n/).filter(Boolean);
  return all.slice(-lines).join('\n');
}

function lastLine(text: string): string {
  return tail(text, 1);
}

function vsOutputHint(vs: RunResult): string {
  const err = tail(vs.stderr, 5);
  return err ? `\nVS Code stderr (last lines):\n${err}` : '';
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[install-smoke] FAIL: unexpected error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  },
);
