#!/usr/bin/env node
/**
 * Minimal stand-in for the `claude -p` CLI used by `npm run eval -- --channel fake`.
 * No dependencies, no network, deterministic. It understands the two prompts the eval sends:
 *
 *   Task: explain-functions  -> a well-formed explanations JSON object, one item per [Function Fn: name]
 *   Task: resynthesize       -> the canonical HumanEval solution for "Function name: <entry point>",
 *                               looked up in eval/humaneval-subset.json, wrapped in a ```python fence.
 *                               The LAST problem of the subset is answered wrongly on purpose so the
 *                               harness provably detects failing code (fake pass@1 = 11/12).
 *
 * Because it "knows" the answers it says nothing about model quality; it exists to exercise every
 * stage of the harness (prompt -> parse -> style -> resynth -> sandboxed Python -> scores -> baseline)
 * without spending anyone's credits. Output mimics `--output-format json` and `stream-json`.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  process.stdout.write('2.1.252 (ExplainIT eval fake)\n');
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function loadSubset() {
  const file = process.env.EXPLAINIT_EVAL_SUBSET || path.join(__dirname, '..', 'humaneval-subset.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.problems;
}

/** def line(s) of the entry point: from `def name(` up to the first line ending with ':'. */
function signatureOf(prompt, entryPoint) {
  const text = prompt.replace(/\r\n?/g, '\n');
  const re = new RegExp('^[ \\t]*def\\s+' + entryPoint + '\\s*\\(', 'm');
  const m = re.exec(text);
  if (!m) return 'def ' + entryPoint + '():';
  const lines = text.slice(m.index).split('\n');
  const out = [];
  for (const l of lines) {
    out.push(l);
    if (/:\s*$/.test(l)) break;
  }
  return out.join('\n');
}

function explain(prompt) {
  const items = [];
  const re = /\[Function (F\d+): ([^\]\n]+)\]/g;
  let m;
  while ((m = re.exec(prompt))) {
    const name = m[2].trim();
    items.push({
      functionId: m[1],
      name,
      summary: `The function ${name} looks at what it is given and works out one answer from it.`,
      steps: ['It takes the values it is given.', 'It works through them in order.', 'It hands back the result.'],
    });
  }
  return JSON.stringify({ explanations: items });
}

function resynthesize(prompt) {
  const m = /^Function name:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/m.exec(prompt);
  if (!m) return 'I could not find the function name in the request.';
  const problems = loadSubset();
  const index = problems.findIndex((p) => p.entry_point === m[1]);
  if (index < 0) return '```python\ndef ' + m[1] + '(*args, **kwargs):\n    return None\n```';
  const p = problems[index];
  const sig = signatureOf(p.prompt, p.entry_point);
  const wrongOnPurpose = index === problems.length - 1;
  const body = wrongOnPurpose ? '    return None\n' : p.canonical_solution;
  return 'Here is the function.\n\n```python\n' + sig + '\n' + body.replace(/\s+$/, '') + '\n```\n';
}

function emit(text) {
  const stream = argv.includes('stream-json');
  if (stream) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, result: text, session_id: 'explainit-fake' }) + '\n');
}

(async () => {
  if (!argv.includes('-p')) {
    process.stderr.write('ExplainIT fake claude: only "-p" mode is supported.\n');
    process.exit(2);
  }
  const prompt = await readStdin();
  let text;
  try {
    if (prompt.includes('Task: explain-functions')) text = explain(prompt);
    else if (prompt.includes('Task: resynthesize')) text = resynthesize(prompt);
    else text = 'I do not understand this task.';
  } catch (e) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(e && e.message) }) + '\n');
    process.exit(1);
  }
  emit(text);
})();
