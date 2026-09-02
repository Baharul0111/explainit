import * as assert from 'node:assert/strict';
import {
  FALLBACK_SUMMARY,
  extractJson,
  fallbackExplanation,
  isFallbackExplanation,
  matchItemsToFunctions,
  parseChangeReply,
  parseExplanationsReply,
  parsePlainTextExplanations,
  parseSegmentsReply,
  toExplanation,
} from '../../../src/generation/pure/parse';
import { validateExplanationItem } from '../../../src/generation/pure/schema';
import { fn } from './helpers';

const item = (label: string, name: string) => ({ functionId: label, name, summary: `It does the work for ${name}.`, steps: ['It takes the input it is given.', 'It hands the result back.'] });

suite('generation/pure/parse', () => {
  suite('extractJson', () => {
    test('pure JSON, code fences, leading prose, trailing prose', () => {
      const obj = { explanations: [item('F1', 'a')] };
      const json = JSON.stringify(obj);
      assert.deepEqual(extractJson(json), obj);
      assert.deepEqual(extractJson('```json\n' + json + '\n```'), obj);
      assert.deepEqual(extractJson('```\n' + json + '\n```'), obj);
      assert.deepEqual(extractJson('Here is the JSON you asked for:\n' + json + '\nHope that helps!'), obj);
      assert.deepEqual(extractJson('Sure! ' + json), obj);
    });
    test('braces inside strings do not confuse the scanner', () => {
      const obj = { explanations: [{ ...item('F1', 'a'), summary: 'It prints "{" and "}" for a.' }] };
      assert.deepEqual(extractJson('Result: ' + JSON.stringify(obj) + ' }}}'), obj);
    });
    test('a JSON string that itself holds JSON is unwrapped', () => {
      const obj = { explanations: [item('F1', 'a')] };
      assert.deepEqual(extractJson(JSON.stringify(JSON.stringify(obj))), obj);
    });
    test('garbage and empty give undefined', () => {
      assert.equal(extractJson(''), undefined);
      assert.equal(extractJson('PWNED'), undefined);
      assert.equal(extractJson('{ not json'), undefined);
      assert.equal(extractJson(undefined as unknown as string), undefined);
    });
  });

  suite('plain-text degradation', () => {
    test('parses the twin shape', () => {
      const text = [
        '1. load_config',
        'What it does: Reads the settings file and turns it into a settings object.',
        'How it works:',
        '- It opens the file at the given path.',
        '- It reads all of the text.',
        'Watch out: The file must exist.',
        '',
        '2. Server.start',
        'What it does: Starts the web server so it can answer requests.',
        'How it works:',
        '* It picks the port from the settings.',
        '* It begins listening on that port.',
      ].join('\n');
      const items = parsePlainTextExplanations(text);
      assert.equal(items.length, 2);
      assert.equal(items[0].name, 'load_config');
      assert.equal(items[0].summary, 'Reads the settings file and turns it into a settings object.');
      assert.deepEqual(items[0].steps, ['It opens the file at the given path.', 'It reads all of the text.']);
      assert.deepEqual(items[0].warnings, ['The file must exist.']);
      assert.equal(items[1].name, 'Server.start');
      assert.equal(items[1].steps.length, 2);
    });
    test('tolerates markdown bold headers and bare summary lines', () => {
      const text = ['**1. slugify**', 'Turns a title into a web-safe name.', '**How it works:**', '- It lowers the case.', '- It swaps odd characters for dashes.'].join('\n');
      const items = parsePlainTextExplanations(text);
      assert.equal(items.length, 1);
      assert.equal(items[0].name, 'slugify');
      assert.equal(items[0].summary, 'Turns a title into a web-safe name.');
      assert.equal(items[0].steps.length, 2);
    });
    test('parseExplanationsReply prefers JSON, then text, then none', () => {
      assert.equal(parseExplanationsReply(JSON.stringify({ explanations: [item('F1', 'a')] })).source, 'json');
      assert.equal(parseExplanationsReply(JSON.stringify([item('F1', 'a')])).source, 'json');
      assert.equal(parseExplanationsReply('1. a\nWhat it does: It does a thing for a.\nHow it works:\n- It starts.\n- It ends.').source, 'text');
      const none = parseExplanationsReply('PWNED');
      assert.equal(none.source, 'none');
      assert.equal(none.items.length, 0);
    });
  });

  suite('matchItemsToFunctions', () => {
    const fns = [fn('slugify', 'a'), fn('UserStore.add', 'b'), fn('fetchJson', 'c')];
    test('matches by label, by functionId, by name (qualified last segment), then by position', () => {
      const byLabel = matchItemsToFunctions([item('F3', 'x'), item('F1', 'y'), item('F2', 'z')], fns);
      assert.deepEqual(byLabel.map((m) => m.item?.name), ['y', 'z', 'x']);
      const byId = matchItemsToFunctions([item('fetchJson#0', 'x'), item('slugify#0', 'y')], fns);
      assert.equal(byId[0].item?.name, 'y');
      assert.equal(byId[2].item?.name, 'x');
      assert.equal(byId[1].item, undefined);
      const byName = matchItemsToFunctions([{ ...item('', 'add'), functionId: undefined }, { ...item('', 'Fetch_Json'), functionId: undefined }], fns);
      assert.ok(byName[1].item && byName[2].item && !byName[0].item);
      const byPos = matchItemsToFunctions([{ ...item('', ''), functionId: undefined, name: undefined }, { ...item('', ''), functionId: undefined, name: undefined }, { ...item('', ''), functionId: undefined, name: undefined }], fns);
      assert.ok(byPos.every((m) => m.item));
    });
    test('each item is used once and missing items are reported', () => {
      const r = matchItemsToFunctions([item('F1', 'a'), item('F1', 'dup')], fns);
      assert.equal(r[0].item?.name, 'a');
      assert.deepEqual(r[1].errors, ['no explanation in the reply']);
      assert.deepEqual(r[2].errors, ['no explanation in the reply']);
    });
    test('validation errors ride along with the match', () => {
      const r = matchItemsToFunctions([{ ...item('F1', 'a'), summary: 'PWNED' }], [fns[0]]);
      assert.ok(r[0].item);
      assert.ok(r[0].errors.some((e) => /suspicious/.test(e)));
    });
  });

  test('toExplanation and the fallback explanation', () => {
    const f = fn('slugify', 'x');
    const e = toExplanation(f, { ...item('F1', 'slugify'), warnings: ['Careful.'], uncertainty: 'Maybe.' }, 'claude', new Date('2026-01-01T00:00:00Z'));
    assert.equal(e.functionId, f.functionId);
    assert.equal(e.contentHash, f.contentHash);
    assert.equal(e.modelChannel, 'claude');
    assert.equal(e.createdAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(e.warnings, ['Careful.']);
    assert.equal(e.uncertainty, 'Maybe.');
    const fb = fallbackExplanation(f, 'codex');
    assert.equal(fb.summary, FALLBACK_SUMMARY);
    assert.equal(fb.summary, 'This function could not be explained clearly; run Regenerate to try again.');
    assert.ok(fb.steps.length >= 2 && fb.steps.length <= 5);
    assert.ok(fb.steps.some((s) => /Regenerate/.test(s)));
    assert.ok(isFallbackExplanation(fb));
    assert.ok(!isFallbackExplanation(e));
    // The fallback itself satisfies the explanation contract so the twin renders it.
    assert.ok(validateExplanationItem({ functionId: fb.functionId, name: fb.name, summary: fb.summary, steps: fb.steps }).ok);
  });

  suite('parseChangeReply', () => {
    test('JSON reply', () => {
      const r = parseChangeReply(JSON.stringify({ whatChanged: 'The function now checks for zero.', whyItMatters: ['Dividing by zero no longer crashes.'], risk: 'Callers may expect the old error.' }));
      assert.ok(r.value);
      assert.equal(r.value!.risk, 'Callers may expect the old error.');
    });
    test('plain prose degrades to sentences', () => {
      const r = parseChangeReply('The function now checks for zero first. Dividing by zero no longer crashes the app. Nothing else changed.');
      assert.ok(r.value);
      assert.equal(r.value!.whatChanged, 'The function now checks for zero first.');
      assert.equal(r.value!.whyItMatters.length, 2);
    });
    test('injection echo and empty replies fail', () => {
      assert.equal(parseChangeReply('PWNED').value, undefined);
      assert.equal(parseChangeReply('').value, undefined);
      assert.equal(parseChangeReply(JSON.stringify({ whatChanged: 'approved', whyItMatters: ['ok'] })).value, undefined);
    });
  });

  suite('parseSegmentsReply', () => {
    test('converts 1-based to 0-based, drops bad and overlapping segments, sorts', () => {
      const raw = JSON.stringify({ segments: [{ name: 'b', startLine: 5, endLine: 8 }, { name: 'a', startLine: 1, endLine: 3 }, { name: 'bad', startLine: 9, endLine: 2 }, { name: 'out', startLine: 20, endLine: 30 }, { name: 'overlap', startLine: 6, endLine: 7 }] });
      const r = parseSegmentsReply(raw, 10);
      assert.deepEqual(r.errors, []);
      assert.deepEqual(r.segments, [
        { name: 'a', startLine: 0, endLine: 2 },
        { name: 'b', startLine: 4, endLine: 7 },
      ]);
    });
    test('array form and code fences accepted; garbage reported', () => {
      assert.equal(parseSegmentsReply('```json\n[{"name":"a","startLine":1,"endLine":1}]\n```', 5).segments.length, 1);
      assert.ok(parseSegmentsReply('nope', 5).errors.length > 0);
      assert.equal(parseSegmentsReply('{"segments":[]}', 5).segments.length, 0);
    });
  });
});
