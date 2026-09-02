/**
 * Small text helpers shared by the gate's pure modules. No `vscode` import.
 */
import * as path from 'node:path';

export type Eol = '\n' | '\r\n';

/** The dominant line ending of a text; defaults to LF for empty or single-line text. */
export function detectEol(text: string | null | undefined): Eol {
  if (!text) return '\n';
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(^|[^\r])\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/** Convert LF text to the given line ending (idempotent for LF). */
export function withEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n?/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/** Split normalised text into lines. A trailing newline does not create an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Inverse of splitLines for text that ended with a newline (or was empty). */
export function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.py': 'python',
  '.pyi': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.m': 'objective-c',
  '.mm': 'objective-cpp',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.zsh': 'shellscript',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.lua': 'lua',
  '.pl': 'perl',
  '.pm': 'perl',
  '.r': 'r',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.clj': 'clojure',
  '.cob': 'cobol',
  '.cbl': 'cobol',
  '.md': 'markdown',
  '.txt': 'plaintext',
  '.ipynb': 'jupyter',
  '.dockerfile': 'dockerfile',
  '.tf': 'terraform',
  '.zig': 'zig',
  '.nim': 'nim',
  '.groovy': 'groovy',
  '.gradle': 'groovy',
};

/** VS Code-style language id for a file path (best effort; 'plaintext' when unknown). */
export function languageIdForPath(p: string): string {
  const base = path.basename(p).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const ext = path.extname(base);
  return EXT_TO_LANGUAGE[ext] ?? 'plaintext';
}

/** Extensions that count as "code" for the shell heuristics (config files included: they change behaviour). */
export const CODE_EXTENSIONS = new Set(
  Object.keys(EXT_TO_LANGUAGE).filter((e) => !['.md', '.txt'].includes(e)),
);

export function isCodeFile(p: string): boolean {
  const base = path.basename(p.replace(/["']/g, '')).toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') return true;
  return CODE_EXTENSIONS.has(path.extname(base));
}
