/**
 * Which documents get a twin. Everything is code unless it is on the deny list (goal item 4:
 * "every programming language the editor understands"); backfill maps extensions to language ids
 * because files on disk have no VS Code language id yet.
 */
import * as path from 'node:path';

/** Sources larger than this are never explained (would blow the token budget and the UI). */
export const MAX_TWIN_SOURCE_BYTES = 2 * 1024 * 1024;

/** Language ids that hold data or prose, not functions. Dockerfile is deliberately kept as code. */
export const NON_CODE_LANGUAGES: ReadonlySet<string> = new Set([
  'plaintext',
  'markdown',
  'json',
  'jsonc',
  'jsonl',
  'yaml',
  'xml',
  'csv',
  'tsv',
  'log',
  'ini',
  'properties',
  'toml',
  'dotenv',
  'git-commit',
  'git-rebase',
  'diff',
  'scminput',
  'restructuredtext',
  'latex',
  'bibtex',
  'pip-requirements',
  'search-result',
  'code-text-binary',
  'raw',
  'binary',
]);

export function isCodeLanguage(languageId: string): boolean {
  return !NON_CODE_LANGUAGES.has((languageId || '').toLowerCase());
}

/** Extension (without dot, lower-case) -> VS Code language id, for files not open in the editor. */
export const EXT_TO_LANGUAGE: Readonly<Record<string, string>> = {
  py: 'python', pyw: 'python', pyi: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy',
  go: 'go', rs: 'rust',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp', fs: 'fsharp', vb: 'vb',
  m: 'objective-c', mm: 'objective-cpp', swift: 'swift',
  rb: 'ruby', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua', r: 'r', jl: 'julia', dart: 'dart',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', mli: 'ocaml', clj: 'clojure', cljs: 'clojure',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', ps1: 'powershell', bat: 'bat', cmd: 'bat',
  sql: 'sql', vue: 'vue', svelte: 'svelte',
  cob: 'cobol', cbl: 'cobol', f: 'fortran', f90: 'fortran', for: 'fortran', pas: 'pascal', ada: 'ada', adb: 'ada',
  zig: 'zig', nim: 'nim', v: 'v', sol: 'solidity', tf: 'terraform', proto: 'proto',
  dockerfile: 'dockerfile',
};

const SPECIAL_NAMES: Readonly<Record<string, string>> = { dockerfile: 'dockerfile', makefile: 'makefile' };

/** Language id for a path on disk, or undefined when the extension is not a known code language. */
export function languageIdForPath(p: string): string | undefined {
  const base = path.basename(p).toLowerCase();
  if (SPECIAL_NAMES[base]) return SPECIAL_NAMES[base];
  const ext = path.extname(base).slice(1);
  if (!ext) return undefined;
  return EXT_TO_LANGUAGE[ext];
}

export function isCodeFilePath(p: string): boolean {
  return languageIdForPath(p) !== undefined;
}
