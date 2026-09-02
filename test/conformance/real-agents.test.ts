/**
 * Real-agent conformance (REQ-016, REQ-017, REQ-022). Gated: runs only when
 * EXPLAINIT_REAL_AGENTS=1, because it drives the REAL `claude` and `codex` on this machine (both
 * must be signed in) and spends assistant credits.
 *
 * What it proves, against a stub gate on 127.0.0.1, a temp ExplainIT home and a temp USER home:
 *   - the shipped installer (ClaudeAdapter / CodexAdapter, the same code "ExplainIT: Connect" runs)
 *     writes user-layer files (<user home>/.claude/settings.json, <user home>/.codex/hooks.json) whose
 *     pinned commands arm the real binaries: the hook runs, contacts the gate and honours its answer,
 *   - a deny(reason) from the gate leaves hello.py unchanged and the gate saw PreToolUse + tool_input,
 *   - an allow lets the same edit land,
 * for the claude CLI, the codex CLI, AND the binaries bundled inside the Claude Code / Codex VS Code
 * extensions (~/.vscode/extensions/anthropic.claude-code-*\/resources/native-binary/claude and
 * ~/.vscode/extensions/openai.chatgpt-*\/bin/<platform>/codex), i.e. the editor path is gated by the
 * very same hooks. For Codex it additionally proves (no credits, no sign-in needed) that the trust hash
 * ExplainIT's Doctor computes is the one the real engine reports through `hooks/list`, and that a
 * `[hooks.state]` record written in ExplainIT's format makes the engine report the hook as trusted.
 *
 * The child processes get HOME / USERPROFILE / CODEX_HOME pointed at the temp user home, so the
 * person's own ~/.claude and ~/.codex are never read or written. Claude Code keeps its macOS keychain
 * sign-in, so it still authenticates. Codex keeps its sign-in in <CODEX_HOME>/auth.json, so the
 * person's auth.json is linked (never copied or printed) into the temp CODEX_HOME.
 *
 * Commands (macOS, run from the repo root):
 *   npx tsc -p ./ --outDir out-adapters
 *   EXPLAINIT_REAL_AGENTS=1 npx mocha --ui tdd "out-adapters/test/conformance/real-agents.test.js" --timeout 600000
 * The exact agent invocations are:
 *   claude -p "<prompt>" --output-format json --allowedTools Edit,Write,Read --max-turns 6 --no-session-persistence
 *     (hooks come from the installer-written <temp HOME>/.claude/settings.json)
 *   codex exec --skip-git-repo-check --ephemeral --sandbox workspace-write -C <tmp> -o <tmp>/last.txt "<prompt>"
 *     with CODEX_HOME=<temp HOME>/.codex holding the installer-written hooks.json plus a trust record
 *     in config.toml. When `hooks/list` confirms that record is honoured, that is all Codex needs. If
 *     it is not (an older Codex), the hook is injected as `-c hooks.PreToolUse=[...]` session flags
 *     together with `--dangerously-bypass-hook-trust` instead, as a fallback.
 *   codex app-server  (JSON-RPC over stdio: initialize -> initialized -> hooks/list) with CODEX_HOME=<tmp>
 */
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeAdapter } from '../../src/adapters/claude';
import { CodexAdapter } from '../../src/adapters/codex';
import { makeAdapterEnv, type AdapterEnv, type HostProbe } from '../../src/adapters/installer';
import { codexBundledBinary, pickExtensionDir } from '../../src/adapters/pure/extensionDirs';
import { codexEntrySpecs, findOurEntries, type FoundEntry } from '../../src/adapters/pure/hookConfig';
import { codexHookHash, codexHookKey, codexHookStateHeader, lookupTrust, parseHookStates } from '../../src/adapters/pure/codexTrust';
import { findOnPath } from '../../src/adapters/pure/pathLookup';
import { shQuote } from '../../src/adapters/pure/wrappers';
import { createLogger } from '../../src/core/log';
import { inMemorySettings } from '../../src/core/settings';
import { createStateStore } from '../../src/core/state';
import { decideWith, longPollThen, startStub, writeSession, type StubGate } from './stubGate';

const ENABLED = process.env.EXPLAINIT_REAL_AGENTS === '1';
const REPO = path.resolve(__dirname, '..', '..', '..');
const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

interface Agent {
  kind: 'claude' | 'codex';
  label: string;
  binary: string | undefined;
}

function findAgents(): Agent[] {
  const lookup = { pathEnv: process.env.PATH, pathExt: process.env.PATHEXT, platform: process.platform, isFile };
  const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(extRoot);
  } catch {
    /* no extensions */
  }
  const claudeExt = pickExtensionDir(extRoot, entries, 'anthropic.claude-code');
  const codexExt = pickExtensionDir(extRoot, entries, 'openai.chatgpt');
  const claudeBundled = claudeExt ? path.join(claudeExt.path, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude') : undefined;
  let codexBundled: string | undefined;
  if (codexExt) {
    try {
      codexBundled = codexBundledBinary(codexExt.path, fs.readdirSync(path.join(codexExt.path, 'bin')), process.platform, process.arch);
    } catch {
      codexBundled = undefined;
    }
  }
  return [
    { kind: 'claude', label: 'claude CLI on PATH', binary: findOnPath('claude', lookup) },
    { kind: 'claude', label: 'claude bundled in the Claude Code VS Code extension', binary: claudeBundled && isFile(claudeBundled) ? claudeBundled : undefined },
    { kind: 'codex', label: 'codex CLI on PATH', binary: findOnPath('codex', lookup) },
    { kind: 'codex', label: 'codex bundled in the Codex VS Code extension', binary: codexBundled && isFile(codexBundled) ? codexBundled : undefined },
  ];
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

/** One `hooks/list` call against `codex app-server` (JSON-RPC over stdio). Needs no sign-in and spends nothing. */
function codexHooksList(bin: string, codexHome: string, cwd: string, extraArgs: string[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server', ...extraArgs], { env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let done = false;
    const finish = (err?: Error, hooks?: any[]): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (err) reject(err);
      else resolve(hooks ?? []);
    };
    const timer = setTimeout(() => finish(new Error(`codex app-server did not answer hooks/list within 60 s. stderr: ${stderr.slice(-500)}`)), 60000);
    const send = (o: unknown): void => void child.stdin.write(JSON.stringify(o) + '\n');
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => finish(e));
    child.on('close', () => finish(new Error(`codex app-server exited before answering. stderr: ${stderr.slice(-500)}`)));
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 0) {
          if (m.error) return finish(new Error(`initialize failed: ${JSON.stringify(m.error)}`));
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 1, method: 'hooks/list', params: { cwds: [cwd] } });
        } else if (m.id === 1) {
          if (m.error) return finish(new Error(`hooks/list failed: ${JSON.stringify(m.error)}`));
          finish(undefined, m.result?.data?.[0]?.hooks ?? []);
        }
      }
    });
    send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'explainit_conformance', title: 'ExplainIT conformance test', version: '0' } } });
  });
}

const ORIGINAL = 'def greet(name):\n    return "Hello " + name\n\n\nif __name__ == "__main__":\n    print(greet("world"))\n';
// Read first, so the agent edits the real content instead of guessing the quote style.
const ALLOW_PROMPT = 'Read hello.py first. Then edit it so that greet returns "Hi " + name instead of "Hello " + name, keeping the existing double quotes. Use your file edit tool (apply_patch / Edit), never a shell command.';
const DENY_PROMPT = ALLOW_PROMPT + ' If the edit is rejected by a hook or checkpoint, stop immediately and do not retry.';

/** Codex prints these when its stored sign-in no longer works or is missing; the person has to run `codex login` themselves. */
const CODEX_AUTH_RE = /refresh token was revoked|token_revoked|log out and sign in again|401 Unauthorized|not logged in|codex login/i;
function assertCodexSignedIn(r: Run, label: string): void {
  if (CODEX_AUTH_RE.test(r.stderr) || CODEX_AUTH_RE.test(r.stdout)) {
    assert.fail(`${label} is not signed in on this machine (Codex reported that its stored sign-in was revoked or missing), so it never ran the edit. Run \`codex login\` in a terminal, then run this suite again. Last stderr: ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`);
  }
}

/** TOML basic-string escaping for a value passed through `codex -c key=value`. */
function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** The `[hooks.state]` records Codex expects for every ExplainIT entry in `hooksFile`, in the Doctor's own format. */
function trustRecords(hooksFile: string): string {
  const root = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  let real = hooksFile;
  try {
    real = fs.realpathSync.native(hooksFile);
  } catch {
    /* keep the configured path */
  }
  return findOurEntries(root)
    .map((e: FoundEntry) => {
      const ev = e.event as 'PreToolUse' | 'PostToolUse';
      const hash = codexHookHash(ev, e.matcher, { command: e.command, timeout: e.timeout });
      return `${codexHookStateHeader(real, ev, e.groupIndex, e.handlerIndex)}\nenabled = true\ntrusted_hash = "${hash}"\n`;
    })
    .join('\n');
}

suite('real agents against the ExplainIT hook (EXPLAINIT_REAL_AGENTS=1)', function () {
  this.timeout(400000);
  if (!ENABLED) {
    test('skipped: set EXPLAINIT_REAL_AGENTS=1 to drive the real claude and codex', function () {
      this.skip();
    });
    return;
  }

  let root: string;
  let home: string;
  let userHome: string;
  let codexHome: string;
  let env: AdapterEnv;
  let wrapper: string;
  let stub: StubGate;
  /** Whether the real Codex honours the trust record the installer's Doctor format describes (decided once by hooks/list). */
  const trustHonoured = new Map<string, boolean>();

  const agentEnv = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, USERPROFILE: userHome, CODEX_HOME: codexHome };
    // The wrapper pins EXPLAINIT_HOME and the command pins --home; the environment must not be needed.
    delete e.EXPLAINIT_HOME;
    // A nested Claude Code session must not inherit the outer session's markers.
    delete e.CLAUDECODE;
    delete e.CLAUDE_CODE_ENTRYPOINT;
    return e;
  };

  suiteSetup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-real-'));
    home = path.join(root, 'home');
    userHome = path.join(root, 'user');
    codexHome = path.join(userHome, '.codex');
    fs.mkdirSync(userHome, { recursive: true });
    stub = await startStub();

    // The shipped installer, exactly as "ExplainIT: Connect" runs it, against the temp homes.
    const probe: HostProbe = { findExtension: () => undefined, copilotModelCount: async () => 0 };
    const state = createStateStore(path.join(home, 'state.json'));
    env = makeAdapterEnv({ logger: createLogger([], 'real-agents'), settings: inMemorySettings({ gateWatchdogSeconds: 60 }), extensionPath: REPO, version: 'test' }, state, probe, {
      explainitHome: home,
      hooksDir: path.join(home, 'hooks'),
      userHome,
    });
    const claudeInstall = await new ClaudeAdapter(env).install();
    assert.strictEqual(claudeInstall.ok, true, claudeInstall.detail);
    const codexInstall = await new CodexAdapter(env).install();
    assert.strictEqual(codexInstall.ok, true, codexInstall.detail);
    wrapper = state.read().adapters!.claude!.wrapperPath!;
    assert.ok(isFile(wrapper), `wrapper written at ${wrapper}`);
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(userHome, '.claude', 'settings.json'), 'utf8'));
    assert.strictEqual(findOurEntries(claudeSettings).length, 2, 'installer wrote both Claude entries');
    for (const e of findOurEntries(claudeSettings)) assert.ok(e.command.includes(`--home ${shQuote(home)}`), `pinned home in ${e.command}`);

    // Codex trust record for the installer-written hooks.json, in the format the Doctor reads back.
    fs.writeFileSync(path.join(codexHome, 'config.toml'), trustRecords(path.join(codexHome, 'hooks.json')));
    // Codex keeps its sign-in in <CODEX_HOME>/auth.json: link the person's own file in (never copied, never read here).
    const realCodexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.trim() ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
    const realAuth = path.join(realCodexHome, 'auth.json');
    if (isFile(realAuth)) {
      try {
        fs.symlinkSync(realAuth, path.join(codexHome, 'auth.json'));
      } catch {
        /* no symlink rights (Windows): Codex will report "not logged in" and the assertion below explains it */
      }
    }
  });
  suiteTeardown(async () => {
    await stub.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Fallback only: Codex gets its hooks as a session-flag config layer when the user-layer trust record is not honoured. */
  function codexHookFlags(): string[] {
    const specs = codexEntrySpecs(shQuote(wrapper), 60, { explainitHome: home, claudeHome: path.join(userHome, '.claude'), codexHome, platform: process.platform });
    return specs.flatMap((s) => ['-c', `hooks.${s.event}=[{matcher=${tomlString(s.matcher)},hooks=[{type="command",command=${tomlString(s.command)},timeout=${s.timeout}}]}]`]);
  }

  async function codexTrustHonoured(agent: Agent): Promise<boolean> {
    const known = trustHonoured.get(agent.binary!);
    if (known !== undefined) return known;
    let honoured = false;
    try {
      const listed = await codexHooksList(agent.binary!, codexHome, root);
      const ours = listed.filter((h) => String(h.command).includes('explainit-hook'));
      honoured = ours.length === 2 && ours.every((h) => h.trustStatus === 'trusted');
    } catch {
      honoured = false;
    }
    trustHonoured.set(agent.binary!, honoured);
    return honoured;
  }

  function makeProject(agent: Agent): string {
    const proj = fs.mkdtempSync(path.join(root, `${agent.kind}-`));
    fs.writeFileSync(path.join(proj, 'hello.py'), ORIGINAL);
    fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true });
    writeSession(home, stub, [proj]);
    return proj;
  }

  async function drive(agent: Agent, proj: string, prompt: string): Promise<Run> {
    if (agent.kind === 'claude') {
      return run(agent.binary!, ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Edit,Write,Read', '--max-turns', '6', '--no-session-persistence'], proj, agentEnv(), 300000);
    }
    const trusted = await codexTrustHonoured(agent);
    const hookArgs = trusted ? [] : ['--dangerously-bypass-hook-trust', ...codexHookFlags()];
    return run(agent.binary!, ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'workspace-write', ...hookArgs, '-C', proj, '-o', path.join(proj, 'last.txt'), prompt], proj, agentEnv(), 300000);
  }

  function preToolUseSeen(agent: Agent): void {
    const pre = stub.requests.filter((r) => r.method === 'POST' && r.body?.event === 'PreToolUse');
    assert.ok(pre.length >= 1, `gate saw no PreToolUse from ${agent.label}; requests: ${JSON.stringify(stub.requests.map((r) => [r.method, r.url, r.body?.event]))}`);
    const p = pre[0].body.payload;
    assert.strictEqual(pre[0].body.agent, agent.kind);
    assert.ok(p.tool_input && typeof p.tool_input === 'object', 'tool_input present');
    if (agent.kind === 'claude') {
      assert.ok(['Edit', 'Write', 'MultiEdit'].includes(p.tool_name), `tool ${p.tool_name}`);
      assert.ok(String(p.tool_input.file_path).endsWith('hello.py'), String(p.tool_input.file_path));
    } else {
      assert.ok(['apply_patch', 'Edit', 'Write'].includes(p.tool_name), `tool ${p.tool_name}`);
      assert.ok(JSON.stringify(p.tool_input).includes('hello.py'));
    }
  }

  for (const agent of findAgents()) {
    suite(agent.label, () => {
      test('deny(reason) from the gate stops the edit before disk', async function () {
        if (!agent.binary) this.skip();
        const proj = makeProject(agent);
        stub.requests.length = 0;
        stub.handler = longPollThen({ permissionDecision: 'deny', reason: 'Rejected by the person: keep the greeting exactly as it is. Do not retry.' }, 800);
        const r = await drive(agent, proj, DENY_PROMPT);
        if (agent.kind === 'codex') assertCodexSignedIn(r, agent.label);
        assert.strictEqual(fs.readFileSync(path.join(proj, 'hello.py'), 'utf8'), ORIGINAL, `hello.py must be unchanged. stdout: ${r.stdout.slice(-800)} stderr: ${r.stderr.slice(-800)}`);
        preToolUseSeen(agent);
        const polls = stub.requests.filter((q) => q.method === 'GET');
        assert.ok(polls.length >= 1, 'the hook long-polled for the decision');
      });

      test('allow from the gate lets the same edit land', async function () {
        if (!agent.binary) this.skip();
        const proj = makeProject(agent);
        stub.requests.length = 0;
        stub.handler = decideWith({ permissionDecision: 'allow' });
        const r = await drive(agent, proj, ALLOW_PROMPT);
        if (agent.kind === 'codex') assertCodexSignedIn(r, agent.label);
        const after = fs.readFileSync(path.join(proj, 'hello.py'), 'utf8');
        assert.ok(after.includes('Hi'), `hello.py should now greet with Hi. content: ${after} stdout: ${r.stdout.slice(-800)} stderr: ${r.stderr.slice(-800)}`);
        assert.ok(!after.includes('"Hello "'), after);
        preToolUseSeen(agent);
      });

      if (agent.kind === 'codex') {
        test('reports the trust hash ExplainIT computes for the user-layer hook, and accepts our trust record (hooks/list)', async function () {
          if (!agent.binary) this.skip();
          this.timeout(180000);
          // A throwaway CODEX_HOME holding exactly what the installer writes to ~/.codex/hooks.json, without a trust record.
          const throwaway = fs.mkdtempSync(path.join(root, 'codex-home-'));
          const proj = fs.mkdtempSync(path.join(root, 'codex-proj-'));
          const specs = codexEntrySpecs(shQuote(wrapper), 120, { explainitHome: home, claudeHome: path.join(userHome, '.claude'), codexHome: throwaway, platform: process.platform });
          const hooksJson = { hooks: {} as Record<string, unknown[]> };
          for (const s of specs) hooksJson.hooks[s.event] = [{ matcher: s.matcher, hooks: [{ type: 'command', command: s.command, timeout: s.timeout }] }];
          const hooksFile = path.join(throwaway, 'hooks.json');
          fs.writeFileSync(hooksFile, JSON.stringify(hooksJson, null, 2));
          fs.writeFileSync(path.join(throwaway, 'config.toml'), '');

          const listed = await codexHooksList(agent.binary!, throwaway, proj);
          assert.strictEqual(listed.length, 2, `codex discovered our two entries: ${JSON.stringify(listed)}`);
          const ours = findOurEntries(hooksJson);
          const realHooksFile = fs.realpathSync.native(hooksFile);
          for (const e of ours) {
            const ev = e.event as 'PreToolUse' | 'PostToolUse';
            const hit = listed.find((h) => String(h.command) === e.command);
            assert.ok(hit, `codex listed the ${ev} entry`);
            assert.strictEqual(hit.key, codexHookKey(realHooksFile, ev, e.groupIndex, e.handlerIndex), 'state key format');
            assert.strictEqual(hit.currentHash, codexHookHash(ev, e.matcher, { command: e.command, timeout: e.timeout }), `trust hash for ${ev}`);
            assert.strictEqual(hit.trustStatus, 'untrusted');
          }

          // Write the [hooks.state] records in the format the Doctor parses; the real engine must now say "trusted".
          const toml = trustRecords(hooksFile);
          fs.writeFileSync(path.join(throwaway, 'config.toml'), toml);
          const trusted = await codexHooksList(agent.binary!, throwaway, proj);
          const pre = ours.find((e) => e.event === 'PreToolUse')!;
          const preEntry = trusted.find((h) => String(h.command) === pre.command);
          assert.ok(preEntry, 'PreToolUse entry still listed');
          assert.strictEqual(preEntry.trustStatus, 'trusted', JSON.stringify(preEntry));
          const hash = codexHookHash('PreToolUse', pre.matcher, { command: pre.command, timeout: pre.timeout });
          assert.strictEqual(lookupTrust(parseHookStates(toml), 'PreToolUse', pre.groupIndex, pre.handlerIndex, hash, [hooksFile, realHooksFile]).status, 'trusted', 'the Doctor reads the same record as trusted');
        });

        test('the installer-written user layer (hooks.json + trust record) is what the exec scenarios ran with', async function () {
          if (!agent.binary) this.skip();
          this.timeout(180000);
          const honoured = await codexTrustHonoured(agent);
          assert.strictEqual(honoured, true, 'codex reported the installer-written entries in the temp CODEX_HOME as trusted, so the exec scenarios ran without --dangerously-bypass-hook-trust');
        });
      }
    });
  }
});
