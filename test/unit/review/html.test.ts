import * as assert from 'node:assert/strict';
import {
  agentLabel,
  buildCards,
  COLLAPSE_AFTER_ROWS,
  describeTrivialHunk,
  diffRows,
  diffToHtml,
  escapeHtml,
  MAX_DIFF_LINES,
  MAX_RENDERED_ROWS,
  makeNonce,
  safeId,
  shortPath,
  trivialExplanationText,
} from '../../../src/review/pure/html';
import type { FunctionHunk, GateRequest } from '../../../src/core/types';

function hunk(id: string, extra: Partial<FunctionHunk> = {}): FunctionHunk {
  return { id, kind: 'function', functionName: id, changeType: 'modified', beforeText: 'a\n', afterText: 'b\n', trivial: false, ...extra };
}

function request(hunksByPath: Record<string, FunctionHunk[]>, writes?: GateRequest['writes']): GateRequest {
  return {
    id: 'r',
    agent: 'codex',
    sessionId: 's',
    toolName: 'apply_patch',
    cwd: '/w',
    writes: writes ?? Object.keys(hunksByPath).map((p) => ({ kind: 'modify' as const, path: p, before: '', after: '' })),
    hunksByPath,
    receivedAt: new Date().toISOString(),
  };
}

suite('review/pure/html escaping', () => {
  test('escapes every HTML-significant character', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  test('handles undefined and non-strings', () => {
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(42), '42');
  });

  test('script tags in code become text in the diff', () => {
    const { html } = diffToHtml('', '<script>alert("pwned")</script>\n');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;'));
  });

  test('safeId strips anything that could break out of an attribute', () => {
    assert.equal(safeId('a"b<c>d e'), 'a_b_c_d_e');
    assert.equal(safeId('ok-id_1'), 'ok-id_1');
  });

  test('makeNonce is 32 alphanumeric characters', () => {
    const n = makeNonce();
    assert.match(n, /^[A-Za-z0-9]{32}$/);
    assert.notEqual(makeNonce(), n);
    assert.equal(makeNonce(() => 0), 'A'.repeat(32));
  });
});

suite('review/pure/html diff rendering', () => {
  test('diffRows classifies lines and numbers them', () => {
    const rows = diffRows('one\ntwo\nthree\n', 'one\n2\nthree\n');
    assert.deepEqual(rows, [
      { kind: 'ctx', oldLine: 1, newLine: 1, text: 'one' },
      { kind: 'remove', oldLine: 2, text: 'two' },
      { kind: 'add', newLine: 2, text: '2' },
      { kind: 'ctx', oldLine: 3, newLine: 3, text: 'three' },
    ]);
  });

  test('diffRows normalises CRLF and handles a missing trailing newline', () => {
    const rows = diffRows('a\r\nb', 'a\r\nc');
    assert.deepEqual(rows.map((r) => [r.kind, r.text]), [['ctx', 'a'], ['remove', 'b'], ['add', 'c']]);
  });

  test('diffRows: added function has only add rows; removed only remove rows', () => {
    assert.ok(diffRows('', 'x\ny\n').every((r) => r.kind === 'add'));
    assert.ok(diffRows('x\ny\n', '').every((r) => r.kind === 'remove'));
    assert.deepEqual(diffRows('', ''), []);
  });

  test('diffToHtml emits add/remove/ctx row classes with escaped code', () => {
    const { html, rows, collapsed } = diffToHtml('keep\nold <b>\n', 'keep\nnew & shiny\n');
    assert.equal(rows, 3);
    assert.equal(collapsed, false);
    assert.ok(html.startsWith('<table class="diff"'));
    assert.ok(html.includes('<tr class="ctx"><td class="ln">1</td><td class="ln">1</td><td class="sign"> </td><td class="code">keep</td></tr>'));
    assert.ok(html.includes('<tr class="remove"><td class="ln">2</td><td class="ln"></td><td class="sign">-</td><td class="code">old &lt;b&gt;</td></tr>'));
    assert.ok(html.includes('<tr class="add"><td class="ln"></td><td class="ln">2</td><td class="sign">+</td><td class="code">new &amp; shiny</td></tr>'));
  });

  test('diffToHtml reports no differences for identical text', () => {
    const d = diffToHtml('same\n', 'same\n');
    assert.equal(d.rows, 1);
    assert.ok(!d.html.includes('class="add"'));
    assert.equal(diffToHtml('', '').html, '<div class="diff-empty">No line differences.</div>');
  });

  test('long hunks are collapsed: rows past the limit carry the "more" class', () => {
    const lines = Array.from({ length: COLLAPSE_AFTER_ROWS + 10 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const d = diffToHtml('', lines);
    assert.equal(d.collapsed, true);
    assert.equal(d.rows, COLLAPSE_AFTER_ROWS + 10);
    assert.equal((d.html.match(/class="add more"/g) ?? []).length, 10);
    assert.equal((d.html.match(/class="add"/g) ?? []).length, COLLAPSE_AFTER_ROWS);
    const small = diffToHtml('', 'a\nb\nc\n', 2);
    assert.equal(small.collapsed, true);
    assert.equal((small.html.match(/ more"/g) ?? []).length, 1);
  });
});

suite('review/pure/html huge hunks', () => {
  test('enormous hunks skip the quadratic diff but still show every line', () => {
    const n = MAX_DIFF_LINES;
    const before = Array.from({ length: n }, (_, i) => `b${i}`).join('\n') + '\n';
    const after = Array.from({ length: n }, (_, i) => `a${i}`).join('\n') + '\n';
    const rows = diffRows(before, after);
    assert.equal(rows.length, 2 * n);
    assert.ok(rows.slice(0, n).every((r) => r.kind === 'remove'));
    assert.ok(rows.slice(n).every((r) => r.kind === 'add'));
    // Just under the cap the real diff runs.
    assert.deepEqual(diffRows('x\n', 'y\n', 10).map((r) => r.kind), ['remove', 'add']);
    assert.deepEqual(diffRows('x\n', 'x\n', 1).map((r) => r.kind), ['remove', 'add'], 'over the cap: no alignment');
  });

  test('rendered rows are capped with a plain note; the note is escaped-safe and counts the rest', () => {
    const lines = Array.from({ length: MAX_RENDERED_ROWS + 5 }, (_, i) => `<${i}>`).join('\n') + '\n';
    const d = diffToHtml('', lines);
    assert.equal(d.rows, MAX_RENDERED_ROWS + 5);
    assert.equal(d.truncated, 5);
    assert.equal((d.html.match(/<tr class="add/g) ?? []).length, MAX_RENDERED_ROWS);
    assert.ok(d.html.includes('5 more lines not shown here'));
    assert.ok(!d.html.includes('<0>'), 'code is escaped');
    assert.ok(d.html.length < 200 * (MAX_RENDERED_ROWS + 6), 'html stays bounded');
    const small = diffToHtml('', 'a\nb\n', 60, 1);
    assert.equal(small.truncated, 1);
    assert.ok(small.html.includes('1 more line not shown'));
    assert.equal(diffToHtml('a\n', 'b\n').truncated, 0);
  });

  test('empty and whitespace-only inputs never throw', () => {
    assert.deepEqual(diffRows('', ''), []);
    assert.deepEqual(diffRows('\n', ''), [{ kind: 'remove', oldLine: 1, text: '' }]);
    assert.equal(diffToHtml(undefined as unknown as string, undefined as unknown as string).rows, 0);
    assert.equal(diffToHtml('\r\n\r\n', '\r\n').rows, 2);
  });

  test('cards carry the truncated row count', () => {
    const big = Array.from({ length: MAX_RENDERED_ROWS + 1 }, () => 'x').join('\n') + '\n';
    const cards = buildCards(request({ '/w/a.py': [hunk('f', { beforeText: '', afterText: big })] }), { batchTrivial: true });
    assert.equal(cards[0].diffTruncated, 1);
    assert.equal(cards[0].diffCollapsed, true);
  });

  test('a trivial-kind hunk without a function name is titled as lines outside any function', () => {
    const cards = buildCards(request({ '/w/a.py': [hunk('t', { kind: 'trivial', functionName: undefined })] }), { batchTrivial: false });
    assert.equal(cards[0].kind, 'other');
    assert.equal(cards[0].title, 'Lines outside any function (modified)');
  });
});

suite('review/pure/html card models', () => {
  test('one card per non-trivial hunk, numbered and titled by change type', () => {
    const cards = buildCards(
      request({
        '/w/app.py': [
          hunk('load_config'),
          hunk('greet', { changeType: 'added', beforeText: '' }),
          hunk('old', { changeType: 'removed', afterText: '' }),
        ],
      }),
      { batchTrivial: true },
    );
    assert.deepEqual(
      cards.map((c) => c.title),
      ['Function 1 of 3: load_config (modified)', 'Function 2 of 3: greet (added)', 'Function 3 of 3: old (removed)'],
    );
    assert.deepEqual(cards.map((c) => c.id), ['card-1', 'card-2', 'card-3']);
    assert.ok(cards.every((c) => c.kind === 'function' && !c.selfExplained && c.hunkIds.length === 1));
    assert.ok(cards[0].diffHtml.includes('class="diff"'));
  });

  test('trivial hunks are batched into ONE self-explained card listing them', () => {
    const cards = buildCards(
      request({
        '/w/app.py': [
          hunk('f1'),
          hunk('ws1', { trivial: true, beforeText: 'x = 1\n', afterText: 'x  =  1\n' }),
          hunk('f2'),
          hunk('ws2', { trivial: true, kind: 'other', functionName: undefined, beforeText: '# a\n', afterText: '# b\n' }),
        ],
      }),
      { batchTrivial: true },
    );
    assert.equal(cards.length, 3);
    const trivial = cards.find((c) => c.kind === 'trivial')!;
    assert.equal(trivial.title, 'Whitespace and comment-only changes (2)');
    assert.deepEqual(trivial.hunkIds, ['ws1', 'ws2']);
    assert.equal(trivial.selfExplained, true);
    assert.equal(trivial.trivialItems?.length, 2);
    assert.match(trivial.trivialItems![0], /^in ws1: 2 lines changed/);
    assert.match(trivial.trivialItems![1], /^outside any function: 2 lines changed/);
    // Batched card sits at the position of the first trivial hunk; function numbering skips it.
    assert.deepEqual(cards.map((c) => c.kind), ['function', 'trivial', 'function']);
    assert.equal(cards[2].title, 'Function 2 of 2: f2 (modified)');
  });

  test('with batching off every hunk gets its own card', () => {
    const cards = buildCards(request({ '/w/app.py': [hunk('f1'), hunk('ws', { trivial: true })] }), { batchTrivial: false });
    assert.equal(cards.length, 2);
    assert.ok(cards.every((c) => c.kind === 'function'));
  });

  test('hunks outside any function get a descriptive title', () => {
    const cards = buildCards(request({ '/w/app.py': [hunk('imports', { kind: 'other', functionName: undefined })] }), { batchTrivial: true });
    assert.equal(cards[0].title, 'Lines outside any function (modified)');
    assert.equal(cards[0].kind, 'other');
  });

  test('cards follow the order of writes across several files', () => {
    const cards = buildCards(
      request({ '/w/b.py': [hunk('b1')], '/w/a.py': [hunk('a1')] }, [
        { kind: 'modify', path: '/w/a.py', before: '', after: '' },
        { kind: 'modify', path: '/w/b.py', before: '', after: '' },
      ]),
      { batchTrivial: true },
    );
    assert.deepEqual(cards.map((c) => c.path), ['/w/a.py', '/w/b.py']);
  });

  test('an empty request yields no cards', () => {
    assert.deepEqual(buildCards(request({}), { batchTrivial: true }), []);
  });

  test('function names are escaped nowhere in titles (titles are plain text) but the diff is escaped', () => {
    const cards = buildCards(request({ '/w/x.js': [hunk('<img onerror=1>', { afterText: '<script>x</script>\n' })] }), { batchTrivial: true });
    assert.ok(cards[0].title.includes('<img onerror=1>'));
    assert.ok(!cards[0].diffHtml.includes('<script>'));
  });

  test('describeTrivialHunk and trivialExplanationText read plainly', () => {
    assert.equal(describeTrivialHunk(hunk('f', { beforeText: 'a\n', afterText: 'a \n' })), 'in f: 2 lines changed (whitespace or comments only)');
    const t = trivialExplanationText(['x']);
    assert.equal(t.whatChanged, 'Only spacing, blank lines or comments changed in 1 place.');
    assert.equal(t.whyItMatters.length, 2);
  });

  test('agentLabel and shortPath helpers', () => {
    assert.equal(agentLabel('claude'), 'Claude Code');
    assert.equal(agentLabel('codex'), 'Codex');
    assert.equal(agentLabel('copilot'), 'Copilot');
    assert.equal(agentLabel('other'), 'other');
    assert.equal(shortPath('/w/src/app.py'), 'src/app.py');
    assert.equal(shortPath('C:\\proj\\src\\app.py'), 'src/app.py');
    assert.equal(shortPath('app.py'), 'app.py');
  });
});
