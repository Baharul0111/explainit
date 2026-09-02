import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The compiled test lives at <outDir>/test/install-smoke/test, four levels below the repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

interface Problem {
  file: string;
  line?: number;
  message: string;
}

const checker = require(path.join(REPO_ROOT, 'scripts', 'check-workflows.js')) as {
  parseYamlSubset(text: string): { doc?: any; error?: { line: number; message: string } };
  stripComment(s: string): string;
  rawChecks(text: string, file: string): Problem[];
  checkWorkflow(doc: any, file: string): Problem[];
  checkDependabot(doc: any, file: string): Problem[];
  checkIssueTemplate(doc: any, file: string): Problem[];
  checkText(text: string, file: string, kind: string): Problem[];
  checkDir(dir: string): { files: { file: string; kind: string }[]; problems: Problem[]; skipped: string[] };
  kindOf(rel: string): string | undefined;
  parseCliArgs(argv: string[]): { dir: string; json: boolean; help: boolean };
};

const parse = (text: string) => {
  const r = checker.parseYamlSubset(text);
  assert.equal(r.error, undefined, r.error?.message);
  return r.doc;
};

const GOOD_WORKFLOW = `# comment
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  test:
    name: test (\${{ matrix.os }})
    runs-on: \${{ matrix.os }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [22]
    steps:
      - name: Check out
        uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
          cache: npm
      - name: Script with a block scalar
        shell: bash
        run: |
          set -euo pipefail
          # a comment inside the script is script text
          echo "quoted: value" && echo 'single'

          if [ -z "$X" ]; then exit 1; fi
      - name: Conditional
        if: \${{ !inputs.dry-run && github.ref != 'refs/heads/main' }}
        run: echo done
`;

suite('scripts/check-workflows: YAML subset parser', () => {
  test('parses mappings, sequences, flow sequences, quotes, comments and block scalars', () => {
    const doc = parse(GOOD_WORKFLOW);
    assert.equal(doc.name, 'CI');
    assert.deepEqual(doc.on.push.branches, ['main']);
    assert.equal(doc.concurrency.group, 'ci-${{ github.ref }}');
    assert.equal(doc.concurrency['cancel-in-progress'], 'true');
    assert.deepEqual(doc.jobs.test.strategy.matrix.os, ['ubuntu-latest', 'windows-latest', 'macos-latest']);
    assert.deepEqual(doc.jobs.test.strategy.matrix.node, ['22']);
    const steps = doc.jobs.test.steps;
    assert.equal(steps.length, 4);
    assert.equal(steps[0].uses, 'actions/checkout@v4');
    assert.equal(steps[1].with['node-version'], '${{ matrix.node }}');
    assert.equal(steps[2].shell, 'bash');
    assert.equal(steps[2].run, "set -euo pipefail\n# a comment inside the script is script text\necho \"quoted: value\" && echo 'single'\n\nif [ -z \"$X\" ]; then exit 1; fi");
    assert.equal(steps[3].if, "${{ !inputs.dry-run && github.ref != 'refs/heads/main' }}");
  });

  test('quoted scalars, inline comments, empty values and sequences at key indentation', () => {
    const doc = parse(["a: 'it''s'", 'b: "say \\"hi\\"" # trailing comment', "c: '17 6 * * 1'", 'd:', 'e: value # comment', "f: 'has # inside'", 'g:', '- x', '- y', 'h: []', "i: ['@types/vscode', 7]"].join('\n') + '\n');
    assert.equal(doc.a, "it's");
    assert.equal(doc.b, 'say "hi"');
    assert.equal(doc.c, '17 6 * * 1');
    assert.equal(doc.d, null);
    assert.equal(doc.e, 'value');
    assert.equal(doc.f, 'has # inside');
    assert.deepEqual(doc.g, ['x', 'y']);
    assert.deepEqual(doc.h, []);
    assert.deepEqual(doc.i, ['@types/vscode', '7']);
    assert.equal(checker.stripComment('a: b # c'), 'a: b');
    assert.equal(checker.stripComment("'# not' # yes"), "'# not'");
    assert.equal(checker.stripComment('url: https://x/#frag'), 'url: https://x/#frag');
  });

  test('sequence items that are mappings, nested lists under items, and URLs as scalars', () => {
    const doc = parse(['contact_links:', '  - name: Runbooks', '    url: https://example.org/docs', '    about: Text with: colon', '  - marketplace', '  -', '    key: v', 'body:', '  - type: markdown', '    attributes:', '      value: |', '        Hello **there**', '        line two', '  - type: input', '    id: versions', '    validations:', '      required: true'].join('\n') + '\n');
    assert.equal(doc.contact_links[0].url, 'https://example.org/docs');
    assert.equal(doc.contact_links[0].about, 'Text with: colon');
    assert.equal(doc.contact_links[1], 'marketplace');
    assert.deepEqual(doc.contact_links[2], { key: 'v' });
    assert.equal(doc.body[0].attributes.value, 'Hello **there**\nline two');
    assert.equal(doc.body[1].validations.required, 'true');
  });

  test('errors carry the line number and a plain reason', () => {
    const bad = (text: string, re: RegExp, line: number) => {
      const r = checker.parseYamlSubset(text);
      assert.ok(r.error, `expected an error for ${JSON.stringify(text)}`);
      assert.match(r.error!.message, re);
      assert.equal(r.error!.line, line);
    };
    bad("a: 'unterminated\n", /single-quoted value is not closed/, 1);
    bad('a: "unterminated\n', /double-quoted value is not closed/, 1);
    bad('a: [1, 2\n', /flow sequence is not closed/, 1);
    bad('if: !inputs.dry-run\n', /YAML-special character "!"/, 1);
    bad('a: b\na: c\n', /duplicate key "a"/, 2);
    bad('a:\n  b: 1\n c: 2\n', /unexpected indentation/, 3);
    bad('a: 1\nnot a key\n', /expected "key: value"/, 2);
    bad('a:\n  - - x\n', /nested "- -" sequences/, 2);
    assert.deepEqual(parse(''), {});
    assert.deepEqual(parse('---\n# only a comment\n'), {});
  });
});

suite('scripts/check-workflows: raw text checks', () => {
  test('tabs, unbalanced expressions, unpinned actions and a missing final newline', () => {
    const text = ['name: x', '\tbad: tab', 'group: ${{ github.ref', 'uses: actions/checkout', '  - uses: ./local-action', 'ok: ${{ a }} ${{ b }}'].join('\n');
    const p = checker.rawChecks(text, 'w.yml');
    assert.deepEqual(
      p.map((x) => [x.line, x.message.split(';')[0].split(' (')[0]]),
      [
        [2, 'tab character'],
        [3, 'unbalanced expression: 1 "${{" but 0 "}}"'],
        [4, 'action "actions/checkout" is not pinned to a version'],
        [6, 'file does not end with a newline'],
      ],
    );
    assert.deepEqual(checker.rawChecks('name: x\n', 'w.yml'), []);
  });
});

suite('scripts/check-workflows: workflow checks', () => {
  test('a well-formed workflow has no problems', () => {
    assert.deepEqual(checker.checkText(GOOD_WORKFLOW, 'ci.yml', 'workflow'), []);
  });

  test('missing top-level keys, jobs without runs-on/steps/timeout, steps without run/uses or with both', () => {
    const doc = parse(['name: x', 'on: [push]', 'jobs:', '  a:', '    steps:', '      - name: nothing', '      - run: echo', '        uses: actions/checkout@v4', '      - uses: actions/checkout', '      - run: x', '        with:', '          a: b', '      - run: y', '        nope: z', '  b:', '    runs-on: ubuntu-latest', '    timeout-minutes: 30', '    needs: [zzz]', '    steps: []'].join('\n') + '\n');
    const messages = checker.checkWorkflow(doc, 'w.yml').map((p) => p.message);
    const expect = (re: RegExp) => assert.ok(messages.some((m) => re.test(m)), `expected a problem matching ${re}; got:\n${messages.join('\n')}`);
    expect(/missing top-level "permissions:"/);
    expect(/missing top-level "concurrency:"/);
    expect(/job "a" has no "runs-on:"/);
    expect(/job "a" has no "timeout-minutes:"/);
    expect(/step 1 \("nothing"\) must have exactly one of "uses:" or "run:"/);
    expect(/step 2 must have exactly one of "uses:" or "run:"/);
    expect(/step 3 uses "actions\/checkout" which is not pinned/);
    expect(/step 4 has "with:" but runs a script/);
    expect(/step 5 has unknown key "nope"/);
    expect(/job "b" needs unknown job "zzz"/);
    expect(/job "b" has no steps/);
  });

  test('triggers, schedules and dispatch inputs are validated', () => {
    const doc = parse(['name: x', 'permissions:', '  contents: read', 'concurrency:', '  group: g', 'on:', '  bogus:', '  schedule:', "    - cron: '17 6 * * 1'", "    - cron: '17 6 * *'", '  workflow_dispatch:', '    inputs:', '      target:', '        type: choice', '        default: nowhere', '        options: [a, b]', '      flag:', '        type: boolean', '        default: yes', '      weird:', '        type: color', 'jobs:', '  j:', '    runs-on: ubuntu-latest', '    timeout-minutes: 999', '    steps:', '      - run: x'].join('\n') + '\n');
    const messages = checker.checkWorkflow(doc, 'w.yml').map((p) => p.message);
    const expect = (re: RegExp) => assert.ok(messages.some((m) => re.test(m)), `expected ${re}; got:\n${messages.join('\n')}`);
    expect(/unknown trigger "bogus"/);
    expect(/needs a 5-field cron/);
    expect(/default "nowhere" is not one of its options/);
    expect(/"flag" is boolean but its default is "yes"/);
    expect(/"weird" has unknown type "color"/);
    expect(/invalid "timeout-minutes": 999/);
    assert.equal(messages.filter((m) => /cron/.test(m)).length, 1, 'the valid cron is accepted');
  });
});

suite('scripts/check-workflows: dependabot and issue templates', () => {
  test('dependabot.yml checks', () => {
    const good = parse(['version: 2', 'updates:', '  - package-ecosystem: npm', '    directory: /', '    schedule:', '      interval: weekly', '    groups:', '      dev:', "        patterns: ['*']"].join('\n') + '\n');
    assert.deepEqual(checker.checkDependabot(good, 'd.yml'), []);
    const bad = parse(['version: 1', 'updates:', '  - directory: /', '    schedule:', '      interval: hourly', '    groups:', '      g:', '        applies-to: x'].join('\n') + '\n');
    const messages = checker.checkDependabot(bad, 'd.yml').map((p) => p.message);
    assert.ok(messages.some((m) => /"version:" must be 2/.test(m)));
    assert.ok(messages.some((m) => /no "package-ecosystem:"/.test(m)));
    assert.ok(messages.some((m) => /daily\|weekly\|monthly/.test(m)));
    assert.ok(messages.some((m) => /group "g" needs "patterns"/.test(m)));
    assert.ok(checker.checkDependabot(parse('version: 2\n'), 'd.yml').some((p) => /non-empty list/.test(p.message)));
  });

  test('issue template checks (form and config.yml)', () => {
    const good = parse(['name: Bug', 'description: d', 'body:', '  - type: markdown', '    attributes:', '      value: hi', '  - type: input', '    id: v', '    attributes:', '      label: Versions', '  - type: dropdown', '    id: os', '    attributes:', '      label: OS', '      options: [mac, win]'].join('\n') + '\n');
    assert.deepEqual(checker.checkIssueTemplate(good, 'ISSUE_TEMPLATE/bug.yml'), []);
    const bad = parse(['name: Bug', 'body:', '  - type: textarea', '    id: a', '    attributes:', '      label: A', '  - type: textarea', '    id: a', '    attributes:', '      label: B', '  - type: sparkle', '  - type: dropdown', '    id: d', '    attributes:', '      label: D', '  - type: markdown', '    attributes:', '      text: no value'].join('\n') + '\n');
    const messages = checker.checkIssueTemplate(bad, 'ISSUE_TEMPLATE/bug.yml').map((p) => p.message);
    assert.ok(messages.some((m) => /missing "description:"/.test(m)));
    assert.ok(messages.some((m) => /duplicates id "a"/.test(m)));
    assert.ok(messages.some((m) => /body\[2\] needs a "type:"/.test(m)));
    assert.ok(messages.some((m) => /\(dropdown\) needs "attributes.options"/.test(m)));
    assert.ok(messages.some((m) => /\(markdown\) needs "attributes.value"/.test(m)));
    const cfg = parse(['blank_issues_enabled: maybe', 'contact_links:', '  - name: x', '    url: ftp://x', '    about: y'].join('\n') + '\n');
    const cfgMessages = checker.checkIssueTemplate(cfg, 'ISSUE_TEMPLATE/config.yml').map((p) => p.message);
    assert.ok(cfgMessages.some((m) => /must be true or false/.test(m)));
    assert.ok(cfgMessages.some((m) => /url must be http\(s\)/.test(m)));
    assert.deepEqual(checker.checkIssueTemplate(parse('blank_issues_enabled: true\n'), 'ISSUE_TEMPLATE/config.yml'), []);
  });
});

suite('scripts/check-workflows: directory driver', () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-wf-'));
  });
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('kindOf recognises workflows, dependabot and issue templates only', () => {
    assert.equal(checker.kindOf(path.join('workflows', 'ci.yml')), 'workflow');
    assert.equal(checker.kindOf('workflows/release.yaml'), 'workflow');
    assert.equal(checker.kindOf('dependabot.yml'), 'dependabot');
    assert.equal(checker.kindOf('ISSUE_TEMPLATE/bug_report.yml'), 'issue-template');
    assert.equal(checker.kindOf('ISSUE_TEMPLATE/config.yml'), 'issue-template');
    assert.equal(checker.kindOf('other.yml'), undefined);
    assert.equal(checker.kindOf('workflows/nested/x.yml'), undefined);
  });

  test('checkDir walks the tree, classifies files and reports problems with file names', () => {
    fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ISSUE_TEMPLATE'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'workflows', 'good.yml'), GOOD_WORKFLOW);
    fs.writeFileSync(path.join(dir, 'workflows', 'bad.yml'), 'name: x\non: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout\n');
    fs.writeFileSync(path.join(dir, 'ISSUE_TEMPLATE', 'config.yml'), 'blank_issues_enabled: true\n');
    fs.writeFileSync(path.join(dir, 'other.yml'), 'a: b\n');
    const r = checker.checkDir(dir);
    assert.deepEqual(
      r.files.map((f) => [path.basename(f.file), f.kind]),
      [
        ['config.yml', 'issue-template'],
        ['bad.yml', 'workflow'],
        ['good.yml', 'workflow'],
      ],
    );
    assert.equal(r.skipped.length, 1);
    assert.ok(r.problems.every((p) => p.file.endsWith('bad.yml')), r.problems.map((p) => p.file + ': ' + p.message).join('\n'));
    assert.ok(r.problems.some((p) => /not pinned/.test(p.message)));
    assert.ok(r.problems.some((p) => /"permissions:"/.test(p.message)));
  });

  test('parseCliArgs', () => {
    assert.deepEqual(checker.parseCliArgs([]), { dir: '.github', json: false, help: false });
    assert.deepEqual(checker.parseCliArgs(['--dir', 'x', '--json']), { dir: 'x', json: true, help: false });
    assert.equal(checker.parseCliArgs(['--dir=y']).dir, 'y');
    assert.throws(() => checker.parseCliArgs(['--nope']), /Unknown argument/);
  });

  test('the shipped .github files pass every check', () => {
    const r = checker.checkDir(path.join(REPO_ROOT, '.github'));
    assert.deepEqual(r.problems, []);
    const names = r.files.map((f) => path.basename(f.file));
    for (const want of ['ci.yml', 'codeql.yml', 'release.yml', 'dependabot.yml', 'bug_report.yml', 'config.yml']) assert.ok(names.includes(want), `${want} was checked`);
    assert.equal(r.files.filter((f) => f.kind === 'workflow').length, 3);
  });
});
