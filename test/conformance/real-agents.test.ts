/**
 * Real-agent conformance (REQ-016, REQ-017, REQ-022). Gated: runs only when
 * EXPLAINIT_REAL_AGENTS=1, because it drives the REAL `claude` and `codex` on this machine (both
 * must be signed in) and spends assistant credits.
 *
 * What it proves, against a stub gate on 127.0.0.1 and a temp EXPLAINIT_HOME:
 *   - a deny(reason) from the gate leaves hello.py unchanged and the gate saw PreToolUse + tool_input,
 *   - an allow lets the same edit land,
 * for the claude CLI, the codex CLI, AND the binaries bundled inside the Claude Code / Codex VS Code
 * extensions (~/.vscode/extensions/anthropic.claude-code-*\/resources/native-binary/claude and
 * ~/.vscode/extensions/openai.chatgpt-*\/bin/<platform>/codex), i.e. the editor path is gated by the
 * very same hooks. For Codex it additionally proves (no credits, no sign-in needed) that the trust hash
 * ExplainIT's Doctor computes is the one the real engine reports through `hooks/list`, and that a
 * `[hooks.state]` record written in ExplainIT's format makes the engine report the hook as trusted.
 *
 * Commands (macOS, run from the repo root):
 *   npx tsc -p ./ --outDir out-adapters
 *   EXPLAINIT_REAL_AGENTS=1 npx mocha --ui tdd "out-adapters/test/conformance/real-agents.test.js" --timeout 600000
 * The exact agent invocations are:
 *   claude -p "<prompt>" --output-format json --allowedTools Edit,Write,Read --max-turns 6 --no-session-persistence
 *     (hook installed at the project layer for the test: <tmp>/.claude/settings.json)
 *   codex exec --skip-git-repo-check --ephemeral --sandbox workspace-write --dangerously-bypass-hook-trust \
 *         -c 'hooks.PreToolUse=[{matcher="apply_patch|Edit|Write|Bash",hooks=[{type="command",command="<wrapper> --agent codex --watchdog 60",timeout=7200}]}]' \
 *         -c 'hooks.PostToolUse=[...same with --event PostToolUse, timeout=10]' -C <tmp> -o <tmp>/last.txt "<prompt>"
 *     (Codex ignores a project-layer .codex/hooks.json unless the project is trusted in the person's own
 *      ~/.codex/config.toml, which this test must not touch, so the hook is injected as a session-flag layer;
 *      `--dangerously-bypass-hook-trust` is needed because nobody can trust a throwaway hook. The shipped
 *      installer puts the hook in ~/.codex/hooks.json where the person trusts it once.)
 *   codex app-server  (JSON-RPC over stdio: initialize -> initialized -> hooks/list) with CODEX_HOME=<tmp>
 */
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexBundledBinary, pickExtensionDir } from '../../src/adapters/pure/extensionDirs';
import { codexEntrySpecs, findOurEntries } from '../../src/adapters/pure/hookConfig';
import { codexHookHash, codexHookKey, lookupTrust, parseHookStates } from '../../src/adapters/pure/codexTrust';
import { findOnPath } from '../../src/adapters/pure/pathLookup';
import { shQuote } from '../../src/adapters/pure/wrappers';
import { resolveNodeRuntime, writeWrappers } from '../../src/adapters/runtime';
import { decideWith, longPollThen, startStub, writeSession, type StubGate, HOOK_SCRIPT } from './stubGate';

const ENABLED = process.env.EXPLAINIT_REAL_AGENTS === '1';
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

/** Codex prints these when its stored sign-in no longer works; the person has to run `codex login` themselves. */
const CODEX_AUTH_RE = /refresh token was revoked|token_revoked|log out and sign in again|401 Unauthorized|not logged in|codex login/i;
function assertCodexSignedIn(r: Run, label: string): void {
  if (CODEX_AUTH_RE.test(r.stderr) || CODEX_AUTH_RE.test(r.stdout)) {
    assert.fail(`${label} is not signed in on this machine (Codex reported that its stored sign-in was revoked), so it never ran the edit. Run \`codex login\` in a terminal, then run this suite again. Last stderr: ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`);
  }
}

/** TOML basic-string escaping for a value passed through `codex -c key=value`. */
function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
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
  let wrapper: string;
  let stub: StubGate;
  const agentEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, EXPLAINIT_HOME: home };
    // A nested Claude Code session must not inherit the outer session's markers.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return env;
  };

  suiteSetup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-real-'));
    home = path.join(root, 'home');
    const hooksDir = path.join(home, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const script = path.join(hooksDir, 'explainit-hook.js');
    fs.copyFileSync(HOOK_SCRIPT, script);
    const w = writeWrappers(hooksDir, resolveNodeRuntime(), script);
    wrapper = process.platform === 'win32' ? w.cmd.path : w.sh.path;
    stub = await startStub();
  });
  suiteTeardown(async () => {
    await stub.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const hookCommand = (agent: 'claude' | 'codex'): string => `${shQuote(wrapper)} --agent ${agent} --watchdog 60`;

  /** Codex gets its hooks as a session-flag config layer (see the header for why). */
  function codexHookFlags(): string[] {
    const pre = hookCommand('codex');
    const post = `${shQuote(wrapper)} --agent codex --event PostToolUse`;
    return [
      '-c',
      `hooks.PreToolUse=[{matcher="apply_patch|Edit|Write|Bash",hooks=[{type="command",command=${tomlString(pre)},timeout=7200}]}]`,
      '-c',
      `hooks.PostToolUse=[{matcher="apply_patch|Edit|Write",hooks=[{type="command",command=${tomlString(post)},timeout=10}]}]`,
    ];
  }

  function makeProject(agent: Agent): string {
    const proj = fs.mkdtempSync(path.join(root, `${agent.kind}-`));
    fs.writeFileSync(path.join(proj, 'hello.py'), ORIGINAL);
    if (agent.kind === 'claude') {
      fs.mkdirSync(path.join(proj, '.claude'));
      fs.writeFileSync(
        path.join(proj, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: hookCommand('claude'), timeout: 7200 }] }] } }, null, 2),
      );
    }
    fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true });
    writeSession(home, stub, [proj]);
    return proj;
  }

  async function drive(agent: Agent, proj: string, prompt: string): Promise<Run> {
    if (agent.kind === 'claude') {
      return run(agent.binary!, ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Edit,Write,Read', '--max-turns', '6', '--no-session-persistence'], proj, agentEnv(), 300000);
    }
    return run(
      agent.binary!,
      ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'workspace-write', '--dangerously-bypass-hook-trust', ...codexHookFlags(), '-C', proj, '-o', path.join(proj, 'last.txt'), prompt],
      proj,
      agentEnv(),
      300000,
    );
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
          // A throwaway CODEX_HOME holding exactly what the installer writes to ~/.codex/hooks.json.
          const codexHome = fs.mkdtempSync(path.join(root, 'codex-home-'));
          const proj = fs.mkdtempSync(path.join(root, 'codex-proj-'));
          const specs = codexEntrySpecs(shQuote(wrapper), 120);
          const hooksJson = { hooks: {} as Record<string, unknown[]> };
          for (const s of specs) hooksJson.hooks[s.event] = [{ matcher: s.matcher, hooks: [{ type: 'command', command: s.command, timeout: s.timeout }] }];
          const hooksFile = path.join(codexHome, 'hooks.json');
          fs.writeFileSync(hooksFile, JSON.stringify(hooksJson, null, 2));
          fs.writeFileSync(path.join(codexHome, 'config.toml'), '');

          const listed = await codexHooksList(agent.binary!, codexHome, proj);
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

          // Write a [hooks.state] record in the format the Doctor parses; the real engine must now say "trusted".
          const pre = ours.find((e) => e.event === 'PreToolUse')!;
          const key = codexHookKey(realHooksFile, 'PreToolUse', pre.groupIndex, pre.handlerIndex);
          const hash = codexHookHash('PreToolUse', pre.matcher, { command: pre.command, timeout: pre.timeout });
          const toml = `[hooks.state."${key}"]\nenabled = true\ntrusted_hash = "${hash}"\n`;
          fs.writeFileSync(path.join(codexHome, 'config.toml'), toml);
          const trusted = await codexHooksList(agent.binary!, codexHome, proj);
          const preEntry = trusted.find((h) => String(h.command) === pre.command);
          assert.ok(preEntry, 'PreToolUse entry still listed');
          assert.strictEqual(preEntry.trustStatus, 'trusted', JSON.stringify(preEntry));
          assert.strictEqual(lookupTrust(parseHookStates(toml), 'PreToolUse', pre.groupIndex, pre.handlerIndex, hash, [hooksFile, realHooksFile]).status, 'trusted', 'the Doctor reads the same record as trusted');
        });
      }
    });
  }
});
