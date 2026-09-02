#!/usr/bin/env node
/*
 * ExplainIT no-network scanner (REQ-021; architecture.md "no network calls except 127.0.0.1").
 *
 * Scans src/, hooks/, dist/ (and media/ webview assets) for anything that could reach the network:
 *   - URLs (http://, https://, ws://, wss://) that are not loopback (127.0.0.1, localhost, [::1])
 *     and are not on the allowlist in scripts/network-allowlist.json (install links shown in
 *     onboarding, JSON-schema ids inside the bundled ajv, ...). URLs inside comment lines are
 *     documentation and are allowed.
 *   - Imports of Node modules that only exist to talk to the outside world: https, dns, tls, net,
 *     dgram, http2 (type-only imports are fine: they vanish at build time).
 *   - Browser network APIs in webview code: XMLHttpRequest, WebSocket, sendBeacon, EventSource.
 *
 * Exit 0 when clean, 1 with a file:line list and what to do next. Plain Node, no dependencies.
 *   node scripts/check-no-network.js [--root <dir>]... [--allowlist <file>] [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOTS = ['src', 'hooks', 'dist', 'media'];
const DEFAULT_ALLOWLIST = path.join(__dirname, 'network-allowlist.json');
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.json', '.html', '.css']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'wasm']);
const MAX_FILE_BYTES = 32 * 1024 * 1024;

const URL_RE = /\b(?:https?|wss?):\/\/[^\s'"`<>)\]},;]+/g;
// Host must be exactly loopback; the port may be a number or a template expression (`:${port}`), never
// userinfo (`127.0.0.1:80@evil.com` would make evil.com the real host).
const LOOPBACK_RE = /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[^/?#@\s]*)?(?:[/?#]|$)/i;
const NET_MODULES = 'https|dns|tls|net|dgram|http2';
const MODULE_RE = new RegExp(
  `\\brequire\\(\\s*['"](?:node:)?(?:${NET_MODULES})['"]\\s*\\)|\\bfrom\\s+['"](?:node:)?(?:${NET_MODULES})['"]|\\bimport\\s+['"](?:node:)?(?:${NET_MODULES})['"]|\\bimport\\(\\s*['"](?:node:)?(?:${NET_MODULES})['"]\\s*\\)`,
);
const TYPE_IMPORT_RE = /\bimport\s+type\b/;
const BROWSER_API_RE = /\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\s*\(|\bnavigator\.sendBeacon\s*\(/;
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*|#|<!--)/;

function loadAllowlist(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read the allowlist ${file}: ${e.message}. Create it with {"urlPrefixes":[],"files":[]}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`The allowlist ${file} is not valid JSON: ${e.message}`);
  }
  const urlPrefixes = Array.isArray(parsed.urlPrefixes) ? parsed.urlPrefixes.filter((p) => typeof p === 'string' && p) : [];
  const files = Array.isArray(parsed.files) ? parsed.files.filter((p) => typeof p === 'string' && p).map(toPosix) : [];
  // knownBenign: { file, kind, contains, reason } - a specific finding inside a bundled dependency that
  // cannot run in the extension host (e.g. Emscripten's browser-only XHR branch). All four fields required.
  const knownBenign = Array.isArray(parsed.knownBenign)
    ? parsed.knownBenign
        .filter((k) => k && typeof k.file === 'string' && typeof k.kind === 'string' && typeof k.contains === 'string' && typeof k.reason === 'string' && k.reason.trim())
        .map((k) => ({ file: toPosix(k.file), kind: k.kind, contains: k.contains, reason: k.reason }))
    : [];
  return { urlPrefixes, files, knownBenign };
}

function isKnownBenign(finding, allow) {
  const list = allow.knownBenign || [];
  return list.some((k) => k.file === finding.file && k.kind === finding.kind && finding.text.includes(k.contains));
}

function toPosix(p) {
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

function isLoopbackUrl(url) {
  return LOOPBACK_RE.test(url);
}

function isAllowedUrl(url, allow) {
  if (isLoopbackUrl(url)) return true;
  return allow.urlPrefixes.some((p) => url.startsWith(p));
}

/**
 * Scan one file's text. `file` is the display path (posix, relative to the repo root).
 * Returns findings: { file, line, kind: 'url'|'module'|'api', text }.
 */
function scanText(text, file, allow) {
  const findings = [];
  const fileAllowed = (allow.files || []).map(toPosix).includes(toPosix(file));
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isComment = COMMENT_LINE_RE.test(line);
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(line))) {
      const url = m[0].replace(/[.:]+$/, '');
      if (isComment || isAllowedUrl(url, allow)) continue;
      findings.push({ file, line: i + 1, kind: 'url', text: url });
    }
    if (isComment) continue;
    if (!fileAllowed && MODULE_RE.test(line) && !TYPE_IMPORT_RE.test(line)) {
      findings.push({ file, line: i + 1, kind: 'module', text: line.trim().slice(0, 160) });
    }
    if (!fileAllowed && BROWSER_API_RE.test(line)) {
      findings.push({ file, line: i + 1, kind: 'api', text: line.trim().slice(0, 160) });
    }
  }
  return findings.filter((f) => !isKnownBenign(f, allow));
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && CODE_EXTENSIONS.has(path.extname(e.name).toLowerCase()) && !e.name.endsWith('.map')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Scan every code file under the given roots (relative to cwd). Missing roots are skipped and reported. */
function scanRoots(roots, allow, cwd) {
  const base = cwd || process.cwd();
  const findings = [];
  const scanned = [];
  const missing = [];
  for (const root of roots) {
    const abs = path.resolve(base, root);
    if (!fs.existsSync(abs)) {
      missing.push(root);
      continue;
    }
    for (const file of listFiles(abs)) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;
      const rel = toPosix(path.relative(base, file));
      scanned.push(rel);
      findings.push(...scanText(fs.readFileSync(file, 'utf8'), rel, allow));
    }
  }
  return { findings, scanned, missing };
}

function explain(kind) {
  switch (kind) {
    case 'url':
      return 'a non-loopback URL in code';
    case 'module':
      return 'imports a network module';
    case 'api':
      return 'uses a browser network API';
    default:
      return kind;
  }
}

function parseCliArgs(argv) {
  const o = { roots: [], allowlist: DEFAULT_ALLOWLIST, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.roots.push(argv[++i]);
    else if (a.startsWith('--root=')) o.roots.push(a.slice(7));
    else if (a === '--allowlist') o.allowlist = argv[++i];
    else if (a.startsWith('--allowlist=')) o.allowlist = a.slice(12);
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument "${a}". Usage: check-no-network.js [--root <dir>]... [--allowlist <file>] [--json]`);
  }
  if (!o.roots.length) o.roots = DEFAULT_ROOTS.slice();
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
    console.log('Usage: node scripts/check-no-network.js [--root <dir>]... [--allowlist <file>] [--json]');
    return 0;
  }
  let allow;
  try {
    allow = loadAllowlist(opts.allowlist);
  } catch (e) {
    console.error(`check-no-network: ${e.message}`);
    return 2;
  }
  const { findings, scanned, missing } = scanRoots(opts.roots, allow, process.cwd());
  if (opts.json) {
    console.log(JSON.stringify({ ok: findings.length === 0, scannedFiles: scanned.length, missingRoots: missing, findings }, null, 2));
    return findings.length ? 1 : 0;
  }
  if (scanned.length === 0) {
    console.error(`check-no-network: nothing to scan (roots: ${opts.roots.join(', ')}). Run it from the repo root.`);
    return 2;
  }
  if (missing.length) console.log(`check-no-network: skipped missing root(s): ${missing.join(', ')}`);
  if (!findings.length) {
    console.log(`check-no-network: OK - ${scanned.length} files under ${opts.roots.filter((r) => !missing.includes(r)).join(', ')} contain no network usage beyond 127.0.0.1.`);
    return 0;
  }
  console.error(`check-no-network: ${findings.length} problem(s) in ${new Set(findings.map((f) => f.file)).size} file(s):`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}: ${explain(f.kind)}: ${f.text}`);
  console.error(
    '\nExplainIT must not talk to the network (only 127.0.0.1 for the checkpoint and the user\'s own assistant processes).\n' +
      'Remove the network use, or - only for a link shown to the person (never fetched) - add its prefix to scripts/network-allowlist.json "urlPrefixes".',
  );
  return 1;
}

module.exports = { scanText, scanRoots, listFiles, loadAllowlist, isLoopbackUrl, isAllowedUrl, isKnownBenign, parseCliArgs, DEFAULT_ROOTS, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
