import * as assert from 'node:assert';
import { canonicalJson, contentHashOf, normalizeNewlines, randomId, randomToken, sha256, shortHash } from '../../../src/core/hash';

suite('core/hash', () => {
  test('sha256 and shortHash', () => {
    assert.strictEqual(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.strictEqual(shortHash('abc'), 'ba7816bf8f01');
  });
  test('contentHashOf ignores line endings and trailing whitespace', () => {
    assert.strictEqual(contentHashOf('a \r\nb\t\r\n'), contentHashOf('a\nb\n'));
    assert.notStrictEqual(contentHashOf('a\nb'), contentHashOf('a\nc'));
  });
  test('normalizeNewlines', () => {
    assert.strictEqual(normalizeNewlines('a\r\nb\rc\n'), 'a\nb\nc\n');
  });
  test('canonicalJson sorts keys deeply', () => {
    assert.strictEqual(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } }), '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  test('random helpers', () => {
    assert.strictEqual(randomToken().length, 64);
    assert.ok(/^req_[a-f0-9]{16}$/.test(randomId('req_')));
    assert.notStrictEqual(randomToken(), randomToken());
  });
});
