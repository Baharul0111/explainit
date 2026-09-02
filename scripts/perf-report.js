#!/usr/bin/env node
/*
 * Optional helper: turn integration-test output into a small timing report and compare it with the
 * performance budgets from architecture.md (twin open < 300 ms cache hit, first explanation < 8 s,
 * gate panel < 500 ms).
 *
 * Recognised lines:
 *   [perf] <name>: <n> ms          (what the integration tests print)
 *   PERF <name> <n>ms
 *   ✓ <mocha test title> (<n>ms)   (mocha's own slow-test markers)
 *
 *   node scripts/perf-report.js [file...] [--budgets <json>] [--enforce] [--json]
 *   npm run test:integration 2>&1 | tee it.log ; node scripts/perf-report.js it.log
 *
 * Exit 0 always, unless --enforce is given and a p95 exceeds its budget (then 1); 2 when an input or
 * budgets file cannot be read. No dependencies.
 */
'use strict';
const fs = require('fs');

/** Budgets in ms, matched by case-insensitive substring of the entry name. */
const DEFAULT_BUDGETS = {
  'twin open (cache hit)': 300,
  'first explanation': 8000,
  'gate panel': 500,
  'symbol backoff': 5000,
};

const PATTERNS = [
  /\[perf\]\s*(.+?)\s*[:=]\s*(\d+(?:\.\d+)?)\s*ms\b/i,
  /\bPERF\s+(.+?)\s+(\d+(?:\.\d+)?)\s*ms\b/,
  /^\s*[✓√]\s+(.+?)\s+\((\d+(?:\.\d+)?)ms\)\s*$/,
];

/** Parse timing entries out of free text. Returns [{ name, ms }]. */
function parsePerf(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    for (const re of PATTERNS) {
      const m = re.exec(line);
      if (m) {
        out.push({ name: m[1].trim(), ms: Number(m[2]) });
        break;
      }
    }
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Group entries by name: count, min, max, avg, p95. */
function summarise(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!Number.isFinite(e.ms)) continue;
    if (!groups.has(e.name)) groups.set(e.name, []);
    groups.get(e.name).push(e.ms);
  }
  const rows = [];
  for (const [name, values] of groups) {
    const sorted = values.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    rows.push({ name, count: sorted.length, min: sorted[0], max: sorted[sorted.length - 1], avg: Math.round(sum / sorted.length), p95: percentile(sorted, 95) });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function budgetFor(name, budgets) {
  const lower = name.toLowerCase();
  for (const [key, ms] of Object.entries(budgets)) if (lower.includes(key.toLowerCase())) return ms;
  return undefined;
}

/** Attach budgets and a verdict to summary rows. */
function applyBudgets(rows, budgets) {
  return rows.map((r) => {
    const budget = budgetFor(r.name, budgets);
    return { ...r, budget, over: budget !== undefined && r.p95 > budget };
  });
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function render(rows) {
  if (!rows.length) return 'perf-report: no timing lines found (expected "[perf] name: 123 ms" or mocha "(123ms)" markers).';
  const lines = ['perf-report:', '  name                                        n     min      avg      p95      max   budget'];
  for (const r of rows) {
    const name = r.name.length > 42 ? r.name.slice(0, 39) + '...' : r.name.padEnd(42);
    const budget = r.budget === undefined ? '-' : `${fmt(r.budget)}${r.over ? '  OVER' : '  ok'}`;
    lines.push(`  ${name} ${String(r.count).padStart(3)} ${fmt(r.min).padStart(8)} ${fmt(r.avg).padStart(8)} ${fmt(r.p95).padStart(8)} ${fmt(r.max).padStart(8)}   ${budget}`);
  }
  const over = rows.filter((r) => r.over);
  lines.push(over.length ? `  ${over.length} budget(s) exceeded: ${over.map((r) => r.name).join(', ')}` : '  all budgets met');
  return lines.join('\n');
}

/** Read a budgets JSON file: { "<name substring>": <ms>, ... }. Throws a plain-English error. */
function loadBudgets(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read the budgets file ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`the budgets file ${file} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`the budgets file ${file} must be an object of { "name": milliseconds }`);
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`the budget for "${k}" in ${file} must be a positive number of milliseconds, got ${JSON.stringify(v)}`);
    out[k] = v;
  }
  return out;
}

function parseCliArgs(argv) {
  const o = { files: [], budgets: DEFAULT_BUDGETS, enforce: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--budgets') {
      const f = argv[++i];
      if (!f) throw new Error('--budgets needs a JSON file');
      o.budgets = loadBudgets(f);
    } else if (a.startsWith('--budgets=')) o.budgets = loadBudgets(a.slice(10));
    else if (a === '--enforce') o.enforce = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('-') && a !== '-') throw new Error(`Unknown argument "${a}". Usage: perf-report.js [file...] [--budgets <json>] [--enforce] [--json]`);
    else o.files.push(a);
  }
  return o;
}

/** Concatenate the input files (or stdin when none). A missing file is a plain-English error. */
function readInput(files) {
  if (files.length) {
    return files
      .map((f) => {
        try {
          return fs.readFileSync(f === '-' ? 0 : f, 'utf8');
        } catch (e) {
          throw new Error(`cannot read ${f}: ${e.message}`);
        }
      })
      .join('\n');
  }
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(argv) {
  let opts;
  let text;
  try {
    opts = parseCliArgs(argv);
    if (opts.help) {
      console.log('Usage: node scripts/perf-report.js [file...] [--budgets <json>] [--enforce] [--json]');
      return 0;
    }
    text = readInput(opts.files);
  } catch (e) {
    console.error(`perf-report: ${e.message}`);
    return 2;
  }
  const rows = applyBudgets(summarise(parsePerf(text)), opts.budgets);
  if (opts.json) console.log(JSON.stringify(rows, null, 2));
  else console.log(render(rows));
  return opts.enforce && rows.some((r) => r.over) ? 1 : 0;
}

module.exports = { parsePerf, summarise, applyBudgets, render, percentile, loadBudgets, parseCliArgs, readInput, DEFAULT_BUDGETS, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
