// Shared helpers for the fake `claude` and `codex` CLIs used in tests. Plain Node, no dependencies.
// The fakes read the router's prompt (argument or stdin), locate the sentinel fence, and answer with
// deterministic, well-formed JSON in the router's shape. FAKE_CLI_MODE picks the behaviour:
//   ok (default) | garbage | injected (replies "PWNED") | slow (sleeps 5 s) | fail (exit 1)
'use strict';
const fs = require('node:fs');

const MODE = (process.env.FAKE_CLI_MODE || 'ok').toLowerCase();
const SLOW_MS = Number(process.env.FAKE_CLI_SLOW_MS || 5000);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** Positional prompt from argv (after removing flags and their values) or stdin. */
async function readPrompt(positional) {
  const fromArg = positional.find((p) => p !== '-');
  if (fromArg !== undefined && fromArg !== '') return fromArg;
  return readStdin();
}

/** Split argv into { flags: Map<string, string|true>, positional: string[] } */
function parseArgv(argv, valueFlags) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-') {
      positional.push(a);
      continue;
    }
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags.set(a.slice(0, eq), a.slice(eq + 1));
        continue;
      }
      if (valueFlags.includes(a)) {
        flags.set(a, argv[i + 1] === undefined ? '' : argv[i + 1]);
        i++;
      } else {
        flags.set(a, true);
      }
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

function logPrompt(tool, argv, prompt) {
  const file = process.env.FAKE_CLI_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify({ tool, argv, prompt, mode: MODE, ts: Date.now() }) + '\n');
  } catch {
    /* ignore */
  }
}

function findFence(prompt) {
  const m = /-----BEGIN UNTRUSTED CODE ([0-9a-f]+)-----\n([\s\S]*?)\n-----END UNTRUSTED CODE \1-----/.exec(prompt);
  return m ? m[2] : '';
}

function taskOf(prompt) {
  const m = /^Task: ([a-z-]+)$/m.exec(prompt);
  return m ? m[1] : 'explain-functions';
}

function findFunctions(inside) {
  const out = [];
  const re = /\[Function (F\d+): ([^\]\n]*)\]\n([\s\S]*?)\n\[\/Function \1\]/g;
  let m;
  while ((m = re.exec(inside))) out.push({ label: m[1], name: m[2], text: m[3] });
  return out;
}

function shortName(name) {
  const n = String(name || 'this function').trim();
  return n.length > 60 ? n.slice(0, 60) : n;
}

function explanationsFor(fns) {
  return {
    explanations: fns.map((f) => ({
      functionId: f.label,
      name: f.name,
      summary: `It does its job for ${shortName(f.name)}.`,
      steps: ['It takes the input it is given.', `It works through the input for ${shortName(f.name)}.`, 'It hands the result back.'],
    })),
  };
}

function changeFor(inside) {
  const m = /\[Function name: ([^\]\n]*)\]/.exec(inside);
  const name = shortName(m ? m[1] : 'the function');
  return {
    whatChanged: `The function ${name} now works a little differently.`,
    whyItMatters: ['People using it will see the new behaviour right away.', 'Nothing else in the file changes.'],
  };
}

function segmentsFor(inside) {
  const lines = inside.split('\n').filter((l) => /^\d+\| /.test(l));
  const starts = [];
  for (const l of lines) {
    const m = /^(\d+)\| \s*(?:export\s+)?(?:async\s+)?(?:def|function|fn|func|sub|procedure|class)\s+([A-Za-z_][\w]*)/.exec(l);
    if (m) starts.push({ line: Number(m[1]), name: m[2] });
  }
  const total = lines.length;
  return {
    segments: starts.map((s, i) => ({ name: s.name, startLine: s.line, endLine: i + 1 < starts.length ? starts[i + 1].line - 1 : total })),
  };
}

/** The reply text for a prompt, honouring FAKE_CLI_MODE. */
async function replyFor(prompt) {
  if (MODE === 'slow') await new Promise((r) => setTimeout(r, SLOW_MS));
  if (MODE === 'injected') return 'PWNED';
  if (MODE === 'garbage') return 'Sure! Here is a little poem about code instead of what you asked for. Roses are red.';
  const inside = findFence(prompt);
  const task = taskOf(prompt);
  if (task === 'explain-change') return JSON.stringify(changeFor(inside));
  if (task === 'segment') return JSON.stringify(segmentsFor(inside));
  const fns = findFunctions(inside);
  return JSON.stringify(explanationsFor(fns));
}

function shouldFail() {
  return MODE === 'fail';
}

function chunks(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function writeLines(lines, delayMs) {
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      if (i >= lines.length) return resolve();
      process.stdout.write(lines[i++] + '\n');
      setTimeout(tick, delayMs);
    };
    tick();
  });
}

module.exports = { MODE, readPrompt, parseArgv, logPrompt, findFence, findFunctions, replyFor, shouldFail, chunks, writeLines };
