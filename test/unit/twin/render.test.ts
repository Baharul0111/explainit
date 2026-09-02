import * as assert from 'node:assert';
import { parseTwin, sectionAtLine } from '../../../src/twin/pure/parse';
import { HEADER_LINE2, NO_FUNCTIONS_LINE, PENDING_LINE, renderTwin, STALE_LINE, UNAVAILABLE_LINE, type RenderSection } from '../../../src/twin/pure/render';

const HEADER = `ExplainIT — plain-English twin of app.py\n${HEADER_LINE2}\n\n`;

const loadConfig: RenderSection = {
  name: 'load_config',
  content: {
    summary: 'Reads the settings file and turns it into a settings object.',
    steps: ['It opens the file at the given path.', 'It reads all of the text.', 'It turns the text into a settings object.', 'It hands the object back.'],
  },
};
const serverStart: RenderSection = {
  name: 'Server.start',
  content: { summary: 'Starts the web server so it can answer requests.', steps: ['It picks the port from the settings.', 'It begins listening on that port.', 'It logs that it is ready.'] },
};

suite('twin/pure/render', () => {
  test('zero sections: header plus the no-functions line', () => {
    const r = renderTwin('app.py', []);
    assert.strictEqual(r.text, HEADER + NO_FUNCTIONS_LINE + '\n');
    assert.deepStrictEqual(r.sections, []);
  });

  test('one section renders the exact contract text', () => {
    const r = renderTwin('/some/where/app.py', [loadConfig]);
    assert.strictEqual(
      r.text,
      HEADER +
        '1. load_config\n' +
        'What it does: Reads the settings file and turns it into a settings object.\n' +
        'How it works:\n' +
        '- It opens the file at the given path.\n' +
        '- It reads all of the text.\n' +
        '- It turns the text into a settings object.\n' +
        '- It hands the object back.\n',
    );
    assert.deepStrictEqual(r.sections, [{ index: 1, name: 'load_config', startLine: 3, endLine: 9 }]);
  });

  test('many sections: the CONTRACTS example verbatim', () => {
    const r = renderTwin('app.py', [loadConfig, serverStart]);
    const expected =
      'ExplainIT — plain-English twin of app.py\n' +
      'Written by ExplainIT. Not committed to git. Right-click a section for "Regenerate this section".\n' +
      '\n' +
      '1. load_config\n' +
      'What it does: Reads the settings file and turns it into a settings object.\n' +
      'How it works:\n' +
      '- It opens the file at the given path.\n' +
      '- It reads all of the text.\n' +
      '- It turns the text into a settings object.\n' +
      '- It hands the object back.\n' +
      '\n' +
      '2. Server.start\n' +
      'What it does: Starts the web server so it can answer requests.\n' +
      'How it works:\n' +
      '- It picks the port from the settings.\n' +
      '- It begins listening on that port.\n' +
      '- It logs that it is ready.\n';
    assert.strictEqual(r.text, expected);
    assert.deepStrictEqual(r.sections, [
      { index: 1, name: 'load_config', startLine: 3, endLine: 9 },
      { index: 2, name: 'Server.start', startLine: 11, endLine: 16 },
    ]);
  });

  test('stale line goes directly under the header line', () => {
    const r = renderTwin('app.py', [{ ...serverStart, stale: true }]);
    assert.strictEqual(
      r.text,
      HEADER +
        '1. Server.start\n' +
        STALE_LINE + '\n' +
        'What it does: Starts the web server so it can answer requests.\n' +
        'How it works:\n' +
        '- It picks the port from the settings.\n' +
        '- It begins listening on that port.\n' +
        '- It logs that it is ready.\n',
    );
    assert.strictEqual(STALE_LINE, '(Out of date — the code changed. Right-click here and choose "ExplainIT: Regenerate this section".)');
  });

  test('warnings render as Watch out lines after the steps', () => {
    const r = renderTwin('app.py', [{ name: 'delete_all', content: { summary: 'Removes every record.', steps: ['It lists the records.', 'It deletes each one.'], warnings: ['There is no undo.', 'It ignores errors.'] } }]);
    assert.strictEqual(
      r.text,
      HEADER + '1. delete_all\n' + 'What it does: Removes every record.\n' + 'How it works:\n' + '- It lists the records.\n' + '- It deletes each one.\n' + 'Watch out: There is no undo.\n' + 'Watch out: It ignores errors.\n',
    );
  });

  test('placeholders: not explained yet, and explaining...', () => {
    const r = renderTwin('app.py', [{ name: 'a' }, { name: 'b', state: 'pending' }, { name: 'c', state: 'unavailable', stale: true }]);
    assert.strictEqual(r.text, HEADER + '1. a\n' + UNAVAILABLE_LINE + '\n' + '\n' + '2. b\n' + PENDING_LINE + '\n' + '\n' + '3. c\n' + STALE_LINE + '\n' + UNAVAILABLE_LINE + '\n');
    assert.strictEqual(UNAVAILABLE_LINE, 'What it does: (not explained yet — connect an assistant and run "ExplainIT: Regenerate this section")');
    assert.strictEqual(PENDING_LINE, 'What it does: (explaining...)');
  });

  test('model text is flattened to single clean lines', () => {
    const r = renderTwin('x.js', [{ name: '  f  ', content: { summary: '  Does\n  things.  ', steps: [' one ', '', 'two\r\nthree'], warnings: [''] } }]);
    assert.strictEqual(r.text, HEADER.replace('app.py', 'x.js') + '1. f\n' + 'What it does: Does things.\n' + 'How it works:\n' + '- one\n' + '- two three\n');
  });

  test('empty summary is treated as not explained', () => {
    const r = renderTwin('x.js', [{ name: 'f', content: { summary: '   ', steps: ['a'] } }]);
    assert.strictEqual(r.text, HEADER.replace('app.py', 'x.js') + '1. f\n' + UNAVAILABLE_LINE + '\n');
  });

  test('round trip: parse(render(x)) re-renders to the identical string, including line ranges', () => {
    const sections: RenderSection[] = [
      loadConfig,
      { ...serverStart, stale: true },
      { name: 'danger', content: { summary: 'Deletes things.', steps: ['One.', 'Two.'], warnings: ['No undo.'] } },
      { name: 'later', state: 'pending' },
      { name: 'nothing' },
    ];
    const first = renderTwin('app.py', sections);
    const parsed = parseTwin(first.text);
    assert.strictEqual(parsed.sourceName, 'app.py');
    assert.strictEqual(parsed.noFunctions, false);
    assert.deepStrictEqual(
      parsed.sections.map((s) => ({ index: s.index, name: s.name, startLine: s.startLine, endLine: s.endLine })),
      first.sections,
    );
    const again = renderTwin('app.py', parsed.sections.map((s) => ({ name: s.name, stale: s.stale, content: s.content, state: s.state })));
    assert.strictEqual(again.text, first.text);
  });

  test('parse recognises states, stale flag, warnings and CRLF input', () => {
    const text = renderTwin('app.py', [{ ...serverStart, stale: true }, { name: 'p', state: 'pending' }, { name: 'u' }]).text.replace(/\n/g, '\r\n');
    const parsed = parseTwin(text);
    assert.strictEqual(parsed.sections.length, 3);
    assert.strictEqual(parsed.sections[0].stale, true);
    assert.strictEqual(parsed.sections[0].state, 'explained');
    assert.deepStrictEqual(parsed.sections[0].content, serverStart.content);
    assert.strictEqual(parsed.sections[1].state, 'pending');
    assert.strictEqual(parsed.sections[1].content, undefined);
    assert.strictEqual(parsed.sections[2].state, 'unavailable');
  });

  test('parse of the no-functions twin and of garbage', () => {
    assert.deepStrictEqual(parseTwin(renderTwin('app.py', []).text), { sourceName: 'app.py', sections: [], noFunctions: true });
    assert.deepStrictEqual(parseTwin(''), { sourceName: undefined, sections: [], noFunctions: false });
    const p = parseTwin('random\nlines\n3. not a header? yes it is\nWhat it does: Something.\n');
    assert.strictEqual(p.sections.length, 1);
    assert.strictEqual(p.sections[0].index, 3);
    assert.strictEqual(p.sections[0].content?.summary, 'Something.');
  });

  test('sectionAtLine maps twin lines to sections (blank separators belong to the section above)', () => {
    const r = renderTwin('app.py', [loadConfig, serverStart]);
    assert.strictEqual(sectionAtLine(r.sections, 0), undefined, 'header');
    assert.strictEqual(sectionAtLine(r.sections, 3), 0);
    assert.strictEqual(sectionAtLine(r.sections, 9), 0);
    assert.strictEqual(sectionAtLine(r.sections, 10), 0, 'separator');
    assert.strictEqual(sectionAtLine(r.sections, 11), 1);
    assert.strictEqual(sectionAtLine(r.sections, 99), 1);
  });
});
