/**
 * Language-agnostic heuristic outliner (fallback 2). Finds definition lines with regexes
 * (def/function/func/fn/sub/procedure/proc/method, C-style `name(...) {`, shell `name() {`,
 * COBOL paragraph names) and closes each block by brace matching or by indentation.
 * Deliberately conservative: a false "function" costs assistant credits, a missed one is only a gap.
 */
import type { FunctionKind } from '../../core/types';
import { qualify, splitLines, type RawFunction } from './normalize';

/**
 * `def name(`, `func (r *T) Name(`, `sub name {`, `procedure Name;` ... The name must be followed by
 * something a definition has (parameters, a block, a type, a terminator, `do`/`is`/`begin`, or the end
 * of the line) so that a prose line such as "function names should be short" is not a definition.
 */
const KEYWORD_DEF_RE =
  /^(\s*)\(?(?:(?:export|default|public|private|protected|internal|static|async|pub(?:\([^)]*\))?|unsafe|extern|inline|override|final|abstract|local|my|our|const|virtual|open|suspend|declare|function)\s+)*(?:def|defn|defp|fn|func|function|sub|procedure|proc|method|fun|defun)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$.:!?-]*)(?=\s*(?:$|[(<{:=[;,!*]|->)|\s+(?:do|is|as|where|begin|returns?)\b)/;
const CONTAINER_RE =
  /^(\s*)(?:(?:export|default|public|private|protected|internal|static|abstract|final|sealed|data|open|pub(?:\([^)]*\))?|unsafe|declare|partial)\s+)*(?:class|struct|impl|trait|object|module|namespace|interface|enum|record|union)\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*(?:::\w+)*)/;
const SHELL_DEF_RE = /^(\s*)(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*(\{)?\s*$/;
/** `const name = function (...) {` / `name = async (x) => {` (JS-like assignments of function values). */
const ASSIGN_FN_RE =
  /^(\s*)(?:(?:export|default|const|let|var|static|public|private|protected|readonly)\s+)*([A-Za-z_$][\w$.]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b[^(]*\(|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/;
const CSTYLE_DEF_RE =
  /^(\s*)(?:(?:[A-Za-z_][\w:<>,*&\[\]]*\s+)*(?:[A-Za-z_][\w:<>,*&\[\]]*[\s*&]+))?([A-Za-z_~][\w:~]*)\s*\(([^;{}()]*(?:\([^;{}()]*\)[^;{}()]*)*)\)\s*(?:const|override|final|noexcept|throws\s+[\w,\s.]+)?\s*(?:->\s*[\w:<>*&?]+|:\s*[^;{}=]+?)?\s*(\{.*)?$/;
const COBOL_PARAGRAPH_RE = /^ {7}([A-Za-z0-9][A-Za-z0-9-]*)\.\s*$/;
const BLOCK_END_WORD_RE = /^\s*(?:end\b|End\s+(?:Sub|Function|Procedure|Class|Module)\b|fi\b|done\b|esac\b|\}|\)|\]|end\.|end;)/;

const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'else', 'catch', 'do', 'sizeof', 'case', 'new', 'delete', 'throw', 'using',
  'namespace', 'typedef', 'foreach', 'lock', 'synchronized', 'with', 'until', 'unless', 'elif', 'elsif', 'try', 'finally',
  'match', 'select', 'when', 'assert', 'require', 'import', 'include', 'defined', 'not', 'and', 'or', 'print', 'echo',
  'exit', 'yield', 'await', 'typeof', 'instanceof', 'void', 'super', 'this', 'self', 'elseif', 'loop', 'go', 'defer',
  'goto', 'break', 'continue', 'default', 'let', 'var', 'const',
]);
const CONSTRUCTOR_NAMES = new Set(['constructor', '__init__', 'initialize', '__new__', 'init', 'new']);
const COBOL_RESERVED = /^(?:IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE|PROGRAM-ID|AUTHOR|DATE-WRITTEN|WORKING-STORAGE|FILE|LINKAGE|CONFIGURATION|INPUT-OUTPUT|FILE-CONTROL|SPECIAL-NAMES)$/i;

interface Frame {
  name: string;
  indent: number;
  endLine: number;
  isContainer: boolean;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('--') ||
    trimmed.startsWith(';') ||
    trimmed.startsWith("'") ||
    /^rem\b/i.test(trimmed)
  );
}

function nextNonBlank(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) if (lines[i].trim().length) return i;
  return -1;
}

/**
 * Finds the line of the matching `}` for the first `{` at or after `fromLine` (which must be within the
 * next non-blank line), skipping string literals and comments. Returns -1 when no brace opens or it never closes.
 */
export function findBraceBlockEnd(lines: string[], fromLine: number, openCol = 0): number {
  let line = fromLine;
  let col = openCol;
  let depth = 0;
  let opened = false;
  let inBlockComment = false;
  let quote: string | undefined;
  // Only accept the opening brace on the definition line or the next non-blank one (Allman style).
  const limitOpen = Math.max(fromLine, nextNonBlank(lines, fromLine + 1));
  for (; line < lines.length; line++, col = 0) {
    const text = lines[line];
    if (!opened && line > limitOpen) return -1;
    for (; col < text.length; col++) {
      const ch = text[col];
      const next = text[col + 1];
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          col++;
        }
        continue;
      }
      if (quote) {
        if (ch === '\\') col++;
        else if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === '/' && next === '/') break;
      if (ch === '#' && !opened && col === 0) break;
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        col++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        if (!opened) continue;
        depth--;
        if (depth === 0) return line;
      }
    }
    if (!opened && line > fromLine && text.trim().length && !text.trim().startsWith('{')) return -1;
  }
  return -1;
}

/**
 * Last line of a block that is delimited by indentation: every following line indented deeper than
 * `indent` belongs to it (blank lines are skipped), and a closing word (`end`, `}`) at the same
 * indentation is included. Returns `defLine` for a one-line definition.
 */
export function findIndentBlockEnd(lines: string[], defLine: number, indent: number): number {
  let end = defLine;
  // Pascal-style `procedure X; begin ... end;` at one indentation: close on the matching `end` line.
  const nb = nextNonBlank(lines, defLine + 1);
  if (nb >= 0 && indentOf(lines[nb]) === indent && /^\s*begin\b/i.test(lines[nb])) {
    let depth = 0;
    for (let i = nb; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^begin\b/i.test(t)) depth++;
      if (/^end\b/i.test(t) && --depth === 0) return i;
    }
  }
  for (let i = defLine + 1; i < lines.length; i++) {
    const text = lines[i];
    if (!text.trim().length) continue;
    const ind = indentOf(text);
    if (ind > indent) {
      end = i;
      continue;
    }
    if (ind === indent && BLOCK_END_WORD_RE.test(text) && end > defLine) end = i;
    break;
  }
  return end;
}

function blockEnd(lines: string[], defLine: number, indent: number, _matchEndIndex: number, hasBraceOnLine: boolean): number {
  const line = lines[defLine];
  if (hasBraceOnLine || line.includes('{')) {
    // A line ending with `{` opens its block there; a one-liner (`int f() { return 1; }`) is scanned whole.
    const openCol = line.trimEnd().endsWith('{') ? line.lastIndexOf('{') : 0;
    const e = findBraceBlockEnd(lines, defLine, openCol);
    if (e >= 0) return e;
  } else {
    const nb = nextNonBlank(lines, defLine + 1);
    if (nb >= 0 && lines[nb].trim().startsWith('{')) {
      const e = findBraceBlockEnd(lines, nb, 0);
      if (e >= 0) return e;
    }
  }
  return findIndentBlockEnd(lines, defLine, indent);
}

/** COBOL: a paragraph name in area A (column 8) ending with a period, followed by indented statements. */
function cobolParagraphEnd(lines: string[], defLine: number): number {
  const nb = nextNonBlank(lines, defLine + 1);
  if (nb < 0 || indentOf(lines[nb]) <= 7) return -1;
  let end = defLine;
  for (let i = defLine + 1; i < lines.length; i++) {
    const text = lines[i];
    if (!text.trim().length) continue;
    if (indentOf(text) <= 7) break;
    end = i;
  }
  return end;
}

export interface HeuristicMatch extends RawFunction {
  line: number;
}

/**
 * Heuristic outline of `text`. Nested definitions are qualified with their enclosing definition or
 * container ("Class.method", "outer.inner").
 */
export function heuristicFunctions(text: string, languageId?: string): RawFunction[] {
  const lines = splitLines(text);
  const out: RawFunction[] = [];
  const stack: Frame[] = [];
  let inTripleQuote = false;
  const cobolish = languageId === 'cobol' || /\bPROCEDURE DIVISION\b/i.test(text);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    while (stack.length && stack[stack.length - 1].endLine < i) stack.pop();
    if (!trimmed.length) continue;
    // Python-style docstrings: toggle on an odd number of triple quotes on the line.
    const triples = (line.match(/"""|'''/g) ?? []).length;
    if (inTripleQuote) {
      if (triples % 2 === 1) inTripleQuote = false;
      continue;
    }
    if (triples % 2 === 1) inTripleQuote = true;
    if (isCommentLine(trimmed)) continue;

    const container = stack.length ? stack[stack.length - 1] : undefined;
    const containerName = container?.name;
    const insideClass = stack.some((f) => f.isContainer);

    let m: RegExpExecArray | null;
    if (cobolish && (m = COBOL_PARAGRAPH_RE.exec(line)) && !COBOL_RESERVED.test(m[1])) {
      const end = cobolParagraphEnd(lines, i);
      if (end >= 0) {
        out.push({ name: m[1], kind: 'function', range: { startLine: i, endLine: end } });
        continue;
      }
    }

    if ((m = CONTAINER_RE.exec(line))) {
      const indent = indentOf(line);
      const end = blockEnd(lines, i, indent, m[0].length, line.includes('{'));
      stack.push({ name: qualify(containerName, m[2]), indent, endLine: end, isContainer: true });
      continue;
    }

    if ((m = KEYWORD_DEF_RE.exec(line))) {
      const indent = indentOf(line);
      const rawName = m[2].replace(/^self\./, '').replace(/::/g, '.');
      const name = qualify(containerName, rawName);
      const end = blockEnd(lines, i, indent, m[0].length, line.includes('{'));
      out.push({ name, kind: kindFor(rawName, insideClass, container), range: { startLine: i, endLine: end } });
      stack.push({ name, indent, endLine: end, isContainer: false });
      continue;
    }

    if ((m = ASSIGN_FN_RE.exec(line))) {
      const indent = indentOf(line);
      const rawName = m[2];
      const end = blockEnd(lines, i, indent, m[0].length, line.includes('{'));
      const name = rawName.includes('.') ? rawName : qualify(containerName, rawName);
      out.push({ name, kind: kindFor(rawName, insideClass, container), range: { startLine: i, endLine: end } });
      stack.push({ name, indent, endLine: end, isContainer: false });
      continue;
    }

    if ((m = SHELL_DEF_RE.exec(line)) && !CONTROL_WORDS.has(m[2])) {
      const indent = indentOf(line);
      const nb = nextNonBlank(lines, i + 1);
      const hasBrace = m[3] !== undefined || (nb >= 0 && lines[nb].trim().startsWith('{'));
      if (hasBrace) {
        const end = blockEnd(lines, i, indent, m[0].length, m[3] !== undefined);
        const name = qualify(containerName, m[2]);
        out.push({ name, kind: kindFor(m[2], insideClass, container), range: { startLine: i, endLine: end } });
        stack.push({ name, indent, endLine: end, isContainer: false });
        continue;
      }
    }

    if ((m = CSTYLE_DEF_RE.exec(line))) {
      const rawName = m[2];
      const bare = rawName.replace(/^.*::/, '').replace(/^~/, '');
      if (CONTROL_WORDS.has(bare) || CONTROL_WORDS.has(rawName)) continue;
      // `describe('x', () => {` is a call with a callback argument, not a definition.
      if (/=>|\bfunction\b/.test(m[3])) continue;
      // Definitions must open a block: `{` on this line or on the next non-blank line.
      const nb = nextNonBlank(lines, i + 1);
      const hasBrace = m[4] !== undefined || (nb >= 0 && lines[nb].trim().startsWith('{'));
      if (!hasBrace) continue;
      if (/^\s*(?:return|throw|await|yield|new)\b/.test(line)) continue;
      const indent = indentOf(line);
      const end = blockEnd(lines, i, indent, m[0].length, m[4] !== undefined);
      const displayName = rawName.replace(/::/g, '.');
      const name = displayName.includes('.') ? displayName : qualify(containerName, displayName);
      out.push({ name, kind: kindFor(bare, insideClass, container), range: { startLine: i, endLine: end } });
      stack.push({ name, indent, endLine: end, isContainer: false });
      continue;
    }
  }
  return out;
}

function kindFor(name: string, insideClass: boolean, container: Frame | undefined): FunctionKind {
  const simple = name.split('.').pop() ?? name;
  if (container?.isContainer && (CONSTRUCTOR_NAMES.has(simple) || simple === container.name.split('.').pop())) return 'constructor';
  return insideClass ? 'method' : 'function';
}
