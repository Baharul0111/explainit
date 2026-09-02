/**
 * Converts a DocumentSymbol tree (or a flat SymbolInformation list) into RawFunctions.
 * Works on plain objects mirroring the vscode shapes so it stays unit-testable without `vscode`.
 */
import type { FunctionKind } from '../../core/types';
import { qualify, splitLines, type PositionLike, type RangeLike, type RawFunction } from './normalize';

/** Numeric values of vscode.SymbolKind (stable since the API was introduced). */
export const SymbolKindNum = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

/** Shape shared by vscode.DocumentSymbol (range + children) and vscode.SymbolInformation (location + containerName). */
export interface SymbolLike {
  name: string;
  kind: number;
  detail?: string;
  range?: RangeLike;
  selectionRange?: RangeLike;
  location?: { range: RangeLike };
  containerName?: string;
  children?: SymbolLike[];
}

const CLASS_LIKE = new Set<number>([SymbolKindNum.Class, SymbolKindNum.Struct, SymbolKindNum.Interface, SymbolKindNum.Enum, SymbolKindNum.Object]);
const FUNCTION_LIKE = new Set<number>([SymbolKindNum.Function, SymbolKindNum.Method, SymbolKindNum.Constructor]);
/** Kinds under which a `const add = () => ...` style value may hide a function. */
const VALUE_LIKE = new Set<number>([SymbolKindNum.Variable, SymbolKindNum.Constant, SymbolKindNum.Property, SymbolKindNum.Field]);
const CONSTRUCTOR_NAMES = new Set(['constructor', '__init__', 'initialize', '__new__']);
/** How many lines of a variable declaration are inspected for a function value. */
const VALUE_SNIPPET_LINES = 12;

/**
 * True when a variable/property symbol's text assigns a function or arrow function
 * (`= () => ...`, `= function ...`, `= async (x) => ...`), as VS Code's TypeScript provider reports
 * `const add = () => a + b` as a Variable. A call whose argument is a callback does not count.
 */
export function looksLikeFunctionValue(snippet: string): boolean {
  if (typeof snippet !== 'string' || !/=>|\bfunction\b/.test(snippet)) return false;
  const eq = snippet.search(/(?<![=!<>])=(?![=>])/);
  const rhs = (eq >= 0 ? snippet.slice(eq + 1) : snippet).trimStart().replace(/^async\s+/, '');
  if (/^function\b/.test(rhs)) return true;
  if (/^[A-Za-z_$][\w$]*\s*=>/.test(rhs)) return true;
  // `(params) => ...` or `<T>(params) => ...`: the arrow must follow the parameter list itself,
  // otherwise `(a + b) * items.map(x => x)` or `(cb || function () {})()` would count.
  let i = 0;
  if (rhs[0] === '<') {
    i = matchingClose(rhs, 0, '<', '>');
    if (i < 0) return false;
    i++;
    while (i < rhs.length && /\s/.test(rhs[i])) i++;
  }
  if (rhs[i] !== '(') return false;
  const close = matchingClose(rhs, i, '(', ')');
  // The snippet is only a few lines: a parameter list that runs past it has no closing paren at all.
  if (close < 0) return !rhs.includes(')');
  const after = rhs.slice(close + 1).trimStart();
  return after.startsWith('=>') || (after.startsWith(':') && /=>/.test(after.slice(0, 300)));
}

/** Index of the bracket closing the one at `openAt`, or -1 (strings are not parsed; snippets are short). */
function matchingClose(text: string, openAt: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openAt; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/**
 * rust-analyzer names an impl block `impl Stack` / `impl Display for Stack`; as a qualifier only the
 * type is wanted ("Stack.push"). Other names are used as they are.
 */
export function containerLabel(name: string): string {
  const m = /^impl\b\s*(?:<[^>]*>\s*)?(?:.+?\s+for\s+)?(.+)$/.exec(name);
  if (!m) return name;
  const type = m[1].replace(/<.*$/, '').trim();
  return type.length ? type : name;
}

export interface SymbolsToRawOptions {
  /** Full document text, used to check whether variables hold functions. */
  text: string;
}

/** A usable range from either symbol shape; undefined when the provider sent something malformed. */
function rangeOf(s: SymbolLike): RangeLike | undefined {
  const r = s.range ?? s.location?.range;
  if (!r || typeof r !== 'object') return undefined;
  const ok = (p: PositionLike | undefined): p is PositionLike => !!p && typeof p === 'object' && Number.isFinite(p.line) && Number.isFinite(p.character);
  return ok(r.start) && ok(r.end) ? r : undefined;
}

function isPlaceholderName(name: string): boolean {
  // TypeScript reports anonymous callbacks as "<function>" and anonymous classes as "<class>".
  return /^<.*>$/.test(name.trim()) || name.trim() === '';
}

/**
 * Recursively walks the symbol tree; every symbol qualifies its children with its name.
 * Provider output is treated as untrusted data: malformed entries are skipped, never thrown on.
 */
export function symbolsToRaw(symbols: SymbolLike[], opts: SymbolsToRawOptions): RawFunction[] {
  if (!Array.isArray(symbols)) return [];
  const lines = splitLines(opts.text);
  const out: RawFunction[] = [];
  const isObject = (s: unknown): s is SymbolLike => !!s && typeof s === 'object';
  const roots = symbols.filter(isObject);
  const flat = roots.every((s) => !Array.isArray(s.children) || s.children.length === 0) && roots.some((s) => s.containerName !== undefined);

  const visit = (s: SymbolLike, container: string | undefined, insideClass: boolean, depth: number): void => {
    if (!isObject(s) || depth > 40) return;
    const range = rangeOf(s);
    if (!range) return;
    const rawName = typeof s.name === 'string' ? s.name : s.name === undefined || s.name === null ? '' : String(s.name);
    const placeholder = isPlaceholderName(rawName);
    const name = placeholder ? undefined : rawName.trim();
    const qualified = name ? qualify(container, name) : container;
    const asContainer = name ? qualify(container, containerLabel(name)) : container;
    const startLine = Math.max(0, Math.floor(range.start.line));
    const endLine = range.end.character === 0 && range.end.line > startLine ? Math.floor(range.end.line) - 1 : Math.floor(range.end.line);

    let emitKind: FunctionKind | undefined;
    if (name && FUNCTION_LIKE.has(s.kind)) {
      emitKind = s.kind === SymbolKindNum.Constructor || CONSTRUCTOR_NAMES.has(name) ? 'constructor' : s.kind === SymbolKindNum.Method || insideClass ? 'method' : 'function';
    } else if (name && VALUE_LIKE.has(s.kind)) {
      // The provider's range covers the whole declaration; a dozen lines is enough to see a typed parameter list end.
      const snippet = lines.slice(startLine, Math.min(endLine, startLine + VALUE_SNIPPET_LINES - 1) + 1).join('\n');
      if (looksLikeFunctionValue(snippet)) emitKind = insideClass ? 'method' : 'function';
    }
    if (emitKind && qualified) out.push({ name: qualified, kind: emitKind, range: { startLine, endLine } });

    const childInsideClass = CLASS_LIKE.has(s.kind) || (insideClass && !FUNCTION_LIKE.has(s.kind) && !emitKind);
    if (Array.isArray(s.children)) for (const child of s.children) visit(child, asContainer, childInsideClass, depth + 1);
  };

  if (flat) {
    for (const s of roots) {
      const container = typeof s.containerName === 'string' && s.containerName.trim().length ? containerLabel(s.containerName.trim()) : undefined;
      visit({ ...s, children: undefined }, container, container !== undefined, 0);
    }
  } else {
    for (const s of roots) visit(s, undefined, false, 0);
  }
  return out;
}
