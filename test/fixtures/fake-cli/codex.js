#!/usr/bin/env node
// Fake `codex` CLI for tests. Accepts the real argument shapes:
//   codex --version
//   codex exec --skip-git-repo-check --ephemeral --sandbox read-only -C <dir> -o <file> [--json] [prompt | -]
// The prompt comes from the positional argument or stdin ("-"). The final message is written to the
// -o file; with --json, JSONL events go to stdout. See common.js for FAKE_CLI_MODE.
'use strict';
const fs = require('node:fs');
const { parseArgv, readPrompt, logPrompt, replyFor, shouldFail, signedOut, CODEX_SIGNED_OUT, writeLines } = require('./common');

const VALUE_FLAGS = ['-C', '--cd', '-o', '--output-last-message', '--sandbox', '-s', '-m', '--model', '-c', '--config', '-p', '--profile', '--output-schema', '--color', '--add-dir', '-i', '--image', '--enable', '--disable'];

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgv(argv, VALUE_FLAGS);
  if (flags.has('--version') || flags.has('-V')) {
    process.stdout.write('codex-cli 0.0.0-fake\n');
    return 0;
  }
  if (positional[0] !== 'exec') {
    process.stderr.write('fake codex: only "codex exec" is supported\n');
    return 2;
  }
  const prompt = await readPrompt(positional.slice(1));
  logPrompt('codex', argv, prompt);
  if (shouldFail()) {
    process.stderr.write('fake codex: failure requested by FAKE_CLI_MODE=fail\n');
    return 1;
  }
  if (signedOut()) {
    // The real CLI never writes the -o file here: the notice goes to stderr (and, with --json, to an
    // error event on stdout) and the exit code is 1.
    if (flags.has('--json')) {
      await writeLines([JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }), JSON.stringify({ type: 'error', message: CODEX_SIGNED_OUT })], 3);
    }
    process.stderr.write('ERROR: ' + CODEX_SIGNED_OUT + '\n');
    return 1;
  }
  const text = await replyFor(prompt);
  const outFile = flags.get('-o') || flags.get('--output-last-message');
  if (outFile) {
    try {
      fs.writeFileSync(outFile, text);
    } catch (e) {
      process.stderr.write(`fake codex: could not write ${outFile}: ${e.message}\n`);
    }
  }
  if (flags.has('--json')) {
    await writeLines(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
      ],
      3,
    );
    return 0;
  }
  process.stderr.write('OpenAI Codex v0.0.0-fake\n--------\nworkdir: ' + (flags.get('-C') || process.cwd()) + '\n--------\n');
  process.stdout.write(text + '\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`fake codex crashed: ${e && e.stack ? e.stack : e}\n`);
    process.exit(3);
  },
);
