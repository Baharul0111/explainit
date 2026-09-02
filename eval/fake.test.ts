/**
 * The scripted stand-in for `claude -p` (eval/fixtures/fake-claude.js) answers both eval prompts in
 * the CLI's JSON output shape, and the resynth path drives it through the real CLI helpers.
 */
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inMemorySettings } from '../src/core/settings';
import { EVAL_PATHS } from './paths';
import { parseSubset } from './pure/humaneval';
import { RESYNTH_TASK_HEADER, buildResynthPrompt, parseClaudeJsonReply, resynthesize } from './resynth';
import { checkStyle } from './style';

function runFake(args: string[], stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [EVAL_PATHS.fakeClaude(), ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

suite('eval/fixtures/fake-claude.js', function () {
  this.timeout(30_000);
  const subset = parseSubset(fs.readFileSync(EVAL_PATHS.subset(), 'utf8'));

  test('--version exits 0 with a version number', async () => {
    const r = await runFake(['--version'], '');
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /\d+\.\d+\.\d+/);
  });

  test('explain-functions prompts get well-formed explanations in the json result shape', async () => {
    const prompt = 'Task: explain-functions\n[Function F1: flip_case]\ndef flip_case(s):\n    return s.swapcase()\n[/Function F1]\n[Function F2: pluck]\n...\n[/Function F2]\n';
    const r = await runFake(['-p', '--tools', '', '--output-format', 'json'], prompt);
    assert.strictEqual(r.code, 0, r.stderr);
    const parsed = parseClaudeJsonReply(r.stdout);
    assert.strictEqual(parsed.error, undefined);
    const body = JSON.parse(parsed.text!) as { explanations: { functionId: string; name: string; summary: string; steps: string[] }[] };
    assert.strictEqual(body.explanations.length, 2);
    assert.deepStrictEqual(body.explanations.map((e) => e.functionId), ['F1', 'F2']);
    assert.strictEqual(body.explanations[1].name, 'pluck');
    for (const e of body.explanations) assert.ok(checkStyle(e).ok, checkStyle(e).problems.join(' '));
  });

  test('stream-json output carries an assistant line and a result line', async () => {
    const r = await runFake(['-p', '--output-format', 'stream-json', '--verbose'], 'Task: explain-functions\n[Function F1: f]\n[/Function F1]');
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines.map((l) => l.type), ['assistant', 'result']);
  });

  test('resynthesize prompts return the canonical solution, except the last problem which is wrong on purpose', async () => {
    const first = subset.problems[0];
    const prompt = buildResynthPrompt({ entryPoint: first.entry_point, signature: `def ${first.entry_point}(x):`, context: '', explanation: { summary: 'Does a thing.', steps: ['It starts.', 'It ends.'] } });
    assert.ok(prompt.startsWith(RESYNTH_TASK_HEADER));
    const r = await runFake(['-p', '--output-format', 'json'], prompt);
    const text = parseClaudeJsonReply(r.stdout).text!;
    assert.ok(text.includes('```python'));
    assert.ok(text.includes(first.canonical_solution.trim().split('\n')[0].trim()));

    const last = subset.problems[subset.problems.length - 1];
    const r2 = await runFake(['-p', '--output-format', 'json'], `Task: resynthesize\nFunction name: ${last.entry_point}\n`);
    assert.ok(parseClaudeJsonReply(r2.stdout).text!.includes('return None'));

    const r3 = await runFake(['-p', '--output-format', 'json'], 'Task: resynthesize\nFunction name: not_in_subset\n');
    assert.ok(parseClaudeJsonReply(r3.stdout).text!.includes('def not_in_subset('));
  });

  test('unknown tasks and non -p mode are handled', async () => {
    const r = await runFake(['-p', '--output-format', 'json'], 'hello');
    assert.strictEqual(parseClaudeJsonReply(r.stdout).text, 'I do not understand this task.');
    const r2 = await runFake([], '');
    assert.strictEqual(r2.code, 2);
  });

  test('resynthesize() drives the fake through the real CLI resolution (node <script>.js setting)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-fake-test-'));
    try {
      const settings = inMemorySettings({ claudeCliPath: `node ${EVAL_PATHS.fakeClaude()}` });
      const p = subset.problems[2];
      const r = await resynthesize('claude', settings, { entryPoint: p.entry_point, signature: `def ${p.entry_point}(string: str) -> str:`, context: '', explanation: { summary: 'Swaps letter case.', steps: ['It looks at each letter.', 'It flips it.'] } }, { timeoutMs: 20_000, homeDir: home });
      assert.ok(r.code.startsWith(`def ${p.entry_point}(`), r.code);
      assert.ok(r.code.includes(p.canonical_solution.trim()), r.code);
      assert.match(r.detail, /^claude setting \d+ms exit=0$/);
      assert.ok(fs.existsSync(path.join(home, 'tmp')), 'the CLI ran inside <home>/tmp');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('a missing CLI is a plain-English error', async () => {
    const settings = inMemorySettings({ claudeCliPath: '/definitely/not/here/claude' });
    await assert.rejects(
      resynthesize('claude', settings, { entryPoint: 'f', signature: 'def f():', context: '', explanation: { summary: 'x.', steps: ['a.', 'b.'] } }, { timeoutMs: 5_000, homeDir: os.tmpdir(), resolve: () => ({ kind: 'claude', path: '', argsPrefix: [], source: 'none', detail: 'Claude Code was not found on PATH.' }) }),
      /Claude Code was not found/,
    );
  });
});
