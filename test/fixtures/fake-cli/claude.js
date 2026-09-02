#!/usr/bin/env node
// Fake `claude` CLI for tests. Accepts the real argument shapes:
//   claude --version
//   claude -p [prompt] --output-format json|stream-json|text --tools "" --no-session-persistence --strict-mcp-config
//   claude -p ... --output-format stream-json --include-partial-messages --verbose
// The prompt comes from the positional argument or stdin. See common.js for FAKE_CLI_MODE.
'use strict';
const { parseArgv, readPrompt, logPrompt, replyFor, shouldFail, chunks, writeLines } = require('./common');

const VALUE_FLAGS = ['--output-format', '--tools', '--model', '--max-turns', '--input-format', '--append-system-prompt', '--system-prompt', '--json-schema', '--effort', '--permission-mode', '--settings', '--mcp-config'];

async function main() {
  const { flags, positional } = parseArgv(process.argv.slice(2), VALUE_FLAGS);
  if (flags.has('--version') || flags.has('-v')) {
    process.stdout.write('1.0.0 (Claude Code fake)\n');
    return 0;
  }
  if (!flags.has('-p') && !flags.has('--print')) {
    process.stderr.write('fake claude: only -p/--print mode is supported\n');
    return 2;
  }
  const prompt = await readPrompt(positional);
  logPrompt('claude', process.argv.slice(2), prompt);
  if (shouldFail()) {
    process.stderr.write('fake claude: failure requested by FAKE_CLI_MODE=fail\n');
    return 1;
  }
  const format = flags.get('--output-format') || 'text';
  const text = await replyFor(prompt);
  const session = 'fake-session-0000';
  if (format === 'json') {
    process.stdout.write(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 4, num_turns: 1, result: text, session_id: session, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }) + '\n',
    );
    return 0;
  }
  if (format === 'stream-json') {
    const lines = [JSON.stringify({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session, tools: [], model: 'fake' })];
    lines.push(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant', content: [] } }, session_id: session }));
    lines.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: session }));
    for (const piece of chunks(text, 40)) {
      lines.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, session_id: session }));
    }
    lines.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: session }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: session }));
    lines.push(JSON.stringify({ type: 'stream_event', event: { type: 'message_stop' }, session_id: session }));
    lines.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: text, session_id: session, total_cost_usd: 0 }));
    await writeLines(lines, 3);
    return 0;
  }
  process.stdout.write(text + '\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`fake claude crashed: ${e && e.stack ? e.stack : e}\n`);
    process.exit(3);
  },
);
