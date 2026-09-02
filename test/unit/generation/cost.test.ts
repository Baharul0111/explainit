import * as assert from 'node:assert/strict';
import { OUTPUT_TOKENS_PER_FUNCTION, PROMPT_OVERHEAD_CHARS, estimateCost } from '../../../src/generation/pure/cost';
import { manyFunctions, request } from './helpers';

suite('generation/pure/cost', () => {
  test('empty input', () => {
    assert.deepEqual(estimateCost([], 'none'), { functions: 0, files: 0, requests: 0, inputTokens: 0, outputTokens: 0, channel: 'none' });
  });

  test('requests = ceil(functions / 20) per file; files with no functions cost nothing', () => {
    const reqs = [request(manyFunctions(45)), request(manyFunctions(20)), request(manyFunctions(1)), request([])];
    const c = estimateCost(reqs, 'claude');
    assert.equal(c.files, 4);
    assert.equal(c.functions, 66);
    assert.equal(c.requests, 3 + 1 + 1);
    assert.equal(c.outputTokens, 66 * OUTPUT_TOKENS_PER_FUNCTION);
    assert.equal(c.channel, 'claude');
  });

  test('input tokens = ceil(chars / 4) over function text, capped summary and prompt overhead per request', () => {
    const fns = manyFunctions(2);
    const summary = 'import a\nimport b';
    const c = estimateCost([request(fns, { fileSummary: summary })], 'codex');
    const chars = fns.reduce((n, f) => n + f.text.length, 0) + summary.length + PROMPT_OVERHEAD_CHARS;
    assert.equal(c.inputTokens, Math.ceil(chars / 4));
    assert.ok(PROMPT_OVERHEAD_CHARS > 500, 'the fixed prompt text is counted');
  });

  test('the summary is capped at 20 lines in thrift mode', () => {
    const fns = manyFunctions(1);
    const big = Array.from({ length: 200 }, (_, i) => `import line${i}`).join('\n');
    const thrift = estimateCost([request(fns, { fileSummary: big })], 'none', 20, true);
    const relaxed = estimateCost([request(fns, { fileSummary: big })], 'none', 20, false);
    assert.ok(thrift.inputTokens < relaxed.inputTokens);
    assert.ok(relaxed.inputTokens < Math.ceil((big.length + fns[0].text.length + PROMPT_OVERHEAD_CHARS) / 4));
  });

  test('a smaller per-request cap raises the request count; never above 20', () => {
    assert.equal(estimateCost([request(manyFunctions(40))], 'none', 5).requests, 8);
    assert.equal(estimateCost([request(manyFunctions(40))], 'none', 500).requests, 2);
    assert.equal(estimateCost([request(manyFunctions(40))], 'none', 0).requests, 40);
  });
});
