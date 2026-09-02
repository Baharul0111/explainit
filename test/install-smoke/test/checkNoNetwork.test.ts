import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The compiled test lives at <outDir>/test/install-smoke/test, four levels below the repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
// Plain CommonJS script (no types); required directly so the test exercises the shipped file.
const scanner = require(path.join(REPO_ROOT, 'scripts', 'check-no-network.js')) as {
  scanText(text: string, file: string, allow: { urlPrefixes: string[]; files: string[] }): { file: string; line: number; kind: string; text: string }[];
  scanRoots(roots: string[], allow: { urlPrefixes: string[]; files: string[] }, cwd: string): { findings: { file: string; line: number; kind: string; text: string }[]; scanned: string[]; missing: string[] };
  loadAllowlist(file: string): { urlPrefixes: string[]; files: string[]; knownBenign: { file: string; kind: string; contains: string; reason: string }[] };
  isLoopbackUrl(url: string): boolean;
  isKnownBenign(finding: { file: string; kind: string; text: string }, allow: { knownBenign?: { file: string; kind: string; contains: string; reason: string }[] }): boolean;
  isAllowedUrl(url: string, allow: { urlPrefixes: string[]; files: string[] }): boolean;
  snippet(line: string, index: number, length: number): string;
  parseCliArgs(argv: string[]): { roots: string[]; allowlist: string; json: boolean; help: boolean };
  DEFAULT_ROOTS: string[];
};

const noAllow = { urlPrefixes: [], files: [] };

suite('scripts/check-no-network: URLs', () => {
  test('loopback URLs are always allowed', () => {
    for (const u of ['http://127.0.0.1', 'http://127.0.0.1:8080/v1/hook', 'http://localhost:3000/x', 'ws://localhost', 'http://[::1]:1/', 'http://127.0.0.1:${info.port}/v1/health']) {
      assert.equal(scanner.isLoopbackUrl(u), true, u);
    }
    for (const u of ['http://127.0.0.1.evil.com/', 'https://localhost.example.org', 'https://example.com', 'http://localhostx', 'http://127.0.0.1:80@evil.com/', 'http://127.0.0.1@evil.com/']) {
      assert.equal(scanner.isLoopbackUrl(u), false, u);
    }
  });

  test('a non-loopback URL in code is a finding; in a comment line it is not', () => {
    const text = ["const a = fetch('https://example.com/api');", '// see https://example.com/docs', ' * https://docs.example.com', '# https://x.y', "const ok = 'http://127.0.0.1:9/v1/health';"].join('\n');
    const f = scanner.scanText(text, 'src/a.ts', noAllow);
    // Line 1 is reported twice: once for the URL and once for the bare fetch() call itself.
    assert.deepEqual(f, [
      { file: 'src/a.ts', line: 1, kind: 'url', text: 'https://example.com/api' },
      { file: 'src/a.ts', line: 1, kind: 'api', text: "const a = fetch('https://example.com/api');" },
    ]);
  });

  test('allow-listed prefixes pass, trailing punctuation is trimmed, several URLs on one line are all checked', () => {
    const allow = { urlPrefixes: ['https://code.visualstudio.com/'], files: [] };
    const text = "const links = ['https://code.visualstudio.com/docs/copilot/setup', 'https://evil.example/x.', 'https://code.visualstudio.com/api'];";
    const f = scanner.scanText(text, 'src/ux/pure/render.ts', allow);
    assert.deepEqual(f, [{ file: 'src/ux/pure/render.ts', line: 1, kind: 'url', text: 'https://evil.example/x' }]);
    assert.equal(scanner.isAllowedUrl('https://code.visualstudio.com/', allow), true);
    assert.equal(scanner.isAllowedUrl('https://code.visualstudio.com.evil/', allow), false);
  });

  test('minified one-line bundles are scanned too', () => {
    const line = 'var a="http://json-schema.org/draft-07/schema#";var b="https://telemetry.example.com/collect";';
    const f = scanner.scanText(line, 'dist/extension.js', { urlPrefixes: ['http://json-schema.org/'], files: [] });
    assert.equal(f.length, 1);
    assert.equal(f[0].text, 'https://telemetry.example.com/collect');
  });
});

suite('scripts/check-no-network: modules and browser APIs', () => {
  test('imports of https/dns/tls/net/dgram/http2 are findings; http and type-only imports are fine', () => {
    const text = [
      "import * as https from 'node:https';",
      "import type { AddressInfo } from 'node:net';",
      "const dns = require('dns');",
      "import * as http from 'node:http';",
      "const { request } = require('node:http');",
      "import('tls').then(() => {});",
      "import 'https';",
    ].join('\n');
    const f = scanner.scanText(text, 'src/x.ts', noAllow);
    assert.deepEqual(
      f.map((x) => [x.line, x.kind]),
      [
        [1, 'module'],
        [3, 'module'],
        [6, 'module'],
        [7, 'module'],
      ],
    );
  });

  test('a file on the files allowlist may import network modules, but its URLs are still checked', () => {
    const text = ["import * as https from 'https';", "fetch('https://example.com');"].join('\n');
    const f = scanner.scanText(text, 'src/allowed.ts', { urlPrefixes: [], files: ['./src/allowed.ts'] });
    assert.deepEqual(
      f.map((x) => x.kind),
      ['url'],
    );
  });

  test('a bare fetch() call is a finding; method calls and member declarations are not; bundles are exempt from the bare-fetch rule', () => {
    const text = [
      "const r = await fetch('http://127.0.0.1:1/v1/health');", // 1: bare fetch, even to loopback (the URL rule is separate)
      'const s = await symbols.fetch(uri, languageId);', // 2: a method
      '  fetch(uri: vscode.Uri, languageId: string): Promise<SymbolFetchResult>;', // 3: interface member
      '  async fetch(uri) {', // 4: class method definition
      'return globalThis.fetch(url);', // 5
      'const f = (u) => fetch(u);', // 6
      'const x = { prefetch(u) {} }; prefetch(u); refetch(u);', // 7: other identifiers
      "doFetch('https://api.example.com');", // 8: url only
    ].join('\n');
    const f = scanner.scanText(text, 'src/x.ts', noAllow);
    assert.deepEqual(
      f.map((x) => [x.line, x.kind]),
      [
        [1, 'api'],
        [5, 'api'],
        [6, 'api'],
        [8, 'url'],
      ],
    );
    assert.match(f[0].text, /^const r = await fetch\(/);
    // A minified bundle keeps method names, so `fetch(` there is indistinguishable from a definition.
    const bundle = 'var a={fetch(e,t){return 1}};async function b(){return await fetch(u)}';
    assert.deepEqual(scanner.scanText(bundle, 'dist/extension.js', noAllow), []);
    // The same text in a source root is checked strictly: the minified method definition is not at the
    // start of a line, so it and the real call are both reported (sources are never minified).
    assert.equal(scanner.scanText(bundle, 'src/extension.js', noAllow).length, 2);
    // Other APIs stay findings in bundles.
    assert.equal(scanner.scanText('var w=new WebSocket(u);', 'dist/extension.js', noAllow).length, 1);
  });

  test('API findings carry a snippet around the match, so a one-line minified bundle is still readable', () => {
    const filler = 'a'.repeat(500);
    const line = `${filler}var x=new XMLHttpRequest();${filler}var y=new EventSource(u);${filler}`;
    const f = scanner.scanText(line, 'media/x.js', noAllow);
    assert.equal(f.length, 2, 'one finding per match, not per line');
    assert.ok(f[0].text.includes('new XMLHttpRequest()'), f[0].text);
    assert.ok(f[1].text.includes('new EventSource('), f[1].text);
    assert.ok(f[0].text.length < 200, 'snippets are short');
    assert.ok(f[0].text.startsWith('...') && f[0].text.endsWith('...'));
    assert.equal(scanner.snippet('short line', 0, 5), 'short line');
    assert.equal(scanner.snippet('x'.repeat(100) + 'MATCH' + 'y'.repeat(100), 100, 5), '...' + 'x'.repeat(40) + 'MATCH' + 'y'.repeat(80) + '...');
  });

  test('browser network APIs in webview code are findings', () => {
    const text = ['const x = new XMLHttpRequest();', "const s = new WebSocket('ws://127.0.0.1:1');", 'navigator.sendBeacon(u, d);', 'const e = new EventSource(u);', 'const fine = document.createElement("a");'].join('\n');
    const f = scanner.scanText(text, 'media/review/main.js', noAllow);
    assert.deepEqual(
      f.map((x) => [x.line, x.kind]),
      [
        [1, 'api'],
        [2, 'api'],
        [3, 'api'],
        [4, 'api'],
      ],
    );
  });
});

suite('scripts/check-no-network: directories and allowlist file', () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-nonet-'));
  });
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('scanRoots walks code files, skips node_modules/wasm/maps/binaries and reports missing roots', () => {
    fs.mkdirSync(path.join(dir, 'src', 'node_modules', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist', 'wasm'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'ok.ts'), "const u = 'http://127.0.0.1:1/';\n");
    fs.writeFileSync(path.join(dir, 'src', 'bad.ts'), "const u = 'https://example.com/';\n");
    fs.writeFileSync(path.join(dir, 'src', 'node_modules', 'dep', 'index.js'), "fetch('https://ignored.example/');\n");
    fs.writeFileSync(path.join(dir, 'src', 'bad.ts.map'), '{"https://ignored.example/":1}');
    fs.writeFileSync(path.join(dir, 'src', 'icon.png'), 'https://ignored.example/');
    fs.writeFileSync(path.join(dir, 'dist', 'wasm', 'x.js'), "fetch('https://ignored.example/');\n");
    fs.writeFileSync(path.join(dir, 'dist', 'extension.js'), '"use strict";var a="https://bundled.example/";\n');
    const r = scanner.scanRoots(['src', 'dist', 'hooks'], noAllow, dir);
    assert.deepEqual(r.missing, ['hooks']);
    // Roots are scanned in the order given; files within a root are sorted.
    assert.deepEqual(r.scanned, ['src/bad.ts', 'src/ok.ts', 'dist/extension.js']);
    assert.deepEqual(
      r.findings.map((f) => `${f.file}:${f.line}:${f.text}`),
      ['src/bad.ts:1:https://example.com/', 'dist/extension.js:1:https://bundled.example/'],
    );
  });

  test('loadAllowlist validates and normalises', () => {
    const file = path.join(dir, 'allow.json');
    fs.writeFileSync(file, JSON.stringify({ urlPrefixes: ['https://a/', 7, ''], files: ['./src/x.ts'] }));
    assert.deepEqual(scanner.loadAllowlist(file), { urlPrefixes: ['https://a/'], files: ['src/x.ts'], knownBenign: [] });
    fs.writeFileSync(
      file,
      JSON.stringify({ knownBenign: [{ file: './dist/extension.js', kind: 'api', contains: 'new XMLHttpRequest()', reason: 'browser-only branch' }, { file: 'dist/x.js', kind: 'api', contains: 'x' }, { file: 'dist/y.js', kind: 'api', contains: 'y', reason: ' ' }] }),
    );
    assert.deepEqual(scanner.loadAllowlist(file).knownBenign, [{ file: 'dist/extension.js', kind: 'api', contains: 'new XMLHttpRequest()', reason: 'browser-only branch' }], 'entries without a reason are dropped');
    fs.writeFileSync(file, '{oops');
    assert.throws(() => scanner.loadAllowlist(file), /not valid JSON/);
    assert.throws(() => scanner.loadAllowlist(path.join(dir, 'missing.json')), /Cannot read the allowlist/);
  });

  test('the shipped allowlist is valid and only lists display links and schema ids', () => {
    const allow = scanner.loadAllowlist(path.join(REPO_ROOT, 'scripts', 'network-allowlist.json'));
    assert.ok(allow.urlPrefixes.length >= 3);
    for (const p of allow.urlPrefixes) assert.match(p, /^https?:\/\//, p);
    assert.deepEqual(allow.files, []);
    for (const k of allow.knownBenign) {
      assert.match(k.file, /^dist\//, 'knownBenign is only for bundled dependencies, never our own sources');
      assert.ok(k.reason.length > 20, 'every knownBenign entry explains why');
    }
  });

  test('knownBenign silences only the exact file + kind + text it names', () => {
    const allow = { urlPrefixes: [], files: [], knownBenign: [{ file: 'dist/extension.js', kind: 'api', contains: 'new XMLHttpRequest()', reason: 'browser-only branch of a bundled loader' }] };
    const text = ['var xhr = new XMLHttpRequest();', "var ws = new WebSocket('wss://x');"].join('\n');
    // Line 2 yields both a non-loopback wss:// URL and the WebSocket API; neither is silenced.
    assert.deepEqual(
      scanner.scanText(text, 'dist/extension.js', allow).map((f) => f.kind + ':' + f.line),
      ['url:2', 'api:2'],
    );
    assert.equal(scanner.scanText(text, 'src/x.ts', allow).length, 3, 'the same code in our own sources still fails');
    assert.equal(scanner.isKnownBenign({ file: 'dist/extension.js', kind: 'url', text: 'new XMLHttpRequest()' }, allow), false, 'kind must match');
    assert.equal(scanner.isKnownBenign({ file: 'dist/extension.js', kind: 'api', text: 'x = new XMLHttpRequest();' }, {}), false);
  });

  test('parseCliArgs', () => {
    assert.deepEqual(scanner.parseCliArgs([]).roots, scanner.DEFAULT_ROOTS);
    const o = scanner.parseCliArgs(['--root', 'a', '--root=b', '--json', '--allowlist=x.json']);
    assert.deepEqual(o.roots, ['a', 'b']);
    assert.equal(o.json, true);
    assert.equal(o.allowlist, 'x.json');
    assert.throws(() => scanner.parseCliArgs(['--nope']), /Unknown argument/);
  });
});
