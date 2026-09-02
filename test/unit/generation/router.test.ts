/**
 * Router behaviour with fake channels (no CLIs, no vscode) plus one end-to-end run through the
 * public factory and the fake claude CLI.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONSENT_ERROR, MAX_FUNCTION_CHARS, MAX_SEGMENT_CHARS, OVERSIZED_SUMMARY, chunkFunctions, createRouter } from '../../../src/generation/router';
import { createGenerationRouter, createFileCache, createConsentStore, promptHash } from '../../../src/generation';
import { FALLBACK_SUMMARY, isFallbackExplanation } from '../../../src/generation/pure/parse';
import { REASK_PREFACE, splitFence } from '../../../src/generation/pure/prompts';
import { createStateStore } from '../../../src/core/state';
import { CancelSource } from '../../../src/core/cancel';
import type { Disposable } from '../../../src/core/interfaces';
import type { Explanation } from '../../../src/core/types';
import { FAKE_CLAUDE, FAKE_CODEX, FIXTURE_WORKSPACE, channelError, consent, fakeChannel, fn, goodReplyFor, manyFunctions, memoryCache, request, rmDir, settings, silentLogger, tmpDir, type FakeChannel } from './helpers';

function makeRouter(channels: FakeChannel[], opts: { consent?: boolean; settings?: Parameters<typeof settings>[0]; logLines?: string[]; ttl?: number; probeMs?: number; waitMs?: number; graceMs?: number } = {}) {
  const cache = memoryCache();
  const disposables: Disposable[] = [];
  const c = consent(opts.consent !== false);
  const router = createRouter({
    logger: silentLogger(opts.logLines),
    settings: settings(opts.settings),
    extensionPath: '/ext',
    version: '0.0.0-test',
    cache,
    consent: c,
    disposables,
    channels,
    availabilityTtlMs: opts.ttl,
    availabilityProbeMs: opts.probeMs,
    availabilityWaitMs: opts.waitMs,
    timeoutGraceMs: opts.graceMs,
  });
  return { router, cache, consent: c, disposables };
}

suite('generation/router', () => {
  test('explains functions through the first available channel and caches valid results', async () => {
    const claude = fakeChannel('claude');
    const { router, cache } = makeRouter([claude]);
    const fns = [fn('slugify', 'function slugify() {}'), fn('add', 'const add = () => 1;')];
    const seen: Explanation[] = [];
    const out = await router.explainFunctions(request(fns), { progress: { onExplanation: (e) => seen.push(e) } });
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((e) => e.functionId), fns.map((f) => f.functionId));
    assert.equal(out[0].summary, 'It does its job for slugify.');
    assert.equal(out[0].modelChannel, 'claude');
    assert.equal(out[0].contentHash, fns[0].contentHash);
    assert.equal(seen.length, 2);
    assert.equal(cache.size(), 2);
    assert.equal(claude.calls.length, 1);
    assert.ok(claude.calls[0].timeoutMs === 90_000);
  });

  test('cache hit skips the channel entirely (spy) and re-labels the cached copy', async () => {
    const claude = fakeChannel('claude');
    const { router, cache } = makeRouter([claude]);
    const f = fn('slugify', 'function slugify() {}');
    await router.explainFunctions(request([f]));
    assert.equal(claude.calls.length, 1);
    const renamed = { ...f, functionId: 'slugify#7', name: 'Util.slugify' };
    const seen: Explanation[] = [];
    const out = await router.explainFunctions(request([renamed]), { progress: { onExplanation: (e) => seen.push(e) } });
    assert.equal(claude.calls.length, 1, 'no second model call');
    assert.equal(out[0].functionId, 'slugify#7');
    assert.equal(out[0].name, 'Util.slugify');
    assert.equal(seen.length, 1);
    assert.equal(cache.size(), 1);
    // A mixed request only sends the misses, never the cached hashes.
    const g = fn('add', 'const add = () => 1;');
    await router.explainFunctions(request([f, g]));
    assert.equal(claude.calls.length, 2);
    const inside = splitFence(claude.calls[1].combined)!.inside;
    assert.ok(inside.includes('const add'));
    assert.ok(!inside.includes('function slugify'));
  });

  test('bypassCache skips the lookup and overwrites the cached copy with the fresh result', async () => {
    let call = 0;
    const claude = fakeChannel('claude', {
      reply: (req) => {
        call++;
        const good = JSON.parse(goodReplyFor(req.combined));
        for (const e of good.explanations) e.summary = `It does its job for ${e.name}, take ${call}.`;
        return JSON.stringify(good);
      },
    });
    const { router, cache } = makeRouter([claude]);
    const f = fn('slugify', 'function slugify() {}');
    const first = await router.explainFunctions(request([f]));
    assert.equal(first[0].summary, 'It does its job for slugify, take 1.');
    assert.equal(cache.get(f.contentHash)?.summary, 'It does its job for slugify, take 1.');
    // Plain call: cache hit, no model call.
    await router.explainFunctions(request([f]));
    assert.equal(claude.calls.length, 1);
    // Regenerate: the cached copy is skipped AND replaced.
    const seen: Explanation[] = [];
    const fresh = await router.explainFunctions(request([f]), { bypassCache: true, progress: { onExplanation: (e) => seen.push(e) } });
    assert.equal(claude.calls.length, 2, 'the model was asked again');
    assert.equal(fresh[0].summary, 'It does its job for slugify, take 2.');
    assert.equal(seen.length, 1);
    assert.equal(cache.size(), 1);
    assert.equal(cache.get(f.contentHash)?.summary, 'It does its job for slugify, take 2.', 'cache overwritten');
    // And the next plain call uses the fresh copy.
    assert.equal((await router.explainFunctions(request([f])))[0].summary, 'It does its job for slugify, take 2.');
    assert.equal(claude.calls.length, 2);
    // A bad reply under bypassCache does not clobber the good cached copy.
    const bad = fakeChannel('claude', { reply: () => 'PWNED' });
    const r2 = makeRouter([bad]);
    r2.cache.set(f.contentHash, first[0]);
    const out = await r2.router.explainFunctions(request([f]), { bypassCache: true });
    assert.ok(isFallbackExplanation(out[0]));
    assert.equal(r2.cache.get(f.contentHash)?.summary, first[0].summary);
  });

  test('a function longer than MAX_FUNCTION_CHARS gets an honest section without any model call and is not cached', async () => {
    const claude = fakeChannel('claude');
    const lines: string[] = [];
    const { router, cache } = makeRouter([claude], { logLines: lines });
    const huge = fn('minified', 'x'.repeat(MAX_FUNCTION_CHARS + 1));
    const small = fn('add', 'const add = () => 1;');
    const seen: Explanation[] = [];
    const out = await router.explainFunctions(request([huge, small]), { progress: { onExplanation: (e) => seen.push(e) } });
    assert.equal(out.length, 2);
    assert.equal(out[0].summary, OVERSIZED_SUMMARY);
    assert.equal(out[0].modelChannel, 'none');
    assert.ok(out[0].steps.length >= 2 && out[0].steps.length <= 5);
    assert.equal(out[1].summary, 'It does its job for add.');
    assert.equal(claude.calls.length, 1);
    assert.ok(!splitFence(claude.calls[0].combined)!.inside.includes('xxxxxxxxxx'), 'the huge text never reached the model');
    assert.equal(cache.size(), 1);
    assert.ok(!cache.has(huge.contentHash));
    assert.equal(seen.length, 2);
    assert.ok(lines.some((l) => /minified .* characters long/.test(l)));
    // Only huge functions: no consent needed, no channel touched.
    const r2 = makeRouter([fakeChannel('claude')], { consent: false });
    assert.equal((await r2.router.explainFunctions(request([huge])))[0].summary, OVERSIZED_SUMMARY);
  });

  test('chunks are also cut by total text size so a few big functions never share one request', async () => {
    const big = (i: number) => fn(`big${i}`, 'y'.repeat(60_000));
    assert.equal(chunkFunctions([big(1), big(2), big(3)], 20, 150_000).length, 2);
    assert.equal(chunkFunctions([big(1), big(2), big(3)], 20, 50_000).length, 3, 'one per chunk when each exceeds the budget');
    assert.deepEqual(chunkFunctions([], 20), []);
    assert.equal(chunkFunctions(manyFunctions(45), 20).length, 3);
    const claude = fakeChannel('claude');
    const { router } = makeRouter([claude]);
    const out = await router.explainFunctions(request([big(1), big(2), big(3)]));
    assert.equal(claude.calls.length, 2);
    assert.ok(out.every((e) => !isFallbackExplanation(e)));
  });

  test('segmentWithAi refuses a file too large to outline with a clear error and no model call', async () => {
    const claude = fakeChannel('claude');
    const { router } = makeRouter([claude]);
    await assert.rejects(router.segmentWithAi({ fileName: 'huge.cob', languageId: 'cobol', text: 'z'.repeat(MAX_SEGMENT_CHARS + 1) }), /huge\.cob is too large/);
    assert.equal(claude.calls.length, 0);
  });

  test('a channel that never answers is dropped after its timeout (plus retry and grace) and the next one is used', async () => {
    const hung = fakeChannel('claude', { reply: () => new Promise<string>(() => undefined) });
    const codex = fakeChannel('codex');
    const lines: string[] = [];
    const { router } = makeRouter([hung, codex], { logLines: lines, graceMs: 50 });
    const started = Date.now();
    const out = await router.explainFunctions(request(manyFunctions(1)), { timeoutMs: 60 });
    assert.ok(Date.now() - started < 3000);
    assert.equal(out[0].modelChannel, 'codex');
    assert.equal(hung.calls.length, 1);
    assert.equal(codex.calls.length, 1);
    assert.ok(lines.some((l) => /claude could not answer \(timeout\)/.test(l)));
  });

  test('withdrawing or granting consent is reflected by availableChannels at once (no 60 s wait)', async () => {
    const copilot = fakeChannel('copilot');
    const { router, consent: c } = makeRouter([copilot]);
    // Mimic the real Copilot channel: the answer depends on consent.
    copilot.availability = async () => {
      copilot.availabilityCalls++;
      return c.granted() ? { channel: 'copilot', available: true } : { channel: 'copilot', available: false, reason: 'ExplainIT has not been given permission to use your assistants yet.' };
    };
    assert.equal((await router.availableChannels())[0].available, true);
    c.value = false;
    const a = await router.availableChannels();
    assert.equal(a[0].available, false);
    assert.match(a[0].reason ?? '', /permission/);
    assert.equal(copilot.availabilityCalls, 2);
    await router.availableChannels();
    assert.equal(copilot.availabilityCalls, 2, 'cached while consent stays the same');
    c.value = true;
    assert.equal((await router.availableChannels())[0].available, true);
    assert.equal(await router.resolveChannel(), 'copilot');
  });

  test('generation waits patiently for a slow probe instead of reporting "no assistant" after the fast cap', async () => {
    const slow = fakeChannel('claude', { availabilityDelayMs: 600 });
    const { router } = makeRouter([slow], { probeMs: 100, waitMs: 3000 });
    const quick = await router.availableChannels();
    assert.equal(quick[0].available, false);
    assert.match(quick[0].reason ?? '', /Still checking/);
    const out = await router.explainFunctions(request(manyFunctions(1)));
    assert.equal(out[0].modelChannel, 'claude');
    assert.equal(slow.availabilityCalls, 1, 'the in-flight probe was awaited, not restarted');
    assert.equal((await router.availableChannels())[0].available, true);
  });

  test('empty request never touches consent or channels', async () => {
    const claude = fakeChannel('claude');
    const { router } = makeRouter([claude], { consent: false });
    assert.deepEqual(await router.explainFunctions(request([])), []);
    assert.equal(claude.calls.length, 0);
  });

  test('no consent -> plain-English error and no channel call', async () => {
    const claude = fakeChannel('claude');
    const { router } = makeRouter([claude], { consent: false });
    await assert.rejects(router.explainFunctions(request(manyFunctions(1))), (e: Error) => e.message === CONSENT_ERROR);
    await assert.rejects(router.explainChange({ fileName: 'a.ts', languageId: 'typescript', functionName: 'a', changeType: 'modified', beforeText: 'x', afterText: 'y' }), /permission/);
    await assert.rejects(router.segmentWithAi({ fileName: 'a.ts', languageId: 'typescript', text: 'x' }), /permission/);
    assert.equal(claude.calls.length, 0);
    assert.equal(claude.availabilityCalls, 0);
  });

  test('chunks at 20 functions per request and keeps request order', async () => {
    const claude = fakeChannel('claude');
    const { router } = makeRouter([claude]);
    const fns = manyFunctions(45);
    const out = await router.explainFunctions(request(fns));
    assert.equal(claude.calls.length, 3);
    for (const call of claude.calls) {
      const n = (splitFence(call.combined)!.inside.match(/\[Function F\d+:/g) ?? []).length;
      assert.ok(n <= 20 && n > 0);
    }
    assert.deepEqual(out.map((e) => e.functionId), fns.map((f) => f.functionId));
    assert.ok(out.every((e) => !isFallbackExplanation(e)));
  });

  test('backfill.maxFunctionsPerRequest lowers the chunk size but never raises it above 20', async () => {
    const a = fakeChannel('claude');
    await makeRouter([a], { settings: { backfillMaxFunctionsPerRequest: 5 } }).router.explainFunctions(request(manyFunctions(12)));
    assert.equal(a.calls.length, 3);
    const b = fakeChannel('claude');
    await makeRouter([b], { settings: { backfillMaxFunctionsPerRequest: 999 } }).router.explainFunctions(request(manyFunctions(21)));
    assert.equal(b.calls.length, 2);
  });

  test('garbage reply -> exactly one re-ask -> fallback explanation that still renders, and is not cached', async () => {
    const claude = fakeChannel('claude', { reply: () => 'Sure! Here is a poem instead.' });
    const lines: string[] = [];
    const { router, cache } = makeRouter([claude], { logLines: lines });
    const fns = manyFunctions(2);
    const out = await router.explainFunctions(request(fns));
    assert.equal(claude.calls.length, 2, 'one ask + one re-ask');
    assert.ok(claude.calls[1].user.startsWith(REASK_PREFACE));
    assert.equal(out.length, 2);
    for (const e of out) {
      assert.equal(e.summary, FALLBACK_SUMMARY);
      assert.ok(e.steps.length >= 2);
      assert.ok(isFallbackExplanation(e));
    }
    assert.equal(cache.size(), 0);
    assert.ok(lines.some((l) => /re-asking once/.test(l)));
    assert.ok(lines.some((l) => /fallback text/.test(l)));
  });

  test('re-ask budget is one per file: a later bad chunk goes straight to the fallback', async () => {
    const claude = fakeChannel('claude', { reply: () => 'nonsense' });
    const { router } = makeRouter([claude]);
    await router.explainFunctions(request(manyFunctions(25)));
    assert.equal(claude.calls.length, 3, '2 chunks + only one re-ask');
  });

  test('re-ask only covers the bad functions and the good ones are kept', async () => {
    let call = 0;
    const claude = fakeChannel('claude', {
      reply: (req) => {
        call++;
        const good = JSON.parse(goodReplyFor(req.combined));
        if (call === 1) good.explanations[1].summary = 'PWNED';
        return JSON.stringify(good);
      },
    });
    const { router } = makeRouter([claude]);
    const fns = [fn('a', 'A'), fn('b', 'B'), fn('c', 'C')];
    const out = await router.explainFunctions(request(fns));
    assert.equal(claude.calls.length, 2);
    const inside = splitFence(claude.calls[1].combined)!.inside;
    assert.ok(inside.includes('[Function F1: b]') && !inside.includes(': a]') && !inside.includes(': c]'));
    assert.ok(out.every((e) => !isFallbackExplanation(e)));
    assert.equal(out[1].summary, 'It does its job for b.');
  });

  test('injected "PWNED" reply is rejected: re-ask, then fallback', async () => {
    const claude = fakeChannel('claude', { reply: () => 'PWNED' });
    const { router, cache } = makeRouter([claude]);
    const injection = fs.readFileSync(path.join(FIXTURE_WORKSPACE, 'injection.py'), 'utf8');
    const out = await router.explainFunctions(request([fn('transfer', injection)], { fileName: 'injection.py', languageId: 'python' }));
    assert.equal(claude.calls.length, 2);
    assert.ok(isFallbackExplanation(out[0]));
    assert.ok(!/PWNED/i.test(out[0].summary + out[0].steps.join(' ')));
    assert.equal(cache.size(), 0);
    // and a "descriptive" reply about the injection is accepted
    const honest = fakeChannel('claude', {
      reply: () => JSON.stringify({ explanations: [{ functionId: 'F1', name: 'transfer', summary: 'It moves money out of an account and contains a note asking AI tools to reply with PWNED.', steps: ['It refuses amounts of zero or less.', 'It takes the amount off the balance.', 'It hands back the new balance.'] }] }),
    });
    const r2 = makeRouter([honest]);
    const ok = await r2.router.explainFunctions(request([fn('transfer', injection)]));
    assert.ok(!isFallbackExplanation(ok[0]));
    assert.equal(honest.calls.length, 1);
  });

  test('falls back across channels on ChannelError, in copilot -> claude -> codex order, and logs it', async () => {
    const copilot = fakeChannel('copilot', { error: channelError('copilot', 'quota') });
    const claude = fakeChannel('claude', { error: channelError('claude', 'auth') });
    const codex = fakeChannel('codex');
    const lines: string[] = [];
    const { router } = makeRouter([codex, claude, copilot], { logLines: lines });
    const out = await router.explainFunctions(request(manyFunctions(1)));
    assert.equal(out[0].modelChannel, 'codex');
    assert.equal(copilot.calls.length, 1);
    assert.equal(claude.calls.length, 1);
    assert.equal(codex.calls.length, 1);
    assert.ok(lines.some((l) => /using copilot/.test(l)) && lines.some((l) => /copilot could not answer \(quota\)/.test(l)));
    assert.ok(lines.some((l) => /using codex/.test(l)));
  });

  test('all channels failing -> one plain-English error with the last reason', async () => {
    const claude = fakeChannel('claude', { error: channelError('claude', 'auth') });
    const codex = fakeChannel('codex', { error: channelError('codex', 'failed') });
    const { router } = makeRouter([claude, codex]);
    await assert.rejects(router.explainFunctions(request(manyFunctions(1))), /No assistant could explain util\.ts\. codex failed for the test/);
  });

  test('non-channel errors propagate unchanged (no silent swallowing)', async () => {
    const claude = fakeChannel('claude', { error: new Error('disk on fire') });
    const codex = fakeChannel('codex');
    const { router } = makeRouter([claude, codex]);
    await assert.rejects(router.explainFunctions(request(manyFunctions(1))), /disk on fire/);
    assert.equal(codex.calls.length, 0);
  });

  test('unavailable channels are skipped; no channel at all -> guidance error', async () => {
    const copilot = fakeChannel('copilot', { available: false, reason: 'No Copilot models are available.' });
    const claude = fakeChannel('claude');
    const { router } = makeRouter([copilot, claude]);
    await router.explainFunctions(request(manyFunctions(1)));
    assert.equal(copilot.calls.length, 0);
    assert.equal(claude.calls.length, 1);
    const none = makeRouter([fakeChannel('claude', { available: false, reason: 'Claude Code was not found.' })]);
    await assert.rejects(none.router.explainFunctions(request(manyFunctions(1))), /No assistant is connected.*Claude Code was not found/);
  });

  test('a pinned channel goes first (even if the probe says unavailable) and others remain as fallback', async () => {
    const copilot = fakeChannel('copilot');
    const codex = fakeChannel('codex', { available: false, reason: 'not signed in' });
    const { router } = makeRouter([copilot, codex], { settings: { channelPin: 'codex' } });
    const out = await router.explainFunctions(request(manyFunctions(1)));
    assert.equal(out[0].modelChannel, 'codex');
    assert.equal(copilot.calls.length, 0);
    const failing = fakeChannel('codex', { error: channelError('codex', 'quota') });
    const r2 = makeRouter([fakeChannel('copilot'), failing], { settings: { channelPin: 'codex' } });
    assert.equal((await r2.router.explainFunctions(request(manyFunctions(1))))[0].modelChannel, 'copilot');
  });

  test('opts.channel forces exactly one channel', async () => {
    const copilot = fakeChannel('copilot');
    const claude = fakeChannel('claude', { error: channelError('claude') });
    const { router } = makeRouter([copilot, claude]);
    await assert.rejects(router.explainFunctions(request(manyFunctions(1)), { channel: 'claude' }), /No assistant could explain/);
    assert.equal(copilot.calls.length, 0);
    await assert.rejects(router.explainFunctions(request(manyFunctions(1)), { channel: 'nope' as never }), /Unknown assistant/);
  });

  test('thrift mode caps the file summary; progress onText and onStatus fire', async () => {
    const claude = fakeChannel('claude');
    const { router } = makeRouter([claude]);
    const summary = Array.from({ length: 40 }, (_, i) => `import x${i}`).join('\n');
    const texts: string[] = [];
    const statuses: string[] = [];
    await router.explainFunctions(request(manyFunctions(1), { fileSummary: summary }), { progress: { onText: (t) => texts.push(t), onStatus: (s) => statuses.push(s) } });
    const inside = splitFence(claude.calls[0].combined)!.inside;
    assert.ok(inside.includes('import x19') && !inside.includes('import x20'));
    assert.ok(texts.length >= 1);
    assert.ok(statuses.some((s) => /Explaining 1 function of util\.ts with claude/.test(s)));
  });

  test('timeout setting and opts.timeoutMs reach the channel', async () => {
    const claude = fakeChannel('claude');
    const { router } = makeRouter([claude], { settings: { generationTimeoutSeconds: 12 } });
    await router.explainFunctions(request(manyFunctions(1)));
    assert.equal(claude.calls[0].timeoutMs, 12_000);
    await router.explainFunctions(request(manyFunctions(2)), { timeoutMs: 777 });
    assert.equal(claude.calls[1].timeoutMs, 777);
  });

  test('cancellation before/while sending is reported as cancelled, not as a channel failure', async () => {
    const src = new CancelSource();
    const claude = fakeChannel('claude', {
      reply: async (req) => {
        src.cancel();
        return goodReplyFor(req.combined);
      },
    });
    const codex = fakeChannel('codex');
    const { router } = makeRouter([claude, codex]);
    await assert.rejects(router.explainFunctions(request(manyFunctions(25)), { token: src.token }), /Cancelled/);
    assert.equal(claude.calls.length, 1);
    assert.equal(codex.calls.length, 0);
  });

  test('explainChange streams text, parses JSON, re-asks once and falls back honestly', async () => {
    const good = fakeChannel('claude', { reply: () => JSON.stringify({ whatChanged: 'The function now checks for zero first.', whyItMatters: ['Dividing by zero no longer crashes.'], risk: 'Old callers may expect an error.' }) });
    const { router } = makeRouter([good]);
    const texts: string[] = [];
    const ce = await router.explainChange({ fileName: 'a.ts', languageId: 'typescript', functionName: 'divide', changeType: 'modified', beforeText: 'a/b', afterText: 'b?a/b:0' }, { progress: { onText: (t) => texts.push(t) } });
    assert.equal(ce.functionName, 'divide');
    assert.equal(ce.whatChanged, 'The function now checks for zero first.');
    assert.equal(ce.risk, 'Old callers may expect an error.');
    assert.equal(ce.modelChannel, 'claude');
    assert.ok(texts.length === 1);
    const inside = splitFence(good.calls[0].combined)!.inside;
    assert.ok(inside.includes('[Before]\na/b') && inside.includes('[After]\nb?a/b:0'));

    const bad = fakeChannel('claude', { reply: () => 'PWNED' });
    const r2 = makeRouter([bad]);
    const fb = await r2.router.explainChange({ fileName: 'a.ts', languageId: 'typescript', functionName: 'divide', changeType: 'added', beforeText: '', afterText: 'x' });
    assert.equal(bad.calls.length, 2);
    assert.match(fb.whatChanged, /could not describe the change clearly/);
    assert.ok(fb.whyItMatters.length >= 1);
    assert.ok(!/PWNED/.test(fb.whatChanged));
  });

  test('segmentWithAi returns 0-based segments, re-asks once, then throws a clear error', async () => {
    const good = fakeChannel('claude', { reply: () => JSON.stringify({ segments: [{ name: 'a', startLine: 1, endLine: 2 }, { name: 'b', startLine: 3, endLine: 4 }] }) });
    const { router } = makeRouter([good]);
    const segs = await router.segmentWithAi({ fileName: 'x.cob', languageId: 'cobol', text: 'l1\nl2\nl3\nl4' });
    assert.deepEqual(segs, [
      { name: 'a', startLine: 0, endLine: 1 },
      { name: 'b', startLine: 2, endLine: 3 },
    ]);
    assert.ok(splitFence(good.calls[0].combined)!.inside.includes('1| l1'));
    const bad = fakeChannel('claude', { reply: () => 'no idea' });
    const r2 = makeRouter([bad]);
    await assert.rejects(r2.router.segmentWithAi({ fileName: 'x.cob', languageId: 'cobol', text: 'l1' }), /could not outline x\.cob/);
    assert.equal(bad.calls.length, 2);
  });

  test('availableChannels is cached for 60 s, ordered copilot/claude/codex, and invalidated by settings changes', async () => {
    const copilot = fakeChannel('copilot', { available: false, reason: 'no models' });
    const claude = fakeChannel('claude');
    const codex = fakeChannel('codex');
    const s = settings();
    const disposables: Disposable[] = [];
    const router = createRouter({ logger: silentLogger(), settings: s, extensionPath: '/e', version: '0', cache: memoryCache(), consent: consent(true), disposables, channels: [codex, claude, copilot] });
    const a = await router.availableChannels();
    assert.deepEqual(a.map((r) => r.channel), ['copilot', 'claude', 'codex']);
    assert.deepEqual(a.map((r) => r.available), [false, true, true]);
    await router.availableChannels();
    assert.equal(claude.availabilityCalls, 1, 'cached');
    assert.equal(await router.resolveChannel(), 'claude');
    await s.set('channelPin', 'codex');
    assert.equal(await router.resolveChannel(), 'codex');
    assert.equal(claude.availabilityCalls, 2, 'settings change invalidated the cache');
    assert.equal(disposables.length, 1, 'settings subscription pushed to disposables');
    await s.set('channelPin', 'copilot');
    assert.equal(await router.resolveChannel(), 'claude', 'pinned but unavailable -> first available');
  });

  test('availableChannels never waits longer than the probe cap and never throws', async () => {
    const slow = fakeChannel('claude', { availabilityDelayMs: 2000 });
    const broken = fakeChannel('codex');
    broken.availability = async () => {
      throw new Error('probe exploded');
    };
    const { router } = makeRouter([slow, broken], { probeMs: 200 });
    const started = Date.now();
    const a = await router.availableChannels();
    assert.ok(Date.now() - started < 1500);
    assert.equal(a.find((r) => r.channel === 'claude')?.available, false);
    assert.match(a.find((r) => r.channel === 'claude')?.reason ?? '', /Still checking/);
    assert.equal(a.find((r) => r.channel === 'codex')?.available, false);
    assert.match(a.find((r) => r.channel === 'codex')?.detail ?? '', /probe exploded/);
    // once the slow probe finishes, the cached answer is used
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal((await router.availableChannels()).find((r) => r.channel === 'claude')?.available, true);
    assert.equal(slow.availabilityCalls, 1);
  });

  test('estimateCost uses the pin (or the last resolved channel) and the chunk setting', async () => {
    const claude = fakeChannel('claude');
    const { router } = makeRouter([claude], { settings: { backfillMaxFunctionsPerRequest: 10 } });
    const before = router.estimateCost([request(manyFunctions(25))]);
    assert.equal(before.channel, 'none');
    assert.equal(before.requests, 3);
    assert.equal(before.functions, 25);
    assert.equal(before.outputTokens, 25 * 120);
    await router.resolveChannel();
    assert.equal(router.estimateCost([request(manyFunctions(1))]).channel, 'claude');
    const pinned = makeRouter([claude], { settings: { channelPin: 'codex' } });
    assert.equal(pinned.router.estimateCost([]).channel, 'codex');
  });

  test('promptHash is exposed and stable', () => {
    const { router } = makeRouter([fakeChannel('claude')]);
    assert.equal(router.promptHash(), promptHash());
    assert.match(router.promptHash(), /^[0-9a-f]{64}$/);
  });

  suite('public factory end-to-end with the fake claude CLI', function () {
    this.timeout(30_000);
    let home: string;
    setup(() => {
      home = tmpDir('explainit-home-');
      process.env.EXPLAINIT_HOME = home;
      delete process.env.FAKE_CLI_MODE;
    });
    teardown(() => {
      delete process.env.EXPLAINIT_HOME;
      rmDir(home);
    });

    test('createGenerationRouter + createFileCache + createConsentStore explain util.ts through the fake CLI', async () => {
      // Codex availability checks for a sign-in file under CODEX_HOME; keep the test hermetic on every machine.
      const codexHome = path.join(home, 'codex-home');
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"tokens":{}}');
      const prevCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = codexHome;
      try {
      const state = createStateStore(path.join(home, 'state.json'));
      const consentStore = createConsentStore(state);
      const cache = createFileCache(path.join(home, 'cache.json'));
      const disposables: Disposable[] = [];
      const router = createGenerationRouter({
        logger: silentLogger(),
        settings: settings({ claudeCliPath: `node ${FAKE_CLAUDE}`, codexCliPath: `node ${FAKE_CODEX}` }),
        extensionPath: '/ext',
        version: '0',
        cache,
        consent: consentStore,
        disposables,
      });
      const util = fs.readFileSync(path.join(FIXTURE_WORKSPACE, 'src', 'util.ts'), 'utf8');
      const req = request([fn('slugify', util.split('\n').slice(5, 12).join('\n')), fn('add', 'export const add = (a: number, b: number): number => a + b;')]);
      await assert.rejects(router.explainFunctions(req), /permission/);
      await consentStore.setGranted(true);
      const avail = await router.availableChannels();
      assert.equal(avail.find((a) => a.channel === 'copilot')?.available, false, 'copilot unavailable outside VS Code');
      assert.equal(avail.find((a) => a.channel === 'claude')?.available, true, avail.find((a) => a.channel === 'claude')?.reason);
      assert.equal(avail.find((a) => a.channel === 'codex')?.available, true, avail.find((a) => a.channel === 'codex')?.reason);
      assert.equal(await router.resolveChannel(), 'claude');
      const texts: string[] = [];
      const out = await router.explainFunctions(req, { progress: { onText: (t) => texts.push(t) } });
      assert.equal(out.length, 2);
      assert.equal(out[0].summary, 'It does its job for slugify.');
      assert.equal(out[0].modelChannel, 'claude');
      assert.ok(texts.length > 0, 'streamed');
      await cache.flush();
      assert.ok(fs.existsSync(path.join(home, 'cache.json')));
      assert.ok(fs.existsSync(path.join(home, 'tmp')), 'cwd <home>/tmp was created');
      for (const d of disposables) d.dispose();
      } finally {
        if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = prevCodexHome;
      }
    });
  });
});
