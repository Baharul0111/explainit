#!/usr/bin/env node
/*
 * Checks that a packaged explainit-<version>.vsix contains what ships and nothing else
 * (goal item 14 "packaged and ready to publish"). `vsce package` happily bundles whatever is in the
 * working tree that .vscodeignore does not exclude: scratch build folders (out-*), tests, sources,
 * a stray .env. Publishing that is embarrassing at best and leaks private files at worst.
 *
 * A VSIX is a zip file; this reads its central directory with plain Node (no dependencies) and checks:
 *   - required entries are present (manifest, package.json, dist/extension.js, the tree-sitter wasm
 *     folder, the hook script, the runbooks)
 *   - no entry comes from a forbidden folder or matches a forbidden pattern (src/, test/, eval/, out/,
 *     out-<anything>/, node_modules/, scripts/, .github/, .vscode-test/, .env files, *.vsix, *.log, *.ts)
 *   - the file count and total uncompressed size are within sane limits
 *
 * Exit 0 when clean, 1 with the list of problems and what to do next, 2 on usage errors.
 *   node scripts/check-vsix.js [<file.vsix>] [--max-files <n>] [--max-mb <n>] [--json]
 * Without a file argument the newest explainit-*.vsix in the current directory is checked.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REQUIRED_ENTRIES = ['extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json', 'extension/dist/extension.js', 'extension/hooks/explainit-hook.js'];
const REQUIRED_PREFIXES = ['extension/dist/wasm/', 'extension/docs/runbooks/'];
/** Any entry starting with one of these (after "extension/") must not ship. */
const FORBIDDEN_DIRS = ['src/', 'test/', 'eval/', 'out/', 'node_modules/', 'scripts/', '.github/', '.vscode/', '.vscode-test/', '.workflows/', 'coverage/'];
const FORBIDDEN_DIR_PATTERNS = [/^out-[^/]*\//];
const FORBIDDEN_FILE_PATTERNS = [/(^|\/)\.env(\.|$)/, /\.vsix$/i, /\.log$/i, /\.ts$/i, /(^|\/)\.DS_Store$/, /(^|\/)tsconfig\.json$/, /(^|\/)esbuild\.mjs$/, /(^|\/)eslint\.config\.mjs$/];
const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_MB = 120;

// ---------------------------------------------------------------------------------------------
// Minimal zip central-directory reader
// ---------------------------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const MAX_COMMENT = 0xffff;

/** List the entries of a zip file held in a Buffer: [{ name, size (uncompressed), compressedSize }]. */
function listZipEntries(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('listZipEntries needs a Buffer');
  if (buf.length < 22) throw new Error('not a zip file: shorter than the end-of-central-directory record');
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - MAX_COMMENT);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) {
    throw new Error('this zip uses ZIP64 (more than 65535 entries or over 4 GB); a VSIX that size is wrong anyway');
  }
  if (cenOffset + cenSize > buf.length) throw new Error('zip central directory points past the end of the file (truncated download?)');
  const entries = [];
  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`zip central directory entry ${i + 1} is corrupt`);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, size, compressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** Why an entry must not ship, or undefined when it is fine. */
function forbiddenReason(name) {
  if (!name.startsWith('extension/')) return undefined;
  const rel = name.slice('extension/'.length);
  for (const d of FORBIDDEN_DIRS) if (rel.startsWith(d)) return `${d.slice(0, -1)}/ is not part of the extension`;
  for (const re of FORBIDDEN_DIR_PATTERNS) if (re.test(rel)) return 'a scratch build folder (out-<name>/) leaked into the package';
  for (const re of FORBIDDEN_FILE_PATTERNS) if (re.test(rel)) return 'this kind of file must not ship';
  return undefined;
}

/**
 * Check a list of zip entries. Returns { ok, problems: string[], files, totalBytes }.
 * opts: { maxFiles, maxMb }.
 */
function checkEntries(entries, opts) {
  const o = { maxFiles: DEFAULT_MAX_FILES, maxMb: DEFAULT_MAX_MB, ...(opts || {}) };
  const problems = [];
  const names = new Set(entries.map((e) => e.name));
  for (const r of REQUIRED_ENTRIES) if (!names.has(r)) problems.push(`missing ${r} (the package is incomplete; run "npm run build" then "npm run package" again)`);
  for (const p of REQUIRED_PREFIXES) if (![...names].some((n) => n.startsWith(p) && n !== p)) problems.push(`nothing under ${p} (the package is incomplete; run "npm run build" then "npm run package" again)`);
  const offenders = new Map();
  for (const e of entries) {
    const why = forbiddenReason(e.name);
    if (!why) continue;
    // Group by the top-level folder/file under extension/ so the report stays short.
    const rel = e.name.slice('extension/'.length);
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/') + 1) : rel;
    const g = offenders.get(top) || { why, count: 0, example: e.name };
    g.count++;
    offenders.set(top, g);
  }
  for (const [top, g] of offenders) problems.push(`extension/${top} must not ship: ${g.why} (${g.count} file(s), e.g. ${g.example})`);
  const files = entries.filter((e) => !e.name.endsWith('/')).length;
  const totalBytes = entries.reduce((a, e) => a + e.size, 0);
  if (files > o.maxFiles) problems.push(`${files} files in the package; a healthy ExplainIT package has well under ${o.maxFiles} (something that should be ignored was bundled)`);
  if (totalBytes > o.maxMb * 1024 * 1024) problems.push(`${(totalBytes / 1024 / 1024).toFixed(1)} MB uncompressed; more than ${o.maxMb} MB means something that should be ignored was bundled`);
  return { ok: problems.length === 0, problems, files, totalBytes };
}

/** Newest explainit-*.vsix in `dir` by modification time; undefined when there is none (or no such directory). */
function pickNewestVsix(dir) {
  let best;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!/^explainit-.+\.vsix$/i.test(name)) continue;
    let st;
    try {
      st = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { name, mtimeMs: st.mtimeMs };
  }
  return best ? path.join(dir, best.name) : undefined;
}

function parseCliArgs(argv) {
  const o = { file: undefined, maxFiles: DEFAULT_MAX_FILES, maxMb: DEFAULT_MAX_MB, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (v, flag) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number, got "${v === undefined ? '' : v}"`);
      return n;
    };
    if (a === '--max-files') o.maxFiles = num(argv[++i], '--max-files');
    else if (a.startsWith('--max-files=')) o.maxFiles = num(a.slice(12), '--max-files');
    else if (a === '--max-mb') o.maxMb = num(argv[++i], '--max-mb');
    else if (a.startsWith('--max-mb=')) o.maxMb = num(a.slice(9), '--max-mb');
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown argument "${a}". Usage: check-vsix.js [<file.vsix>] [--max-files <n>] [--max-mb <n>] [--json]`);
    else if (o.file) throw new Error('Only one VSIX file can be checked at a time.');
    else o.file = a;
  }
  return o;
}

function main(argv) {
  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (e) {
    console.error(`check-vsix: ${e.message}`);
    return 2;
  }
  if (opts.help) {
    console.log('Usage: node scripts/check-vsix.js [<file.vsix>] [--max-files <n>] [--max-mb <n>] [--json]');
    return 0;
  }
  const file = opts.file ? path.resolve(opts.file) : pickNewestVsix(process.cwd());
  if (!file) {
    console.error(`check-vsix: no explainit-*.vsix in ${process.cwd()}. Run "npm run package" first.`);
    return 2;
  }
  let entries;
  try {
    entries = listZipEntries(fs.readFileSync(file));
  } catch (e) {
    console.error(`check-vsix: cannot read ${file}: ${e.message}`);
    return 1;
  }
  const result = checkEntries(entries, { maxFiles: opts.maxFiles, maxMb: opts.maxMb });
  if (opts.json) {
    console.log(JSON.stringify({ file, ...result }, null, 2));
    return result.ok ? 0 : 1;
  }
  const mb = (result.totalBytes / 1024 / 1024).toFixed(1);
  if (result.ok) {
    console.log(`check-vsix: OK - ${path.basename(file)} has ${result.files} files (${mb} MB uncompressed) and nothing that should not ship.`);
    return 0;
  }
  console.error(`check-vsix: ${path.basename(file)} is not ready to publish (${result.files} files, ${mb} MB uncompressed):`);
  for (const p of result.problems) console.error(`  - ${p}`);
  console.error('\nDelete the stray folders (they are git-ignored) or add them to .vscodeignore, then run "npm run package" again from a clean checkout ("git clean -ndx" shows what a fresh clone would not have).');
  return 1;
}

module.exports = { listZipEntries, checkEntries, forbiddenReason, parseCliArgs, pickNewestVsix, main, REQUIRED_ENTRIES, REQUIRED_PREFIXES, DEFAULT_MAX_FILES, DEFAULT_MAX_MB };

if (require.main === module) process.exit(main(process.argv.slice(2)));
