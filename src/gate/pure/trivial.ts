/**
 * Trivial-change detection (CONTRACTS "Per-function review"): strip comments and whitespace by
 * language, best effort; equal -> trivial. Pure.
 */

type CommentStyle = {
  line: string[];
  block: [string, string][];
  /** Python-style triple-quoted strings treated as comments (docstrings). */
  tripleQuotes?: boolean;
};

const C_LIKE: CommentStyle = { line: ['//'], block: [['/*', '*/']] };
const HASH: CommentStyle = { line: ['#'], block: [] };
const STYLES: Record<string, CommentStyle> = {
  javascript: C_LIKE,
  javascriptreact: C_LIKE,
  typescript: C_LIKE,
  typescriptreact: C_LIKE,
  java: C_LIKE,
  c: C_LIKE,
  cpp: C_LIKE,
  csharp: C_LIKE,
  go: C_LIKE,
  rust: C_LIKE,
  swift: C_LIKE,
  kotlin: C_LIKE,
  scala: C_LIKE,
  dart: C_LIKE,
  groovy: C_LIKE,
  'objective-c': C_LIKE,
  'objective-cpp': C_LIKE,
  zig: C_LIKE,
  php: { line: ['//', '#'], block: [['/*', '*/']] },
  css: { line: [], block: [['/*', '*/']] },
  scss: C_LIKE,
  less: C_LIKE,
  jsonc: C_LIKE,
  python: { line: ['#'], block: [], tripleQuotes: true },
  ruby: { line: ['#'], block: [['=begin', '=end']] },
  shellscript: HASH,
  powershell: { line: ['#'], block: [['<#', '#>']] },
  yaml: HASH,
  toml: HASH,
  perl: HASH,
  r: HASH,
  elixir: HASH,
  nim: HASH,
  dockerfile: HASH,
  makefile: HASH,
  terraform: { line: ['#', '//'], block: [['/*', '*/']] },
  sql: { line: ['--'], block: [['/*', '*/']] },
  lua: { line: ['--'], block: [['--[[', ']]']] },
  haskell: { line: ['--'], block: [['{-', '-}']] },
  elm: { line: ['--'], block: [['{-', '-}']] },
  ada: { line: ['--'], block: [] },
  vhdl: { line: ['--'], block: [] },
  clojure: { line: [';'], block: [] },
  lisp: { line: [';'], block: [] },
  scheme: { line: [';'], block: [] },
  asm: { line: [';'], block: [] },
  ini: { line: [';', '#'], block: [] },
  erlang: { line: ['%'], block: [] },
  latex: { line: ['%'], block: [] },
  html: { line: [], block: [['<!--', '-->']] },
  xml: { line: [], block: [['<!--', '-->']] },
  vue: { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']] },
  svelte: { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']] },
  ocaml: { line: [], block: [['(*', '*)']] },
  cobol: { line: ['*>'], block: [] },
};

/**
 * Remove comments (respecting simple string literals so `//` inside a string survives) and then all
 * whitespace. Unknown languages only lose whitespace: we never guess a comment syntax that could hide
 * a real change (e.g. `#include` in C).
 */
export function stripForTrivial(text: string, languageId: string): string {
  const style = STYLES[languageId];
  let out = '';
  if (!style) {
    out = text;
  } else {
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      // String literals: copy verbatim.
      if (style.tripleQuotes && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
        const q = text.slice(i, i + 3);
        const end = text.indexOf(q, i + 3);
        // Docstrings are comments for our purposes: drop them.
        i = end < 0 ? n : end + 3;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1;
        while (j < n && text[j] !== ch) {
          if (text[j] === '\\') j++;
          if (text[j] === '\n' && ch !== '`') break;
          j++;
        }
        out += text.slice(i, Math.min(n, j + 1));
        i = j + 1;
        continue;
      }
      const block = style.block.find(([open]) => text.startsWith(open, i));
      if (block) {
        const end = text.indexOf(block[1], i + block[0].length);
        i = end < 0 ? n : end + block[1].length;
        continue;
      }
      const line = style.line.find((open) => text.startsWith(open, i));
      if (line) {
        const end = text.indexOf('\n', i);
        i = end < 0 ? n : end;
        continue;
      }
      out += ch;
      i++;
    }
  }
  return out.replace(/\s+/g, '');
}

/** True when before and after differ only in whitespace and/or comments. */
export function isTrivialChange(before: string, after: string, languageId: string): boolean {
  if (before === after) return true;
  return stripForTrivial(before, languageId) === stripForTrivial(after, languageId);
}
