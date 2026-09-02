import * as assert from 'node:assert/strict';
import { CONSENT_SENTENCE, FORBIDDEN_WORDS, MESSAGES, msg, placeholdersOf, describeError, withSignInHint, type MessageKey } from '../../../src/ux/pure/messages';

suite('ux/pure/messages', () => {
  const keys = Object.keys(MESSAGES) as MessageKey[];

  test('catalog is not empty and every key has a non-empty plain-English string', () => {
    assert.ok(keys.length >= 40, `expected a full catalog, got ${keys.length}`);
    for (const k of keys) {
      const v = MESSAGES[k];
      assert.equal(typeof v, 'string', `${k} must be a string`);
      assert.ok(v.trim().length >= 15, `${k} is too short to be helpful: "${v}"`);
      // A trailing placeholder is fine when the caller fills it with full sentences (e.g. next steps).
      assert.ok(/[.!?)}]$/.test(v.trim()), `${k} should end like a sentence: "${v}"`);
    }
  });

  test('no message contains programmer words like undefined/null/NaN', () => {
    for (const k of keys) {
      for (const w of FORBIDDEN_WORDS) assert.ok(!MESSAGES[k].includes(w), `${k} contains "${w}"`);
    }
  });

  test('covers every required empty/loading/error state', () => {
    const required: MessageKey[] = [
      'noAssistantConnected',
      'explanationLoading',
      'explanationFailed',
      'twinUnsupportedFile',
      'backfillNothingToDo',
      'backfillPaused',
      'gateNotResponding',
      'restoreSucceeded',
      'restoreFailed',
      'journalTamper',
      'pausedBanner',
    ];
    for (const k of required) assert.ok(k in MESSAGES, `missing ${k}`);
  });

  test('each message says what to do next when it reports a problem', () => {
    const problemKeys = keys.filter((k) => /Failed|NotResponding|Tamper|Unsupported|Missing|NotGranted|noAssistant/i.test(k));
    assert.ok(problemKeys.length >= 8);
    for (const k of problemKeys) {
      assert.ok(/Run|Try|Reload|Check|Install|Open|Put|Keep|Free|Restart|Start|Use|Save/.test(MESSAGES[k]), `${k} should tell the person what to do next: "${MESSAGES[k]}"`);
    }
  });

  test('consent sentence is verbatim and included in the onboarding body', () => {
    assert.equal(
      CONSENT_SENTENCE,
      'Your code goes only to the assistants you already use, under your existing agreements. ExplainIT ships no model, holds no keys, runs no server and sends no telemetry.',
    );
    assert.ok(MESSAGES.onboardingBody.includes(CONSENT_SENTENCE));
  });

  test('paused banner text is exactly what the spec requires', () => {
    assert.equal(MESSAGES.pausedBanner, 'ExplainIT checkpoint is paused. Assistants are using their own prompts.');
  });

  test('msg() fills placeholders and never renders "undefined"', () => {
    assert.equal(msg('restoreSucceeded', { file: 'app.py' }), 'Restored app.py. A safety restore point of the previous content was saved first.');
    const partial = msg('restoreFailed', { file: 'app.py' });
    assert.ok(!partial.includes('undefined'));
    assert.ok(partial.includes('{detail}'), 'unknown placeholders stay visible rather than becoming undefined');
    assert.equal(msg('backfillPaused', { done: 3, total: 10 }), 'Backfill is paused after 3 of 10 files. Run "ExplainIT: Resume backfill" to continue.');
  });

  test('placeholders are balanced and discoverable', () => {
    for (const k of keys) {
      const opens = (MESSAGES[k].match(/\{/g) ?? []).length;
      const closes = (MESSAGES[k].match(/\}/g) ?? []).length;
      assert.equal(opens, closes, `${k} has unbalanced braces`);
      assert.equal(placeholdersOf(k).length, new Set(MESSAGES[k].match(/\{(\w+)\}/g) ?? []).size);
    }
    assert.deepEqual(placeholdersOf('restoreFailed').sort(), ['detail', 'file']);
  });

  test('codex trust step names the exact terminal steps and says the VS Code extension shares the record', () => {
    assert.match(MESSAGES.codexTrustStep, /open codex in a terminal once/i);
    assert.match(MESSAGES.codexTrustStep, /choose Trust/);
    assert.match(MESSAGES.codexTrustStep, /\/hooks/);
    assert.match(MESSAGES.codexTrustStep, /VS Code extension uses the same trust record/);
  });

  test('withSignInHint appends the "codex login" hint once for revoked-sign-in messages and leaves others alone', () => {
    const a = withSignInHint('Codex could not answer: refresh token was revoked');
    assert.ok(a.endsWith(MESSAGES.codexSignInHint), a);
    assert.ok(a.includes('codex login'));
    assert.equal(withSignInHint(a), a, 'never appended twice');
    assert.ok(withSignInHint('Please log out and sign in again.').includes('codex login'));
    assert.ok(withSignInHint('please logout and sign in again').includes('codex login'));
    assert.equal(withSignInHint('disk full.'), 'disk full.');
    assert.equal(withSignInHint(''), '');
  });

  test('describeError makes a sentence out of anything', () => {
    assert.equal(describeError(new Error('disk full')), 'disk full.');
    assert.equal(describeError('already ends.'), 'already ends.');
    assert.equal(describeError(undefined), 'an unknown error occurred.');
    assert.equal(describeError(new Error('   ')), 'an unknown error occurred.');
    assert.equal(describeError(new Error('a\n  b')), 'a b.');
  });
});
