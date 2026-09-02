/**
 * Deterministic CI style test (REQ-020): the style checker against recorded explanations in
 * eval/fixtures/explanations.json, plus unit cases for every rule. No model, no network.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { BANNED_JARGON } from '../src/generation';
import { EVAL_PATHS } from './paths';
import { STYLE_BANNED_WORDS, checkStyle, countSentences, findBannedWords, styleScore } from './style';

interface Fixture {
  id: string;
  name: string;
  expectedStyleOk: boolean;
  why?: string;
  explanation: { summary: string; steps: string[]; warnings?: string[] };
}

function loadFixtures(): Fixture[] {
  const raw = fs.readFileSync(EVAL_PATHS.styleFixtures(), 'utf8');
  const parsed = JSON.parse(raw) as { explanations: Fixture[] };
  return parsed.explanations;
}

suite('eval/style: recorded fixtures', () => {
  const fixtures = loadFixtures();

  test('there are at least 12 recorded explanations and some deliberately bad ones', () => {
    assert.ok(fixtures.length >= 12, `expected >= 12 fixtures, got ${fixtures.length}`);
    assert.ok(fixtures.filter((f) => f.expectedStyleOk).length >= 12, 'expected >= 12 well-formed fixtures');
    assert.ok(fixtures.filter((f) => !f.expectedStyleOk).length >= 3, 'expected a few deliberately bad fixtures');
    const ids = new Set(fixtures.map((f) => f.id));
    assert.strictEqual(ids.size, fixtures.length, 'fixture ids must be unique');
  });

  for (const f of loadFixtures()) {
    test(`${f.id} -> ${f.expectedStyleOk ? 'ok' : 'rejected'}${f.why ? ` (${f.why})` : ''}`, () => {
      const r = checkStyle(f.explanation);
      assert.strictEqual(r.ok, f.expectedStyleOk, `problems: ${r.problems.join(' | ')}`);
      if (!f.expectedStyleOk) assert.ok(r.problems.length > 0, 'a rejected explanation must say why');
      else assert.deepStrictEqual(r.problems, []);
    });
  }

  test('styleScore over the fixtures equals the share of good ones', () => {
    const expected = fixtures.filter((f) => f.expectedStyleOk).length / fixtures.length;
    assert.strictEqual(styleScore(fixtures.map((f) => f.explanation)), expected);
  });
});

suite('eval/style: rules', () => {
  const good = { summary: 'Adds two numbers together.', steps: ['It takes the two numbers.', 'It gives back their sum.'] };

  test('the banned-word list matches the one the prompts use', () => {
    assert.deepStrictEqual([...STYLE_BANNED_WORDS], [...BANNED_JARGON]);
  });

  test('a well-formed explanation passes', () => {
    assert.deepStrictEqual(checkStyle(good), { ok: true, problems: [] });
  });

  test('missing or malformed input is a failure, never a crash', () => {
    assert.strictEqual(checkStyle(undefined).ok, false);
    assert.strictEqual(checkStyle(null).ok, false);
    assert.strictEqual(checkStyle({} as never).ok, false);
    assert.strictEqual(checkStyle({ summary: 42, steps: 'x' } as never).ok, false);
    assert.strictEqual(checkStyle({ summary: 'Does a thing.', steps: [null, 3] } as never).ok, false);
  });

  test('summary must end with a period', () => {
    const r = checkStyle({ ...good, summary: 'Adds two numbers together' });
    assert.ok(!r.ok && r.problems.some((p) => /does not end with a period/.test(p)));
  });

  test('summary must be one sentence', () => {
    const r = checkStyle({ ...good, summary: 'Adds numbers. It is quick.' });
    assert.ok(!r.ok && r.problems.some((p) => /2 sentences/.test(p)));
    // Decimal points and abbreviations that are not followed by whitespace do not split a sentence.
    assert.ok(checkStyle({ ...good, summary: 'Rounds a value such as 2.5 to the nearest whole number.' }).ok);
  });

  test('length caps: summary 160, steps 110', () => {
    const long = 'x'.repeat(161) + '.';
    assert.ok(checkStyle({ ...good, summary: long }).problems.some((p) => /limit is 160/.test(p)));
    const okLen = 'a '.repeat(79) + 'b.'; // 160 chars
    assert.strictEqual(okLen.length, 160);
    assert.ok(checkStyle({ ...good, summary: okLen }).ok);
    const longStep = 'It ' + 'goes '.repeat(22) + 'on.';
    assert.ok(longStep.length > 110);
    assert.ok(checkStyle({ ...good, steps: [good.steps[0], longStep] }).problems.some((p) => /Step 2 is .* limit is 110/.test(p)));
  });

  test('two to five steps', () => {
    assert.ok(checkStyle({ ...good, steps: ['It runs.'] }).problems.some((p) => /1 steps/.test(p)));
    assert.ok(checkStyle({ ...good, steps: [] }).problems.some((p) => /0 steps/.test(p)));
    const six = Array.from({ length: 6 }, (_, i) => `It does step ${i + 1}.`);
    assert.ok(checkStyle({ ...good, steps: six }).problems.some((p) => /6 steps/.test(p)));
    const five = six.slice(0, 5);
    assert.ok(checkStyle({ ...good, steps: five }).ok);
  });

  test('banned jargon is matched as whole words, case-insensitively', () => {
    assert.deepStrictEqual(findBannedWords('It parses the file and then Iterates.'), ['iterates', 'parses']);
    assert.deepStrictEqual(findBannedWords('It compares the disclosure sparsely.'), []);
    const r = checkStyle({ ...good, steps: ['It calls the callback.', 'It gives back the sum.'] });
    assert.ok(!r.ok && r.problems.some((p) => /banned jargon: callback/.test(p)));
    // A custom list can be supplied.
    assert.ok(checkStyle({ ...good, steps: ['It calls the callback.', 'It gives back the sum.'] }, { bannedWords: ['zzz'] }).ok);
  });

  test('code symbols and backticks are rejected', () => {
    assert.ok(!checkStyle({ ...good, steps: ['It calls `add`.', 'It gives back the sum.'] }).ok);
    assert.ok(!checkStyle({ ...good, summary: 'Maps a -> b.' }).ok);
    assert.ok(!checkStyle({ ...good, steps: ['It checks x == y.', 'It gives back the sum.'] }).ok);
  });

  test('countSentences', () => {
    assert.strictEqual(countSentences(''), 0);
    assert.strictEqual(countSentences('One.'), 1);
    assert.strictEqual(countSentences('One. Two.'), 2);
    assert.strictEqual(countSentences('Is it? Yes! Done.'), 3);
    assert.strictEqual(countSentences('Version 1.2.3 is out.'), 1);
  });

  test('styleScore of an empty list is 0', () => {
    assert.strictEqual(styleScore([]), 0);
    assert.strictEqual(styleScore([good, undefined]), 0.5);
  });
});
