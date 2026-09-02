import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  codexHomeDir,
  codexPathsFor,
  codexTrustFromIntegrity,
  friendlyHomePath,
  hasTwinExclude,
  instructionSectionPresent,
  interpretHookOutput,
  isCodexTrustCheck,
  parseTestAnswers,
  parseSessionFile,
  syntheticWritePayload,
  formatBytes,
  isTestMode,
  userHomeDir,
  CODEX_TRUST_CHECK_NAME,
  HOOK_OUTPUT_CAP,
  TWIN_NO_FUNCTIONS_LINE,
} from '../../../src/ux/pure/parsers';
import { shortFolder } from '../../../src/ux/pure/doctorChecks';
import { detectionLines, renderDoctorMarkdown, renderJournalMarkdown, INSTALL_LINKS } from '../../../src/ux/pure/render';
import type { DoctorReport } from '../../../src/core/interfaces';

suite('ux/pure/parsers', () => {
  suite('codexTrustFromIntegrity (exact shapes from src/adapters/codex.ts)', () => {
    const STEP =
      'Codex only runs hooks you have trusted: open codex in a terminal once, and when it shows the ExplainIT hook choose Trust (or type /hooks). The Codex VS Code extension uses the same trust record.';
    test('the adapter check name is "Codex hook trust"', () => {
      assert.equal(CODEX_TRUST_CHECK_NAME, 'Codex hook trust');
      assert.equal(isCodexTrustCheck('Codex hook trust'), true);
      assert.equal(isCodexTrustCheck('  codex hook trust '), true);
      assert.equal(isCodexTrustCheck('Codex hook script'), false);
      assert.equal(isCodexTrustCheck('Codex hook'), false);
    });
    test('trusted', () => {
      const v = codexTrustFromIntegrity({ checks: [{ name: 'Codex hook trust', ok: true, detail: 'Codex trusts the ExplainIT hook.' }] });
      assert.deepEqual(v, { status: 'trusted', detail: 'Codex trusts the ExplainIT hook.' });
    });
    test('untrusted, modified and disabled are "not-trusted" with the detail kept verbatim', () => {
      const details = [
        `Codex has no trust record for the ExplainIT hook yet. ${STEP}`,
        `Codex has a trust record for the ExplainIT hook, but it does not match the current hook entry. Codex will not run it until you trust it again. ${STEP}`,
        'The ExplainIT hook is disabled in Codex (enabled = false in config.toml). Enable it in codex with /hooks.',
      ];
      for (const detail of details) {
        const v = codexTrustFromIntegrity({ checks: [{ name: 'Codex hook script', ok: true }, { name: 'Codex hook trust', ok: false, fixable: false, detail }] });
        assert.equal(v.status, 'not-trusted');
        assert.equal(v.detail, detail);
      }
    });
    test('"Trust unknown — run the Doctor after starting codex once." is "unknown"', () => {
      const detail = 'Trust unknown — run the Doctor after starting codex once. (hooks.json could not be read. Config: ~/.codex/config.toml)';
      const v = codexTrustFromIntegrity({ checks: [{ name: 'Codex hook trust', ok: false, fixable: false, detail }] });
      assert.equal(v.status, 'unknown');
      assert.equal(v.detail, detail);
    });
    test('no trust check in the report (Codex not installed, adapter crashed) -> not-reported', () => {
      assert.equal(codexTrustFromIntegrity({ checks: [] }).status, 'not-reported');
      assert.equal(codexTrustFromIntegrity({ checks: [{ name: 'Codex hook', ok: true, detail: 'Not connected.' }] }).status, 'not-reported');
      assert.equal(codexTrustFromIntegrity(undefined).status, 'not-reported');
    });
    test('an empty detail never yields "undefined"', () => {
      assert.equal(codexTrustFromIntegrity({ checks: [{ name: 'Codex hook trust', ok: true }] }).detail, 'Codex trusts the ExplainIT hook.');
      const v = codexTrustFromIntegrity({ checks: [{ name: 'Codex hook trust', ok: false, fixable: false }] });
      assert.equal(v.status, 'not-trusted');
      assert.ok(v.detail.length > 10 && !v.detail.includes('undefined'));
    });
  });

  suite('codexHomeDir / userHomeDir / friendlyHomePath (mirror the adapters)', () => {
    const home = path.join(path.sep, 'home', 'me');
    const eh = path.join(home, '.explainit');
    test('default: <home>/.codex', () => {
      assert.equal(codexHomeDir({}, home, eh), path.join(home, '.codex'));
      assert.equal(userHomeDir({}, home, eh), home);
    });
    test('CODEX_HOME wins for the real home', () => {
      const custom = path.resolve(path.sep, 'srv', 'codex-home');
      assert.equal(codexHomeDir({ CODEX_HOME: custom }, home, eh), custom);
      assert.equal(codexHomeDir({ CODEX_HOME: `  ${custom}  ` }, home, eh), custom);
    });
    test('blank CODEX_HOME is ignored', () => {
      assert.equal(codexHomeDir({ CODEX_HOME: '   ' }, home, eh), path.join(home, '.codex'));
    });
    test('test homes ignore CODEX_HOME like the adapters do (never point tests at the real Codex files)', () => {
      const custom = path.resolve(path.sep, 'srv', 'codex-home');
      assert.equal(codexHomeDir({ CODEX_HOME: custom, EXPLAINIT_TEST_MODE: '1' }, home, eh), path.join(eh, 'user-home', '.codex'));
      const override = path.resolve(path.sep, 'tmp', 'fake-home');
      assert.equal(codexHomeDir({ CODEX_HOME: custom, EXPLAINIT_USER_HOME: override }, home, eh), path.join(override, '.codex'));
      assert.equal(userHomeDir({ EXPLAINIT_USER_HOME: override }, home, eh), override);
    });
    test('friendlyHomePath shows ~ for paths under the home folder and leaves others alone', () => {
      assert.equal(friendlyHomePath(path.join(home, '.codex', 'config.toml'), home), `~${path.sep}${path.join('.codex', 'config.toml')}`);
      const other = path.join(path.sep, 'srv', 'codex-home', 'hooks.json');
      assert.equal(friendlyHomePath(other, home), other);
    });
    test('codexPathsFor names both files, honouring CODEX_HOME', () => {
      const p = codexPathsFor({}, home, eh);
      assert.equal(p.hooksJson, `~${path.sep}${path.join('.codex', 'hooks.json')}`);
      assert.equal(p.configToml, `~${path.sep}${path.join('.codex', 'config.toml')}`);
      const custom = path.resolve(path.sep, 'srv', 'codex-home');
      const q = codexPathsFor({ CODEX_HOME: custom }, home, eh);
      assert.equal(q.hooksJson, path.join(custom, 'hooks.json'));
      assert.equal(q.configToml, path.join(custom, 'config.toml'));
    });
  });

  suite('hasTwinExclude', () => {
    test('present', () => assert.equal(hasTwinExclude('# comment\n*_explain.txt\n'), true));
    test('present with crlf and spaces', () => assert.equal(hasTwinExclude('foo\r\n  *_explain.txt  \r\n'), true));
    test('commented out does not count', () => assert.equal(hasTwinExclude('#*_explain.txt\n'), false));
    test('absent/empty', () => {
      assert.equal(hasTwinExclude(''), false);
      assert.equal(hasTwinExclude(undefined), false);
      assert.equal(hasTwinExclude('*.log\n'), false);
    });
  });

  suite('instructionSectionPresent', () => {
    const section = '<!-- explainit:start -->\n## ExplainIT\nEdit one function at a time.\n<!-- explainit:end -->';
    test('exact section present', () => assert.equal(instructionSectionPresent(`# Project\n\n${section}\n`, section), true));
    test('marker present with older wording', () => assert.equal(instructionSectionPresent('<!-- explainit:start -->\nold text\n<!-- explainit:end -->', section), true));
    test('heading form is accepted', () => assert.equal(instructionSectionPresent('## ExplainIT\nstuff', 'unrelated'), true));
    test('missing', () => {
      assert.equal(instructionSectionPresent(undefined, section), false);
      assert.equal(instructionSectionPresent('# Project\nnothing here', section), false);
    });
  });

  suite('syntheticWritePayload', () => {
    test('is a Claude-shaped PreToolUse Write (the doctor runs the hook as --agent claude)', () => {
      const p = syntheticWritePayload('/ws', '/ws/probe_explain.txt', 'probe.py') as any;
      assert.equal(p.tool_name, 'Write');
      assert.equal(p.hook_event_name, 'PreToolUse');
      assert.equal(p.cwd, '/ws');
      assert.equal(typeof p.session_id, 'string');
      assert.equal(p.tool_input.file_path, '/ws/probe_explain.txt');
      assert.ok(p.tool_input.file_path.endsWith('_explain.txt'), 'must be a twin path so the checkpoint answers by itself');
    });
    test('content is exactly the CONTRACTS twin for a file with no functions: header two lines, blank, the no-functions line', () => {
      const p = syntheticWritePayload('/ws', '/ws/probe_explain.txt', 'probe.py') as any;
      assert.equal(
        p.tool_input.content,
        'ExplainIT — plain-English twin of probe.py\n' +
          'Written by ExplainIT. Not committed to git. Right-click a section for "Regenerate this section".\n' +
          '\n' +
          'This file has no functions to explain.\n',
      );
      assert.equal(TWIN_NO_FUNCTIONS_LINE, 'This file has no functions to explain.');
      const lines = p.tool_input.content.split('\n');
      assert.equal(lines.length, 5, 'four lines plus the final newline');
      assert.ok(!lines.some((l: string) => /^\d+\. /.test(l)), 'no numbered sections');
    });
    test('windows-style paths pass through untouched', () => {
      const p = syntheticWritePayload('C:\\ws\\proj', 'C:\\ws\\proj\\probe_explain.txt', 'probe.py') as any;
      assert.equal(p.cwd, 'C:\\ws\\proj');
      assert.equal(p.tool_input.file_path, 'C:\\ws\\proj\\probe_explain.txt');
    });
  });

  suite('interpretHookOutput', () => {
    test('allow decision counts as answered', () => {
      const o = interpretHookOutput('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n', 0);
      assert.equal(o.answered, true);
      assert.equal(o.decision, 'allow');
    });
    test('deny with reason counts as answered', () => {
      const o = interpretHookOutput('{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"protected"}}', 0);
      assert.equal(o.answered, true);
      assert.equal(o.reason, 'protected');
    });
    test('empty output means no gate found', () => {
      const o = interpretHookOutput('', 0);
      assert.equal(o.answered, false);
      assert.ok(o.problem?.includes('printed nothing'));
    });
    test('watchdog ask is not an answer', () => {
      const o = interpretHookOutput('{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"ExplainIT is not responding; falling back to your normal permission prompt."}}', 0);
      assert.equal(o.answered, false);
      assert.ok(o.problem?.includes('timed out'));
    });
    test('non-zero exit and garbage are reported plainly', () => {
      assert.ok(interpretHookOutput('', 1, 'boom').problem?.includes('exited with code 1'));
      assert.ok(interpretHookOutput('not json', 0).problem?.includes('not JSON'));
      assert.ok(interpretHookOutput('{"x":1}', 0).problem?.includes('without a permission decision'));
    });
  });

  suite('parseTestAnswers / isTestMode', () => {
    test('valid JSON object', () => assert.deepEqual(parseTestAnswers('{"consent":"Allow"}'), { consent: 'Allow' }));
    test('garbage, arrays and empty -> {}', () => {
      assert.deepEqual(parseTestAnswers('nope'), {});
      assert.deepEqual(parseTestAnswers('[1]'), {});
      assert.deepEqual(parseTestAnswers(''), {});
      assert.deepEqual(parseTestAnswers(undefined), {});
    });
    test('isTestMode reads the env', () => {
      assert.equal(isTestMode({ EXPLAINIT_TEST_MODE: '1' }), true);
      assert.equal(isTestMode({}), false);
    });
  });

  suite('parseSessionFile', () => {
    const good = { pid: 4242, port: 51000, token: 'a'.repeat(64), folders: ['/ws'], startedAt: 'now', version: '0.1.0' };
    test('a well-formed file round-trips', () => assert.deepEqual(parseSessionFile(JSON.stringify(good)), good));
    test('missing, empty, garbage, half-written and array files are treated as missing', () => {
      assert.equal(parseSessionFile(undefined), undefined);
      assert.equal(parseSessionFile(''), undefined);
      assert.equal(parseSessionFile('   '), undefined);
      assert.equal(parseSessionFile('{"pid": 42, "port": 510'), undefined);
      assert.equal(parseSessionFile('[1,2,3]'), undefined);
      assert.equal(parseSessionFile('null'), undefined);
      assert.equal(parseSessionFile('"string"'), undefined);
    });
    test('wrong types for pid/port are rejected so no check prints "undefined"', () => {
      assert.equal(parseSessionFile('{"pid":"4242","port":51000}'), undefined);
      assert.equal(parseSessionFile('{"pid":4242}'), undefined);
      assert.equal(parseSessionFile('{"pid":4242,"port":70000}'), undefined);
      assert.equal(parseSessionFile('{"pid":-1,"port":51000}'), undefined);
    });
    test('optional fields default to safe values', () => {
      const r = parseSessionFile('{"pid":1,"port":2,"folders":["/a", 5, null]}')!;
      assert.deepEqual(r.folders, ['/a']);
      assert.equal(r.token, '');
      assert.equal(r.version, '');
    });
  });

  test('hook output cap is a sane bound', () => {
    assert.ok(HOOK_OUTPUT_CAP >= 8 * 1024 && HOOK_OUTPUT_CAP <= 1024 * 1024);
    // A flood of output still yields a plain-English problem, not a crash or a giant message.
    const o = interpretHookOutput('x'.repeat(HOOK_OUTPUT_CAP), 0);
    assert.equal(o.answered, false);
    assert.ok((o.problem ?? '').length < 300);
  });

  test('shortFolder handles posix, windows and trailing separators', () => {
    assert.equal(shortFolder('/ws/project'), 'project');
    assert.equal(shortFolder('C:\\Users\\me\\proj'), 'proj');
    assert.equal(shortFolder('C:\\Users\\me\\proj\\'), 'proj');
    assert.equal(shortFolder('/'), '/');
    assert.equal(shortFolder(''), '');
  });

  test('formatBytes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(200 * 1024 * 1024), '200 MB');
    assert.equal(formatBytes(-1), 'unknown');
  });
});

suite('ux/pure/render', () => {
  test('detectionLines merges adapters and channels into three lines in a fixed order', () => {
    const lines = detectionLines(
      [
        { agent: 'claude', present: true, ready: true, version: '2.1', location: '/ext/claude' },
        { agent: 'codex', present: false, detail: 'codex not on PATH' },
      ],
      [
        { channel: 'copilot', available: true },
        { channel: 'claude', available: true },
        { channel: 'codex', available: false, reason: 'not installed' },
      ],
    );
    assert.deepEqual(
      lines.map((l) => [l.agent, l.found, l.ready]),
      [
        ['copilot', true, true],
        ['claude', true, true],
        ['codex', false, false],
      ],
    );
    assert.ok(lines[1].detail.includes('/ext/claude'));
    assert.ok(lines[2].detail.includes('not installed'));
    assert.ok(lines[1].label.includes('VS Code extension'));
  });

  test('a present but not-ready assistant is reported as not signed in', () => {
    const [, claude] = detectionLines([{ agent: 'claude', present: true, ready: false, detail: 'run claude login' }], [{ channel: 'claude', available: false, reason: 'not signed in' }]);
    assert.equal(claude.found, true);
    assert.equal(claude.ready, false);
    assert.ok(claude.detail.includes('not signed in'));
  });

  test('install links cover the three assistants', () => {
    assert.deepEqual(INSTALL_LINKS.map((l) => l.agent).sort(), ['claude', 'codex', 'copilot']);
    for (const l of INSTALL_LINKS) assert.ok(l.url.startsWith('https://'));
  });

  test('renderDoctorMarkdown lists problems first and every check in a table', () => {
    const report: DoctorReport = {
      ok: false,
      ranAt: '2026-09-02T00:00:00.000Z',
      checks: [
        { name: 'A', ok: true, detail: 'fine' },
        { name: 'B | pipe', ok: false, detail: 'broken\nline', fix: { label: 'Fix B', run: async () => {} } },
      ],
    };
    const md = renderDoctorMarkdown(report, '0.1.0');
    assert.ok(md.startsWith('# ExplainIT Doctor report'));
    assert.ok(md.includes('**1 problem(s) found** in 2 checks'));
    assert.ok(md.includes('- **B \\| pipe** — broken\nline _(fix available: Fix B)_') || md.includes('- **B | pipe**'));
    assert.ok(md.includes('| OK | A | fine |'));
    assert.ok(md.includes('| PROBLEM | B \\| pipe | broken line — fix: Fix B |'));
    const okMd = renderDoctorMarkdown({ ok: true, ranAt: 'x', checks: [{ name: 'A', ok: true, detail: 'd' }] }, '0.1.0');
    assert.ok(okMd.includes('Everything is installed, armed and healthy'));
  });

  test('renderJournalMarkdown handles empty and populated journals newest first', () => {
    const empty = renderJournalMarkdown([{ folder: '/ws', file: '/home/j.jsonl', entries: [] }]);
    assert.ok(empty.includes('The change journal is empty'));
    const md = renderJournalMarkdown([
      {
        folder: '/ws',
        file: '/home/j.jsonl',
        entries: [
          { version: 1, seq: 1, ts: '2026-01-01T00:00:00Z', kind: 'proposed', agent: 'claude', path: '/ws/a.py', prevHash: '0', hash: '1' },
          { version: 1, seq: 2, ts: '2026-01-01T00:00:01Z', kind: 'decided', agent: 'claude', path: '/ws/a.py', decision: { requestId: 'r', verdict: 'accept', scope: 'one', decidedAt: 'x' }, checkpointId: 'cp1', prevHash: '1', hash: '2' },
        ],
      },
    ]);
    const table = md.slice(md.indexOf('|---|'));
    const decidedAt = table.indexOf('| decided');
    const proposedAt = table.indexOf('| proposed');
    assert.ok(decidedAt > 0 && decidedAt < proposedAt, 'newest first');
    assert.ok(md.includes('cp1'));
    assert.ok(renderJournalMarkdown([]).includes('Open a folder'));
  });
});
