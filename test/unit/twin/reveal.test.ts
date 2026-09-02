import * as assert from 'node:assert';
import { revealLineFor, revealPaddingLines } from '../../../src/twin/pure/reveal';

suite('twin/pure/reveal (VS Code reveal padding prediction)', () => {
  test('defaults: sticky scroll on with maxLineCount 5 gives 5 lines of padding', () => {
    assert.strictEqual(revealPaddingLines({ stickyScrollEnabled: true, stickyMaxLineCount: 5, cursorSurroundingLines: 0, viewportLines: 40 }), 5);
  });
  test('sticky scroll off gives no padding unless cursorSurroundingLines asks for it', () => {
    assert.strictEqual(revealPaddingLines({ stickyScrollEnabled: false, stickyMaxLineCount: 5, cursorSurroundingLines: 0, viewportLines: 40 }), 0);
    assert.strictEqual(revealPaddingLines({ stickyScrollEnabled: false, stickyMaxLineCount: 5, cursorSurroundingLines: 8, viewportLines: 40 }), 8);
  });
  test('a tiny viewport caps the padding at half the viewport (rounded up)', () => {
    assert.strictEqual(revealPaddingLines({ stickyScrollEnabled: true, stickyMaxLineCount: 5, cursorSurroundingLines: 0, viewportLines: 7 }), 4);
  });
  test('nonsense inputs give no padding', () => {
    assert.strictEqual(revealPaddingLines({ stickyScrollEnabled: true, stickyMaxLineCount: NaN, cursorSurroundingLines: -3, viewportLines: -1 }), 0);
  });
  test('revealLineFor adds the padding and clamps to the document', () => {
    assert.strictEqual(revealLineFor(213, 5, 282), 218);
    assert.strictEqual(revealLineFor(280, 5, 282), 282);
    assert.strictEqual(revealLineFor(-4, 5, 282), 5);
    assert.strictEqual(revealLineFor(10, 5, 3), 3);
  });
});
