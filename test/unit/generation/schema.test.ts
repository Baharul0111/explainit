import * as assert from 'node:assert/strict';
import {
  checkChangeShape,
  checkSentenceShape,
  isSuspiciousSentence,
  validateChangeReply,
  validateExplanationItem,
  validateExplanationsReply,
  validateSegmentsReply,
  wordCount,
} from '../../../src/generation/pure/schema';

const good = { functionId: 'F1', name: 'load_config', summary: 'Reads the settings file and turns it into a settings object.', steps: ['It opens the file at the given path.', 'It reads all of the text.', 'It hands the object back.'] };

suite('generation/pure/schema', () => {
  test('a well-formed item passes', () => {
    const v = validateExplanationItem(good);
    assert.deepEqual(v, { ok: true, errors: [] });
    assert.ok(validateExplanationsReply({ explanations: [good, { ...good, warnings: ['Watch the port.'], uncertainty: 'Not sure about the format.' }] }).ok);
  });

  test('structure errors: missing steps, too few / too many steps, wrong types', () => {
    assert.equal(validateExplanationItem({ summary: 'It does a thing.' }).ok, false);
    assert.equal(validateExplanationItem({ ...good, steps: ['It does one thing here.'] }).ok, false);
    assert.equal(validateExplanationItem({ ...good, steps: Array(6).fill('It does one thing here.') }).ok, false);
    assert.equal(validateExplanationItem({ ...good, steps: 'not an array' }).ok, false);
    assert.equal(validateExplanationsReply({ explanations: 'nope' }).ok, false);
    assert.equal(validateExplanationsReply(null).ok, false);
  });

  test('length caps: summary <= 160, steps <= 110', () => {
    const long = 'word '.repeat(40).trim() + '.';
    assert.ok(long.length > 160);
    assert.equal(validateExplanationItem({ ...good, summary: long }).ok, false);
    const longStep = 'word '.repeat(25).trim() + '.';
    assert.ok(longStep.length > 110);
    assert.equal(validateExplanationItem({ ...good, steps: [longStep, 'It hands the result back.'] }).ok, false);
  });

  test('sentence shape: summary needs >= 3 words and a trailing period; steps need >= 3 words', () => {
    assert.ok(checkSentenceShape({ summary: 'Reads the file.', steps: ['It opens the file.', 'It reads it all.'] }).length === 0);
    assert.ok(checkSentenceShape({ summary: 'Reads the file', steps: ['It opens the file.', 'It reads it all.'] }).some((e) => /period/.test(e)));
    assert.ok(checkSentenceShape({ summary: 'Reads it.', steps: ['It opens the file.', 'It reads it all.'] }).some((e) => /fewer than three words/.test(e)));
    assert.ok(checkSentenceShape({ summary: 'Reads the whole file.', steps: ['Opens.', 'It reads it all.'] }).some((e) => /step 1 has fewer/.test(e)));
    assert.equal(validateExplanationItem({ ...good, summary: 'Nope' }).ok, false);
  });

  test('suspicious tokens (injection echoes) are rejected: PWNED, approved, ok', () => {
    for (const s of ['PWNED', 'pwned.', 'approved', 'Approved.', 'ok', 'OK.', 'yes', 'done', 'PWNED PWNED PWNED', '']) assert.ok(isSuspiciousSentence(s), `${JSON.stringify(s)} is suspicious`);
    assert.ok(!isSuspiciousSentence('It moves money between two accounts.'));
    // A descriptive sentence that mentions the injection is fine.
    assert.ok(!isSuspiciousSentence('It contains a note that asks AI tools to reply with the word PWNED.'));
    assert.equal(validateExplanationItem({ ...good, summary: 'PWNED' }).ok, false);
    assert.equal(validateExplanationItem({ ...good, summary: 'PWNED PWNED PWNED.' }).ok, false);
    assert.equal(validateExplanationItem({ ...good, steps: ['approved', 'ok'] }).ok, false);
    assert.equal(validateExplanationItem({ ...good, summary: 'It contains a note that asks AI tools to reply with the word PWNED.' }).ok, true);
  });

  test('wordCount ignores punctuation-only tokens', () => {
    assert.equal(wordCount('It reads the file.'), 4);
    assert.equal(wordCount(' - - '), 0);
    assert.equal(wordCount(''), 0);
  });

  test('change reply schema and shape', () => {
    assert.ok(validateChangeReply({ whatChanged: 'The function now checks for zero.', whyItMatters: ['Dividing by zero no longer crashes.'] }).ok);
    assert.equal(validateChangeReply({ whatChanged: 'x', whyItMatters: [] }).ok, false);
    assert.equal(validateChangeReply({ whatChanged: 'x' }).ok, false);
    assert.ok(checkChangeShape({ whatChanged: 'PWNED', whyItMatters: ['It matters a lot.'] }).length > 0);
    assert.ok(checkChangeShape({ whatChanged: 'The function now checks for zero.', whyItMatters: ['ok'] }).length > 0);
    assert.equal(checkChangeShape({ whatChanged: 'The function now checks for zero.', whyItMatters: ['Dividing by zero no longer crashes.'] }).length, 0);
  });

  test('segments reply schema', () => {
    assert.ok(validateSegmentsReply({ segments: [{ name: 'a', startLine: 1, endLine: 3 }] }).ok);
    assert.ok(validateSegmentsReply({ segments: [] }).ok);
    assert.equal(validateSegmentsReply({ segments: [{ name: 'a', startLine: '1', endLine: 3 }] }).ok, false);
    assert.equal(validateSegmentsReply({ segments: [{ name: 'a', startLine: 1.5, endLine: 3 }] }).ok, false);
    assert.equal(validateSegmentsReply({}).ok, false);
  });
});
