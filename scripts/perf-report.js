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
 * Exit 0 always, unless --enforce is given and a p95 exceeds its budget (then 1). No dependencies.
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

function parseCliArgs(argv) {
  const o = { files: [], budgets: DEFAULT_BUDGETS, enforce: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--budgets') o.budgets = JSON.parse(fs.readFileSync(argv[++i], 'utf8'));
    else if (a === '--enforce') o.enforce = true;
    else if (a === '--json') o.json = true;
    else o.files.push(a);
  }
  return o;
}

function readInput(files) {
  if (files.length) return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(argv) {
  const opts = parseCliArgs(argv);
  const rows = applyBudgets(summarise(parsePerf(readInput(opts.files))), opts.budgets);
  if (opts.json) console.log(JSON.stringify(rows, null, 2));
  else console.log(render(rows));
  return opts.enforce && rows.some((r) => r.over) ? 1 : 0;
}

module.exports = { parsePerf, summarise, applyBudgets, render, percentile, DEFAULT_BUDGETS, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
