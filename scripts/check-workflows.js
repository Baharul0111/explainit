#!/usr/bin/env node
/*
 * Structural sanity check for the files under .github/ (workflows, dependabot.yml, issue templates).
 *
 * The repo deliberately has no YAML dependency, so this is a small parser for the YAML subset those
 * files use (block mappings and sequences, plain and quoted scalars, `|` / `>` block scalars, flow
 * sequences like [a, b]) plus checks for the mistakes that make GitHub Actions fail or silently skip
 * work: tabs, unbalanced `${{ }}`, unquoted values that start with a YAML-special character, steps
 * without run/uses (or with both), unpinned actions, jobs without runs-on / steps / timeout-minutes,
 * schedules with a bad cron, dispatch inputs of unknown types.
 *
 * It is NOT a YAML validator - GitHub is the authority - but it catches what a careful reviewer
 * would. Exit 0 when clean, 1 with a file:line list, 2 on usage errors. Plain Node, no dependencies.
 *   node scripts/check-workflows.js [--dir .github] [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------------------------
// YAML subset parser
// ---------------------------------------------------------------------------------------------

class YamlSubsetError extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

const KEY_RE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/;
const BLOCK_SCALAR_RE = /^[|>][+-]?$/;
const SPECIAL_START_RE = /^[!&*%@`{}]/;

function isSeqItem(content) {
  return content === '-' || content.startsWith('- ');
}

/** Cut an inline ` # comment` that is not inside quotes. */
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function parseScalar(rest, line) {
  const v = stripComment(rest).trim();
  if (v === '') return '';
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) throw new YamlSubsetError(line, `flow sequence is not closed: ${v}`);
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((x) => parseScalar(x.trim(), line));
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'")) throw new YamlSubsetError(line, `single-quoted value is not closed: ${v}`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('"')) {
    if (v.length < 2 || !v.endsWith('"')) throw new YamlSubsetError(line, `double-quoted value is not closed: ${v}`);
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (SPECIAL_START_RE.test(v)) throw new YamlSubsetError(line, `value starts with the YAML-special character "${v[0]}"; quote it: ${v}`);
  return v;
}

class Parser {
  constructor(text) {
    this.lines = text.split(/\r?\n/).map((raw, i) => ({ n: i + 1, raw, indent: raw.length - raw.trimStart().length, content: raw.trim() }));
    this.pos = 0;
  }
  get n() {
    return this.lines.length;
  }
  skipBlank() {
    while (this.pos < this.n) {
      const c = this.lines[this.pos].content;
      if (c === '' || c.startsWith('#') || c === '---') this.pos++;
      else break;
    }
  }
  parseDocument() {
    this.skipBlank();
    if (this.pos >= this.n) return {};
    const doc = this.parseNode(this.lines[this.pos].indent);
    this.skipBlank();
    if (this.pos < this.n) throw new YamlSubsetError(this.lines[this.pos].n, `unexpected content after the document: ${this.lines[this.pos].content}`);
    return doc;
  }
  parseNode(indent) {
    this.skipBlank();
    if (this.pos >= this.n) return null;
    return isSeqItem(this.lines[this.pos].content) ? this.parseSequence(indent) : this.parseMapping(indent);
  }
  parseMapping(indent) {
    const obj = {};
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.n) break;
      const L = this.lines[this.pos];
      if (L.indent !== indent) {
        if (L.indent > indent) throw new YamlSubsetError(L.n, `unexpected indentation (${L.indent} spaces, expected ${indent}): ${L.content}`);
        break;
      }
      if (isSeqItem(L.content)) break;
      const m = KEY_RE.exec(L.content);
      if (!m) throw new YamlSubsetError(L.n, `expected "key: value", got: ${L.content}`);
      const key = m[1];
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlSubsetError(L.n, `duplicate key "${key}"`);
      const rest = m[2] === undefined ? '' : stripComment(m[2]).trim();
      this.pos++;
      if (rest === '') {
        this.skipBlank();
        const N = this.pos < this.n ? this.lines[this.pos] : undefined;
        if (N && N.indent > indent) obj[key] = this.parseNode(N.indent);
        else if (N && N.indent === indent && isSeqItem(N.content)) obj[key] = this.parseSequence(indent);
        else obj[key] = null;
      } else if (BLOCK_SCALAR_RE.test(rest)) {
        obj[key] = this.parseBlockScalar(indent);
      } else {
        obj[key] = parseScalar(rest, L.n);
      }
    }
    return obj;
  }
  parseSequence(indent) {
    const arr = [];
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.n) break;
      const L = this.lines[this.pos];
      if (L.indent !== indent || !isSeqItem(L.content)) {
        if (L.indent > indent) throw new YamlSubsetError(L.n, `unexpected indentation (${L.indent} spaces, expected ${indent}): ${L.content}`);
        break;
      }
      const item = L.content === '-' ? '' : stripComment(L.content.slice(2)).trim();
      if (item === '') {
        this.pos++;
        this.skipBlank();
        const N = this.pos < this.n ? this.lines[this.pos] : undefined;
        arr.push(N && N.indent > indent ? this.parseNode(N.indent) : null);
        continue;
      }
      if (isSeqItem(item)) throw new YamlSubsetError(L.n, 'nested "- -" sequences are not supported by this checker; use a nested key');
      if (KEY_RE.test(item) && !/^['"]/.test(item)) {
        // "- key: value": a mapping whose first key sits on the dash line; treat it as indented by two.
        this.lines[this.pos] = { ...L, indent: indent + 2, content: item };
        arr.push(this.parseMapping(indent + 2));
      } else {
        arr.push(parseScalar(item, L.n));
        this.pos++;
      }
    }
    return arr;
  }
  /** Lines more indented than the key (blank lines included) are the scalar's text, comments and all. */
  parseBlockScalar(keyIndent) {
    const out = [];
    while (this.pos < this.n) {
      const L = this.lines[this.pos];
      if (L.content !== '' && L.indent <= keyIndent) break;
      out.push(L.raw);
      this.pos++;
    }
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    const common = out.filter((l) => l.trim() !== '').reduce((min, l) => Math.min(min, l.length - l.trimStart().length), Infinity);
    return out.map((l) => (l.trim() === '' ? '' : l.slice(common))).join('\n');
  }
}

/** Parse the YAML subset. Returns { doc } or { error: { line, message } }. */
function parseYamlSubset(text) {
  try {
    return { doc: new Parser(text).parseDocument() };
  } catch (e) {
    if (e instanceof YamlSubsetError) return { error: { line: e.line, message: e.message } };
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Raw text checks (run before parsing; they catch what a parser would only report confusingly)
// ---------------------------------------------------------------------------------------------

function rawChecks(text, file) {
  const problems = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.includes('\t')) problems.push({ file, line: n, message: 'tab character; YAML indentation must use spaces' });
    const open = (line.match(/\$\{\{/g) || []).length;
    const close = (line.match(/\}\}/g) || []).length;
    if (open !== close) problems.push({ file, line: n, message: `unbalanced expression: ${open} "\${{" but ${close} "}}"` });
    const uses = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
    if (uses && !uses[1].startsWith('./') && !uses[1].includes('@')) problems.push({ file, line: n, message: `action "${uses[1]}" is not pinned to a version (@vN or @sha)` });
  });
  if (text.length && !text.endsWith('\n')) problems.push({ file, line: lines.length, message: 'file does not end with a newline' });
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Semantic checks
// ---------------------------------------------------------------------------------------------

const TRIGGERS = new Set(['push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_dispatch', 'workflow_call', 'workflow_run', 'release', 'issues', 'issue_comment', 'create', 'delete']);
const INPUT_TYPES = new Set(['string', 'boolean', 'choice', 'number', 'environment']);
const ISSUE_BODY_TYPES = new Set(['markdown', 'textarea', 'input', 'dropdown', 'checkboxes']);
const SCHEDULE_INTERVALS = new Set(['daily', 'weekly', 'monthly']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

function checkWorkflow(doc, file) {
  const p = [];
  const add = (message) => p.push({ file, message });
  if (!isObj(doc)) {
    add('the workflow is not a mapping');
    return p;
  }
  for (const key of ['name', 'on', 'jobs']) if (!(key in doc)) add(`missing top-level "${key}:"`);
  if (!('permissions' in doc)) add('missing top-level "permissions:" (least privilege: declare what the token may do)');
  if (!('concurrency' in doc)) add('missing top-level "concurrency:" (superseded runs should be cancelled)');
  const on = doc.on;
  if (isStr(on)) {
    if (!TRIGGERS.has(on)) add(`unknown trigger "${on}"`);
  } else if (Array.isArray(on)) {
    for (const t of on) if (!TRIGGERS.has(t)) add(`unknown trigger "${t}"`);
  } else if (isObj(on)) {
    if (!Object.keys(on).length) add('"on:" has no triggers');
    for (const [t, cfg] of Object.entries(on)) {
      if (!TRIGGERS.has(t)) add(`unknown trigger "${t}"`);
      if (t === 'schedule') {
        if (!Array.isArray(cfg) || !cfg.length) add('"schedule:" must be a list of "- cron: ..." entries');
        else for (const s of cfg) if (!isObj(s) || !isStr(s.cron) || s.cron.trim().split(/\s+/).length !== 5) add(`schedule entry needs a 5-field cron, got: ${JSON.stringify(s)}`);
      }
      if (t === 'workflow_dispatch' && isObj(cfg) && isObj(cfg.inputs)) {
        for (const [name, input] of Object.entries(cfg.inputs)) {
          if (!isObj(input)) {
            add(`dispatch input "${name}" must be a mapping`);
            continue;
          }
          if (input.type !== undefined && !INPUT_TYPES.has(input.type)) add(`dispatch input "${name}" has unknown type "${input.type}"`);
          if (input.type === 'choice') {
            if (!Array.isArray(input.options) || !input.options.length) add(`dispatch input "${name}" is a choice without options`);
            else if (input.default !== undefined && !input.options.includes(input.default)) add(`dispatch input "${name}" default "${input.default}" is not one of its options`);
          }
          if (input.type === 'boolean' && input.default !== undefined && input.default !== 'true' && input.default !== 'false') add(`dispatch input "${name}" is boolean but its default is "${input.default}"`);
        }
      }
    }
  } else if (on !== undefined) add('"on:" must be a trigger name, a list, or a mapping');

  const jobs = doc.jobs;
  if (!isObj(jobs) || !Object.keys(jobs).length) {
    add('"jobs:" must be a mapping with at least one job');
    return p;
  }
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObj(job)) {
      add(`job "${jobId}" is not a mapping`);
      continue;
    }
    if (!('runs-on' in job)) add(`job "${jobId}" has no "runs-on:"`);
    if (!('timeout-minutes' in job)) add(`job "${jobId}" has no "timeout-minutes:" (a hung runner should not burn 6 hours)`);
    else if (!/^\d+$/.test(String(job['timeout-minutes'])) || Number(job['timeout-minutes']) > 360) add(`job "${jobId}" has an invalid "timeout-minutes": ${job['timeout-minutes']}`);
    if ('needs' in job) {
      const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
      for (const need of needs) if (!(need in jobs)) add(`job "${jobId}" needs unknown job "${need}"`);
    }
    if (isObj(job.strategy) && isObj(job.strategy.matrix)) {
      for (const [k, v] of Object.entries(job.strategy.matrix)) if (k !== 'include' && k !== 'exclude' && (!Array.isArray(v) || !v.length)) add(`job "${jobId}" matrix "${k}" must be a non-empty list`);
    }
    if (!Array.isArray(job.steps) || !job.steps.length) {
      add(`job "${jobId}" has no steps`);
      continue;
    }
    job.steps.forEach((step, i) => {
      const label = `job "${jobId}" step ${i + 1}${isObj(step) && isStr(step.name) ? ` ("${step.name}")` : ''}`;
      if (!isObj(step)) {
        add(`${label} is not a mapping`);
        return;
      }
      const hasUses = isStr(step.uses);
      const hasRun = isStr(step.run);
      if (hasUses === hasRun) add(`${label} must have exactly one of "uses:" or "run:"`);
      if (hasUses && !step.uses.startsWith('./') && !/^[^@\s]+@[^@\s]+$/.test(step.uses)) add(`${label} uses "${step.uses}" which is not pinned`);
      if ('with' in step && !isObj(step.with)) add(`${label} "with:" must be a mapping`);
      if ('with' in step && hasRun) add(`${label} has "with:" but runs a script (with is for actions)`);
      if ('env' in step && !isObj(step.env)) add(`${label} "env:" must be a mapping`);
      if ('shell' in step && !hasRun) add(`${label} sets "shell:" without "run:"`);
      for (const key of Object.keys(step)) {
        if (!['name', 'id', 'if', 'uses', 'run', 'with', 'env', 'shell', 'working-directory', 'continue-on-error', 'timeout-minutes'].includes(key)) add(`${label} has unknown key "${key}"`);
      }
    });
  }
  return p;
}

function checkDependabot(doc, file) {
  const p = [];
  const add = (message) => p.push({ file, message });
  if (!isObj(doc)) return [{ file, message: 'dependabot.yml is not a mapping' }];
  if (String(doc.version) !== '2') add(`"version:" must be 2, got ${doc.version}`);
  if (!Array.isArray(doc.updates) || !doc.updates.length) {
    add('"updates:" must be a non-empty list');
    return p;
  }
  doc.updates.forEach((u, i) => {
    const label = `updates[${i}]`;
    if (!isObj(u)) {
      add(`${label} is not a mapping`);
      return;
    }
    if (!isStr(u['package-ecosystem'])) add(`${label} has no "package-ecosystem:"`);
    if (!isStr(u.directory)) add(`${label} has no "directory:"`);
    if (!isObj(u.schedule) || !SCHEDULE_INTERVALS.has(u.schedule.interval)) add(`${label} needs "schedule.interval" of daily|weekly|monthly`);
    if (isObj(u.groups)) {
      for (const [g, cfg] of Object.entries(u.groups)) if (!isObj(cfg) || (!cfg.patterns && !cfg['dependency-type'])) add(`${label} group "${g}" needs "patterns" or "dependency-type"`);
    }
  });
  return p;
}

function checkIssueTemplate(doc, file) {
  const p = [];
  const add = (message) => p.push({ file, message });
  if (!isObj(doc)) return [{ file, message: 'issue template is not a mapping' }];
  if (path.basename(file) === 'config.yml') {
    if (doc.blank_issues_enabled !== undefined && doc.blank_issues_enabled !== 'true' && doc.blank_issues_enabled !== 'false') add('"blank_issues_enabled:" must be true or false');
    if (doc.contact_links !== undefined) {
      if (!Array.isArray(doc.contact_links)) add('"contact_links:" must be a list');
      else doc.contact_links.forEach((l, i) => {
        for (const k of ['name', 'url', 'about']) if (!isObj(l) || !isStr(l[k])) add(`contact_links[${i}] has no "${k}:"`);
        if (isObj(l) && isStr(l.url) && !/^https?:\/\//.test(l.url)) add(`contact_links[${i}] url must be http(s): ${l.url}`);
      });
    }
    return p;
  }
  for (const k of ['name', 'description']) if (!isStr(doc[k])) add(`missing "${k}:"`);
  if (!Array.isArray(doc.body) || !doc.body.length) {
    add('"body:" must be a non-empty list');
    return p;
  }
  const ids = new Set();
  doc.body.forEach((el, i) => {
    const label = `body[${i}]`;
    if (!isObj(el) || !ISSUE_BODY_TYPES.has(el.type)) {
      add(`${label} needs a "type:" of ${[...ISSUE_BODY_TYPES].join('|')}`);
      return;
    }
    if (!isObj(el.attributes)) add(`${label} (${el.type}) has no "attributes:"`);
    if (el.type === 'markdown') {
      if (isObj(el.attributes) && !isStr(el.attributes.value)) add(`${label} (markdown) needs "attributes.value"`);
      return;
    }
    if (!isStr(el.id)) add(`${label} (${el.type}) has no "id:"`);
    else if (ids.has(el.id)) add(`${label} duplicates id "${el.id}"`);
    else ids.add(el.id);
    if (isObj(el.attributes) && !isStr(el.attributes.label)) add(`${label} (${el.type}) needs "attributes.label"`);
    if (el.type === 'dropdown' && (!isObj(el.attributes) || !Array.isArray(el.attributes.options) || !el.attributes.options.length)) add(`${label} (dropdown) needs "attributes.options"`);
  });
  return p;
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

function kindOf(rel) {
  const posix = rel.split(path.sep).join('/');
  if (/^workflows\/[^/]+\.ya?ml$/.test(posix)) return 'workflow';
  if (/^dependabot\.ya?ml$/.test(posix)) return 'dependabot';
  if (/^ISSUE_TEMPLATE\/[^/]+\.ya?ml$/.test(posix)) return 'issue-template';
  return undefined;
}

function listYamlFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.ya?ml$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** Check one file's text as the given kind. Returns problems: [{ file, line?, message }]. */
function checkText(text, file, kind) {
  const problems = rawChecks(text, file);
  const parsed = parseYamlSubset(text);
  if (parsed.error) {
    problems.push({ file, line: parsed.error.line, message: parsed.error.message });
    return problems;
  }
  if (kind === 'workflow') problems.push(...checkWorkflow(parsed.doc, file));
  else if (kind === 'dependabot') problems.push(...checkDependabot(parsed.doc, file));
  else if (kind === 'issue-template') problems.push(...checkIssueTemplate(parsed.doc, file));
  return problems;
}

/** Check every recognised YAML file under `.github`. */
function checkDir(dir) {
  const files = [];
  const problems = [];
  const skipped = [];
  for (const full of listYamlFiles(dir)) {
    const rel = path.relative(dir, full);
    const kind = kindOf(rel);
    const display = path.relative(process.cwd(), full).split(path.sep).join('/');
    if (!kind) {
      skipped.push(display);
      continue;
    }
    files.push({ file: display, kind });
    problems.push(...checkText(fs.readFileSync(full, 'utf8'), display, kind));
  }
  return { files, problems, skipped };
}

function parseCliArgs(argv) {
  const o = { dir: '.github', json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = argv[++i];
    else if (a.startsWith('--dir=')) o.dir = a.slice(6);
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument "${a}". Usage: check-workflows.js [--dir <.github>] [--json]`);
  }
  if (!o.dir) throw new Error('--dir needs a directory');
  return o;
}

function main(argv) {
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (opts.help) {
    console.log('Usage: node scripts/check-workflows.js [--dir <.github>] [--json]');
    return 0;
  }
  if (!fs.existsSync(opts.dir)) {
    console.error(`check-workflows: ${opts.dir} does not exist. Run it from the repo root.`);
    return 2;
  }
  const { files, problems, skipped } = checkDir(opts.dir);
  if (opts.json) {
    console.log(JSON.stringify({ ok: problems.length === 0, files, skipped, problems }, null, 2));
    return problems.length ? 1 : 0;
  }
  if (!files.length) {
    console.error(`check-workflows: no workflow, dependabot or issue-template YAML found under ${opts.dir}.`);
    return 2;
  }
  const workflows = files.filter((f) => f.kind === 'workflow').length;
  if (!problems.length) {
    console.log(`check-workflows: OK - ${files.length} file(s) checked (${workflows} workflow(s)) under ${opts.dir}; no structural problems.`);
    if (skipped.length) console.log(`check-workflows: skipped (not a workflow/dependabot/issue template): ${skipped.join(', ')}`);
    return 0;
  }
  console.error(`check-workflows: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p.file}${p.line ? ':' + p.line : ''}: ${p.message}`);
  console.error('\nFix the file(s) above. This checker covers the YAML subset GitHub Actions files normally use; if it rejects valid YAML, prefer the simpler block style.');
  return 1;
}

module.exports = { parseYamlSubset, stripComment, rawChecks, checkWorkflow, checkDependabot, checkIssueTemplate, checkText, checkDir, kindOf, parseCliArgs, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
