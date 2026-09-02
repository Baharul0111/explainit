/**
 * Real-agent conformance (REQ-016, REQ-017, REQ-022). Gated: runs only when
 * EXPLAINIT_REAL_AGENTS=1, because it drives the REAL `claude` and `codex` on this machine (both
 * must be signed in) and spends assistant credits.
 *
 * What it proves: with the ExplainIT hook installed (project layer for the test) and a stub gate,
 *   - a deny(reason) from the gate leaves hello.py unchanged and the gate saw PreToolUse + tool_input,
 *   - an allow lets the same edit land,
 * for the claude CLI, the codex CLI, AND the binaries bundled inside the Claude Code / Codex VS Code
 * extensions (~/.vscode/extensions/anthropic.claude-code-*\/resources/native-binary/claude and
 * ~/.vscode/extensions/openai.chatgpt-*\/bin/<platform>/codex), i.e. the editor path is gated by the
 * very same hooks.
 *
 * Commands (macOS, run from the repo root):
 *   npx tsc -p ./ --outDir out-adapters
 *   EXPLAINIT_REAL_AGENTS=1 npx mocha --ui tdd "out-adapters/test/conformance/real-agents.test.js" --timeout 600000
 * The exact agent invocations are:
 *   claude -p "<prompt>" --output-format json --allowedTools Edit,Write,Read --max-turns 6 --no-session-persistence
 *   codex exec --skip-git-repo-check --ephemeral --sandbox workspace-write --dangerously-bypass-hook-trust \
 *         -c 'projects."<tmp>".trust_level="trusted"' -C <tmp> -o <tmp>/last.txt "<prompt>"
 * (`--dangerously-bypass-hook-trust` is needed because the test's hooks.json lives in a temp project
 * and no human can trust it; the shipped installer puts hooks in ~/.codex/hooks.json where the person
 * trusts them once.)
 */
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { codexBundledBinary, pickExtensionDir } from '../../src/adapters/pure/extensionDirs';
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

const ORIGINAL = 'def greet(name):\n    return "Hello " + name\n\n\nif __name__ == "__main__":\n    print(greet("world"))\n';
// Read first, so the agent edits the real content instead of guessing the quote style.
const ALLOW_PROMPT = 'Read hello.py first. Then edit it so that greet returns "Hi " + name instead of "Hello " + name, keeping the existing double quotes. Use your file edit tool (apply_patch / Edit), never a shell command.';
const DENY_PROMPT = ALLOW_PROMPT + ' If the edit is rejected by a hook or checkpoint, stop immediately and do not retry.';

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

  function makeProject(agent: Agent): string {
    const proj = fs.mkdtempSync(path.join(root, `${agent.kind}-`));
    fs.writeFileSync(path.join(proj, 'hello.py'), ORIGINAL);
    const cmd = `${shQuote(wrapper)} --agent ${agent.kind} --watchdog 60`;
    if (agent.kind === 'claude') {
      fs.mkdirSync(path.join(proj, '.claude'));
      fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: cmd, timeout: 7200 }] }] } }, null, 2));
    } else {
      fs.mkdirSync(path.join(proj, '.codex'));
      fs.writeFileSync(path.join(proj, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'apply_patch|Edit|Write|Bash', hooks: [{ type: 'command', command: cmd, timeout: 7200 }] }] } }, null, 2));
    }
    for (const f of fs.readdirSync(path.join(home, 'sessions').replace(/sessions$/, ''))) if (f === 'sessions') fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true });
    writeSession(home, stub, [proj]);
    return proj;
  }

  async function drive(agent: Agent, proj: string, prompt: string): Promise<Run> {
    if (agent.kind === 'claude') {
      return run(agent.binary!, ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Edit,Write,Read', '--max-turns', '6', '--no-session-persistence'], proj, agentEnv(), 300000);
    }
    return run(
      agent.binary!,
      ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'workspace-write', '--dangerously-bypass-hook-trust', '-c', `projects."${proj}".trust_level="trusted"`, '-C', proj, '-o', path.join(proj, 'last.txt'), prompt],
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
        const after = fs.readFileSync(path.join(proj, 'hello.py'), 'utf8');
        assert.ok(after.includes('Hi'), `hello.py should now greet with Hi. content: ${after} stdout: ${r.stdout.slice(-800)} stderr: ${r.stderr.slice(-800)}`);
        assert.ok(!after.includes('"Hello "'), after);
        preToolUseSeen(agent);
      });
    });
  }
});
