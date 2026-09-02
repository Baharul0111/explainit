import * as assert from 'node:assert';
import { contentHashOf } from '../../../src/core/hash';
import type { FunctionMap, FunctionRecord, TwinSection } from '../../../src/core/types';
import { parseTwin } from '../../../src/twin/pure/parse';
import { renderTwin } from '../../../src/twin/pure/render';
import { fileSummaryOf, functionAtLine, functionText, matchPrevious, outlineUnavailable, planSections, planWithoutOutline, previousSections, toRenderSections, toSidecarSections, type TwinSidecar } from '../../../src/twin/pure/stale';
import { parseSidecar, serializeSidecar, validateSidecar } from '../../../src/twin/pure/sidecar';

function fn(name: string, body: string, start = 0, ordinal = 0): FunctionRecord {
  const lines = body.split('\n').length;
  return { id: `${name}#${ordinal}`, name, kind: 'function', range: { startLine: start, endLine: start + lines - 1 }, contentHash: contentHashOf(body), languageId: 'python', source: 'symbols' };
}
function mapOf(...fns: FunctionRecord[]): FunctionMap {
  return { fileUri: 'file:///w/app.py', languageId: 'python', functions: fns, source: 'symbols', textHash: 'th' };
}
function section(index: number, f: FunctionRecord, extra: Partial<TwinSection> = {}): TwinSection {
  return { index, functionId: f.id, name: f.name, contentHash: f.contentHash, startLine: 0, endLine: 0, stale: false, ...extra };
}
const content = (name: string) => ({ summary: `${name} does a thing.`, steps: ['Step one.', 'Step two.'] });

suite('twin/pure/stale (sidecar merge)', () => {
  const a = fn('a', 'def a():\n    return 1', 0);
  const b = fn('b', 'def b():\n    return 2', 3);
  const c = fn('c', 'def c():\n    return 3', 6);

  function existing(fns: FunctionRecord[], stale: boolean[] = []): { sidecar: TwinSidecar; parsed: ReturnType<typeof parseTwin> } {
    const rendered = renderTwin('app.py', fns.map((f, i) => ({ name: f.name, content: content(f.name), stale: stale[i] })));
    const sidecar: TwinSidecar = {
      sourcePath: '/w/app.py',
      twinPath: '/w/app_explain.txt',
      textHash: 'old',
      sections: fns.map((f, i) => section(i + 1, f, { startLine: rendered.sections[i].startLine, endLine: rendered.sections[i].endLine, stale: !!stale[i] })),
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    return { sidecar, parsed: parseTwin(rendered.text) };
  }

  test('unchanged functions are reused verbatim and never generated', () => {
    const { sidecar, parsed } = existing([a, b]);
    const plan = planSections(mapOf(a, b), sidecar, parsed, { kind: 'changed' });
    assert.deepStrictEqual(plan.entries.map((e) => e.reason), ['reuse', 'reuse']);
    assert.strictEqual(plan.toGenerate.length, 0);
    assert.deepStrictEqual(plan.entries[0].content, content('a'));
  });

  test('a changed function is generated, the others reused (never re-explain unchanged code)', () => {
    const { sidecar, parsed } = existing([a, b]);
    const b2 = fn('b', 'def b():\n    return 22', 3);
    const plan = planSections(mapOf(a, b2), sidecar, parsed, { kind: 'changed' });
    assert.deepStrictEqual(plan.toGenerate.map((e) => e.fn.name), ['b']);
    assert.strictEqual(plan.entries[1].reason, 'changed');
    assert.strictEqual(plan.entries[1].stale, true, 'old content is stale until regenerated');
    assert.deepStrictEqual(plan.entries[1].content, content('b'), 'old content kept as fallback');
  });

  test('new functions are generated, removed functions vanish, numbering follows the map', () => {
    const { sidecar, parsed } = existing([a, b]);
    const plan = planSections(mapOf(b, c), sidecar, parsed, { kind: 'changed' });
    assert.deepStrictEqual(plan.entries.map((e) => [e.index, e.fn.name, e.reason]), [[1, 'b', 'reuse'], [2, 'c', 'new']]);
  });

  test('moved / renumbered code keeps its explanation via the content hash', () => {
    const { sidecar, parsed } = existing([a, b]);
    const aMoved = { ...a, id: 'a#0', range: { startLine: 10, endLine: 11 } };
    const plan = planSections(mapOf(b, aMoved), sidecar, parsed, { kind: 'changed' });
    assert.deepStrictEqual(plan.entries.map((e) => e.reason), ['reuse', 'reuse']);
  });

  test('a renamed function with identical body matches by hash; identical bodies are claimed once', () => {
    const { sidecar, parsed } = existing([a]);
    const twin1 = { ...a, id: 'x#0', name: 'x' };
    const twin2 = { ...a, id: 'y#0', name: 'y' };
    const m = matchPrevious([twin1, twin2], sidecar.sections);
    assert.strictEqual(m.size, 1, 'one previous section can serve only one function');
    const plan = planSections(mapOf(twin1, twin2), sidecar, parsed, { kind: 'changed' });
    assert.deepStrictEqual(plan.entries.map((e) => e.reason), ['reuse', 'new']);
  });

  test('markStale mode never generates: changed -> stale with old content, new -> unavailable', () => {
    const { sidecar, parsed } = existing([a, b]);
    const a2 = fn('a', 'def a():\n    return 11', 0);
    const plan = planSections(mapOf(a2, b, c), sidecar, parsed, { kind: 'none' });
    assert.strictEqual(plan.toGenerate.length, 0);
    const render = toRenderSections(plan, new Map());
    assert.deepStrictEqual(render, [
      { name: 'a', content: content('a'), stale: true },
      { name: 'b', content: content('b'), stale: false },
      { name: 'c', state: 'unavailable' },
    ]);
    const sections = toSidecarSections(plan, new Map(), renderTwin('app.py', render).sections);
    assert.strictEqual(sections[0].contentHash, a.contentHash, 'stale section keeps the hash of the code it describes');
    assert.strictEqual(sections[0].stale, true);
    assert.strictEqual(sections[1].stale, false);
    assert.strictEqual(sections[2].contentHash, c.contentHash);
    assert.strictEqual(sections[2].stale, false);
    assert.strictEqual(sections[2].functionId, 'c#0');
  });

  test('undo after a stale mark un-stales without generation (hash matches again)', () => {
    const { sidecar, parsed } = existing([a, b], [true, false]);
    const plan = planSections(mapOf(a, b), sidecar, parsed, { kind: 'none' });
    assert.strictEqual(plan.entries[0].stale, false);
    assert.strictEqual(plan.entries[0].reason, 'reuse');
  });

  test('sections whose twin text is missing or a placeholder are regenerated', () => {
    const rendered = renderTwin('app.py', [{ name: 'a', content: content('a') }, { name: 'b', state: 'unavailable' }]);
    const sidecar: TwinSidecar = { sourcePath: '/w/app.py', twinPath: '/w/app_explain.txt', textHash: 'old', sections: [section(1, a), section(2, b)], generatedAt: 'x' };
    const plan = planSections(mapOf(a, b), sidecar, parseTwin(rendered.text), { kind: 'changed' });
    assert.deepStrictEqual(plan.entries.map((e) => e.reason), ['reuse', 'missing']);
    const noTwin = planSections(mapOf(a, b), sidecar, undefined, { kind: 'changed' });
    assert.deepStrictEqual(noTwin.entries.map((e) => e.reason), ['missing', 'missing']);
  });

  test('a lost or corrupt sidecar never wipes an existing twin: sections are kept, marked stale, and regenerated only when allowed', () => {
    const { parsed } = existing([a, b]);
    // markStale (no model call) with no sidecar: every explanation survives, shown as out of date.
    const none = planSections(mapOf(a, b), undefined, parsed, { kind: 'none' });
    assert.strictEqual(none.toGenerate.length, 0);
    assert.deepStrictEqual(toRenderSections(none, new Map()), [
      { name: 'a', content: content('a'), stale: true },
      { name: 'b', content: content('b'), stale: true },
    ]);
    const sections = toSidecarSections(none, new Map(), renderTwin('app.py', toRenderSections(none, new Map())).sections);
    assert.deepStrictEqual(sections.map((s) => [s.functionId, s.contentHash, s.stale]), [['a#0', '', true], ['b#0', '', true]]);
    // ensureTwin / updateAfterChange regenerate them (the router's cache answers when the code is unchanged).
    const changed = planSections(mapOf(a, b), undefined, parsed, { kind: 'changed' });
    assert.deepStrictEqual(changed.entries.map((e) => e.reason), ['changed', 'changed']);
    assert.deepStrictEqual(changed.entries.map((e) => e.content), [content('a'), content('b')], 'old words kept as the fallback');
    // Placeholders in the twin are not "explanations" to recover.
    const withPlaceholder = parseTwin(renderTwin('app.py', [{ name: 'a', content: content('a') }, { name: 'b', state: 'unavailable' }]).text);
    assert.deepStrictEqual(planSections(mapOf(a, b), undefined, withPlaceholder, { kind: 'none' }).entries.map((e) => e.reason), ['changed', 'new']);
    // No twin and no sidecar: a fresh file.
    assert.deepStrictEqual(planSections(mapOf(a), undefined, undefined, { kind: 'changed' }).entries.map((e) => e.reason), ['new']);
  });

  test('when nothing could outline the file, the existing sections are kept (out of date when the source changed) instead of being wiped', () => {
    const { sidecar, parsed } = existing([a, b], [false, true]);
    const none: FunctionMap = { fileUri: 'file:///w/app.py', languageId: 'fortran', functions: [], source: 'none', textHash: 'new' };
    assert.strictEqual(outlineUnavailable(none, previousSections(sidecar, parsed)), true);
    assert.strictEqual(outlineUnavailable({ ...none, source: 'tree-sitter' }, sidecar.sections), false, 'a positive "no functions" answer is not ignorance');
    assert.strictEqual(outlineUnavailable(none, []), false, 'nothing to keep');
    assert.strictEqual(outlineUnavailable(mapOf(a), sidecar.sections), false);
    assert.deepStrictEqual(previousSections(undefined, parsed).map((s) => s.name), ['a', 'b']);

    // Unchanged source: every section keeps its words and its flag; nothing is generated.
    const same = planWithoutOutline(none, sidecar, parsed, false);
    assert.strictEqual(same.toGenerate.length, 0);
    assert.deepStrictEqual(toRenderSections(same, new Map()), [
      { name: 'a', content: content('a'), stale: false },
      { name: 'b', content: content('b'), stale: true },
    ]);
    // Changed source: nobody can tell which function changed, so every section is out of date; words and hashes are kept.
    const changed = planWithoutOutline(none, sidecar, parsed, true);
    const render = toRenderSections(changed, new Map());
    assert.deepStrictEqual(render, [
      { name: 'a', content: content('a'), stale: true },
      { name: 'b', content: content('b'), stale: true },
    ]);
    const sections = toSidecarSections(changed, new Map(), renderTwin('app.py', render).sections);
    assert.deepStrictEqual(sections.map((s) => [s.index, s.functionId, s.name, s.contentHash, s.stale]), [[1, 'a#0', 'a', a.contentHash, true], [2, 'b#0', 'b', b.contentHash, true]]);
    // No sidecar: sections are recovered from the twin text and read as out of date.
    const recovered = planWithoutOutline(none, undefined, parsed, false);
    assert.deepStrictEqual(recovered.entries.map((e) => [e.fn.id, e.stale, e.reason]), [['a#0', true, 'changed'], ['b#1', true, 'changed']]);
    // A placeholder section has no words to keep.
    const withPlaceholder = parseTwin(renderTwin('app.py', [{ name: 'a', content: content('a') }, { name: 'b', state: 'unavailable' }]).text);
    assert.deepStrictEqual(toRenderSections(planWithoutOutline(none, undefined, withPlaceholder, true), new Map()), [{ name: 'a', content: content('a'), stale: true }]);
  });

  test('a hand-edited twin whose section names no longer match is regenerated rather than trusted', () => {
    const { sidecar } = existing([a]);
    const edited = parseTwin(renderTwin('app.py', [{ name: 'renamed', content: content('z') }]).text);
    const plan = planSections(mapOf(a), sidecar, edited, { kind: 'changed' });
    assert.strictEqual(plan.entries[0].reason, 'missing');
  });

  test('force regenerates everything; only regenerates exactly one', () => {
    const { sidecar, parsed } = existing([a, b]);
    assert.deepStrictEqual(planSections(mapOf(a, b), sidecar, parsed, { kind: 'all' }).toGenerate.map((e) => e.fn.name), ['a', 'b']);
    const only = planSections(mapOf(a, b), sidecar, parsed, { kind: 'only', functionId: 'b#0' });
    assert.deepStrictEqual(only.toGenerate.map((e) => e.fn.name), ['b']);
    assert.strictEqual(only.entries[1].reason, 'forced');
    assert.strictEqual(only.entries[0].reason, 'reuse');
  });

  test('render + sidecar after a run: fresh content wins, pending placeholders during streaming, fallbacks after failure', () => {
    const { sidecar, parsed } = existing([a, b]);
    const b2 = fn('b', 'def b():\n    return 22', 3);
    const plan = planSections(mapOf(a, b2, c), sidecar, parsed, { kind: 'changed' });
    const pending = new Set(plan.toGenerate.map((e) => e.fn.id));
    const provisional = toRenderSections(plan, new Map(), pending);
    assert.deepStrictEqual(provisional, [{ name: 'a', content: content('a'), stale: false }, { name: 'b', state: 'pending' }, { name: 'c', state: 'pending' }]);
    const produced = new Map([[b2.id, content('b-new')]]);
    const final = toRenderSections(plan, produced);
    assert.deepStrictEqual(final, [
      { name: 'a', content: content('a'), stale: false },
      { name: 'b', content: content('b-new'), stale: false },
      { name: 'c', state: 'unavailable' },
    ]);
    const rendered = renderTwin('app.py', final);
    const sections = toSidecarSections(plan, produced, rendered.sections);
    assert.strictEqual(sections[1].contentHash, b2.contentHash);
    assert.strictEqual(sections[1].stale, false);
    assert.deepStrictEqual(sections.map((s) => [s.startLine, s.endLine]), rendered.sections.map((s) => [s.startLine, s.endLine]));
    // failure for b: old content comes back, stale
    const failed = toRenderSections(plan, new Map());
    assert.deepStrictEqual(failed[1], { name: 'b', content: content('b'), stale: true });
    const failedSections = toSidecarSections(plan, new Map(), renderTwin('app.py', failed).sections);
    assert.strictEqual(failedSections[1].contentHash, b.contentHash);
    assert.strictEqual(failedSections[1].stale, true);
  });

  test('functionText, fileSummaryOf and functionAtLine helpers', () => {
    const src = 'import os\n# top\n\ndef a():\n    return 1\n\ndef b():\n    return 2\n';
    const fa = fn('a', 'def a():\n    return 1', 3);
    const fb = fn('b', 'def b():\n    return 2', 6);
    assert.strictEqual(functionText(src, fa), 'def a():\n    return 1');
    assert.strictEqual(functionText(src.replace(/\n/g, '\r\n'), fb), 'def b():\n    return 2');
    assert.strictEqual(typeof functionText(src, { ...fb, range: { startLine: 50, endLine: 60 } }), 'string', 'out of range never throws');
    assert.strictEqual(fileSummaryOf(src, [fa, fb]), 'import os\n# top');
    assert.strictEqual(fileSummaryOf('def a():\n  pass', [fn('a', 'def a():\n  pass', 0)]), undefined, 'nothing above the first function');
    assert.strictEqual(fileSummaryOf('\n\n', []), undefined);
    assert.strictEqual(fileSummaryOf('x'.repeat(3000), [], 20, 100)?.length, 100);
    assert.strictEqual(functionAtLine([fa, fb], 0), undefined, 'above the first function');
    assert.strictEqual(functionAtLine([fa, fb], 4), 0);
    assert.strictEqual(functionAtLine([fa, fb], 5), 0, 'gap belongs to the function above');
    assert.strictEqual(functionAtLine([fa, fb], 7), 1);
    assert.strictEqual(functionAtLine([], 7), undefined);
  });

  test('sidecar JSON round trip and validation', () => {
    const { sidecar } = existing([a]);
    const text = serializeSidecar(sidecar);
    assert.deepStrictEqual(Object.keys(JSON.parse(text)), ['sourcePath', 'twinPath', 'textHash', 'sections', 'generatedAt']);
    assert.deepStrictEqual(parseSidecar(text), sidecar);
    assert.strictEqual(parseSidecar('{not json'), undefined);
    assert.strictEqual(validateSidecar({ sourcePath: 1 }), undefined);
    assert.strictEqual(validateSidecar({ ...sidecar, sections: [{ index: 1 }] }), undefined);
    assert.strictEqual(validateSidecar(null), undefined);
  });
});
