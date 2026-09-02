/**
 * tree-sitter WASM fallback (REQ-012). Lazily initialises web-tree-sitter, loads one grammar at a
 * time (cached) and turns the syntax tree into RawFunctions. No `vscode` import: the wasm directory is
 * passed in (dist/wasm in the packaged extension, node_modules in unit tests).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as WTS from '@vscode/tree-sitter-wasm';
import { jitter, sleep, withTimeout } from '../../core/cancel';
import type { CancelToken } from '../../core/interfaces';
import type { Logger } from '../../core/log';
import type { FunctionKind } from '../../core/types';
import { normalizeNewlines } from '../../core/hash';
import { qualify, type RawFunction } from './normalize';

/** VS Code language id -> bundled grammar name (`tree-sitter-<grammar>.wasm`). C files use the C++ grammar. */
export const GRAMMAR_BY_LANGUAGE: Readonly<Record<string, string>> = {
  python: 'python',
  javascript: 'javascript',
  javascriptreact: 'javascript',
  typescript: 'typescript',
  typescriptreact: 'tsx',
  java: 'java',
  go: 'go',
  c: 'cpp',
  cpp: 'cpp',
  rust: 'rust',
};

export const RUNTIME_WASM = 'tree-sitter.wasm';

/**
 * Where the wasm files live: `<extensionPath>/dist/wasm` when the extension is built, otherwise the
 * npm package (unit tests, development). Undefined when neither exists.
 */
export function resolveWasmDir(extensionPath: string): string | undefined {
  const candidates = [path.join(extensionPath, 'dist', 'wasm'), path.join(extensionPath, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')];
  try {
    candidates.push(path.dirname(require.resolve('@vscode/tree-sitter-wasm')));
  } catch {
    /* not resolvable from here */
  }
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, RUNTIME_WASM))) return dir;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

type TreeSitterModule = typeof WTS;

export interface TreeSitterServiceOptions {
  wasmDir: string;
  logger?: Logger;
  /** A parse that takes longer than this is abandoned (returns undefined). Default 3000. */
  parseTimeoutMs?: number;
  /** Timeout for loading the runtime or a grammar. Default 10000. */
  loadTimeoutMs?: number;
  /** Test seam: replaces `require('@vscode/tree-sitter-wasm')`. */
  loadModule?: () => TreeSitterModule;
}

export interface TreeSitterParseResult {
  functions: RawFunction[];
  /** The grammar reported syntax errors; callers may prefer another source when nothing was found. */
  hasError: boolean;
}

interface Family {
  functionTypes: string[];
  containerTypes: string[];
  /** Name of a function node, or undefined when it is anonymous / not a definition we report. */
  functionName(node: WTS.Node): string | undefined;
  /** Name of a container node (class, impl, namespace...). */
  containerName(node: WTS.Node): string | undefined;
  /** Node whose lines the record should span (e.g. the decorated_definition or template_declaration wrapper). */
  rangeNode?(node: WTS.Node): WTS.Node;
  /** True when this container qualifies members as methods (classes) rather than plain functions (namespaces). */
  classLike(node: WTS.Node): boolean;
}

const fieldText = (node: WTS.Node, field: string): string | undefined => node.childForFieldName(field)?.text;
const stripGenerics = (s: string): string => s.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '').replace(/\[[^\]]*\]/g, '').trim();

/** JS/TS/JSX/TSX: declarations plus function values assigned to names. */
const JS_FAMILY: Family = {
  functionTypes: ['function_declaration', 'generator_function_declaration', 'method_definition', 'function_expression', 'arrow_function', 'generator_function', 'function'],
  containerTypes: ['class_declaration', 'abstract_class_declaration', 'class', 'internal_module', 'module', 'object'],
  functionName(node) {
    const t = node.type;
    if (t === 'function_declaration' || t === 'generator_function_declaration' || t === 'method_definition') {
      const name = fieldText(node, 'name');
      if (name) return name;
      // `export default function () {}`
      return node.parent?.type === 'export_statement' ? 'default' : undefined;
    }
    // Function values: named only through the thing they are assigned to.
    const parent = node.parent;
    if (!parent) return undefined;
    const value = parent.childForFieldName('value');
    if (parent.type === 'variable_declarator' && value?.equals(node)) {
      const name = parent.childForFieldName('name');
      return name && name.type === 'identifier' ? name.text : undefined;
    }
    if (parent.type === 'pair' && value?.equals(node)) return fieldText(parent, 'key')?.replace(/^['"`]|['"`]$/g, '');
    if (parent.type === 'public_field_definition' && value?.equals(node)) return fieldText(parent, 'name');
    if (parent.type === 'assignment_expression' && parent.childForFieldName('right')?.equals(node)) {
      const left = fieldText(parent, 'left');
      return left && /^[\w$.]+$/.test(left) ? left : undefined;
    }
    if (parent.type === 'export_statement' && value?.equals(node)) return 'default';
    return undefined;
  },
  containerName(node) {
    const name = fieldText(node, 'name');
    if (name) return name;
    // `const Foo = class { ... }` / `const obj = { run() {} }`
    const parent = node.parent;
    if (parent?.type === 'variable_declarator' && parent.childForFieldName('value')?.equals(node)) return fieldText(parent, 'name');
    if (parent?.type === 'pair' && parent.childForFieldName('value')?.equals(node)) return fieldText(parent, 'key')?.replace(/^['"`]|['"`]$/g, '');
    return undefined;
  },
  rangeNode(node) {
    const p = node.parent;
    if (p && (p.type === 'variable_declarator' || p.type === 'pair' || p.type === 'public_field_definition' || p.type === 'assignment_expression')) return p;
    return node;
  },
  classLike(node) {
    return node.type !== 'internal_module' && node.type !== 'module' && node.type !== 'object';
  },
};

const PYTHON_FAMILY: Family = {
  functionTypes: ['function_definition'],
  containerTypes: ['class_definition'],
  functionName: (node) => fieldText(node, 'name'),
  containerName: (node) => fieldText(node, 'name'),
  rangeNode: (node) => (node.parent?.type === 'decorated_definition' ? node.parent : node),
  classLike: () => true,
};

const JAVA_FAMILY: Family = {
  functionTypes: ['method_declaration', 'constructor_declaration'],
  containerTypes: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration'],
  functionName: (node) => fieldText(node, 'name'),
  containerName: (node) => fieldText(node, 'name'),
  classLike: () => true,
};

const GO_FAMILY: Family = {
  functionTypes: ['function_declaration', 'method_declaration', 'func_literal'],
  containerTypes: [],
  functionName(node) {
    if (node.type === 'function_declaration') return fieldText(node, 'name');
    if (node.type === 'method_declaration') {
      const name = fieldText(node, 'name');
      if (!name) return undefined;
      const receiver = node.childForFieldName('receiver');
      const decl = receiver?.namedChildren.find((c) => c?.type === 'parameter_declaration') ?? undefined;
      const typeText = decl?.childForFieldName('type')?.text ?? '';
      const recv = stripGenerics(typeText.replace(/^\*/, ''));
      return recv ? `${recv}.${name}` : name;
    }
    // `var h = func() {}` / `h := func() {}`
    const parent = node.parent;
    if (parent?.type === 'expression_list' && parent.parent) {
      const gp = parent.parent;
      if (gp.type === 'var_spec') return fieldText(gp, 'name');
      if (gp.type === 'short_var_declaration') {
        const left = gp.childForFieldName('left');
        const first = left?.namedChildren[0];
        return first?.type === 'identifier' ? first.text : undefined;
      }
    }
    return undefined;
  },
  containerName: () => undefined,
  rangeNode(node) {
    if (node.type !== 'func_literal') return node;
    const gp = node.parent?.parent;
    return gp && (gp.type === 'var_spec' || gp.type === 'short_var_declaration') ? gp : node;
  },
  classLike: () => false,
};

/** C and C++ (C files use the C++ grammar). Names come from the declarator chain. */
const CPP_FAMILY: Family = {
  functionTypes: ['function_definition'],
  containerTypes: ['class_specifier', 'struct_specifier', 'union_specifier', 'namespace_definition'],
  functionName(node) {
    let d = node.childForFieldName('declarator');
    for (let i = 0; d && i < 12; i++) {
      const t = d.type;
      if (t === 'identifier' || t === 'field_identifier' || t === 'qualified_identifier' || t === 'destructor_name' || t === 'operator_name' || t === 'template_function') {
        return d.text.replace(/\s+/g, '').replace(/::/g, '.');
      }
      const inner = d.childForFieldName('declarator');
      d = inner ?? d.namedChildren.find((c) => c !== null && /declarator|identifier|name/.test(c.type)) ?? null;
    }
    return undefined;
  },
  containerName: (node) => fieldText(node, 'name'),
  rangeNode: (node) => (node.parent?.type === 'template_declaration' ? node.parent : node),
  classLike: (node) => node.type !== 'namespace_definition',
};

const RUST_FAMILY: Family = {
  functionTypes: ['function_item'],
  containerTypes: ['impl_item', 'mod_item', 'trait_item'],
  functionName: (node) => fieldText(node, 'name'),
  containerName(node) {
    if (node.type === 'impl_item') {
      const type = fieldText(node, 'type');
      return type ? stripGenerics(type) : undefined;
    }
    return fieldText(node, 'name');
  },
  classLike: (node) => node.type !== 'mod_item',
};

const FAMILY_BY_GRAMMAR: Readonly<Record<string, Family>> = {
  python: PYTHON_FAMILY,
  javascript: JS_FAMILY,
  typescript: JS_FAMILY,
  tsx: JS_FAMILY,
  java: JAVA_FAMILY,
  go: GO_FAMILY,
  cpp: CPP_FAMILY,
  rust: RUST_FAMILY,
};

const CONSTRUCTOR_NAMES = new Set(['constructor', '__init__', '__new__', 'new']);

/**
 * Walks the tree for one grammar family and returns the functions with qualified names.
 * Uses `descendantsOfType` (one wasm call) and short parent walks instead of a full node-by-node traversal.
 */
export function extractFunctions(root: WTS.Node, grammar: string): RawFunction[] {
  const family = FAMILY_BY_GRAMMAR[grammar];
  if (!family) return [];
  const nodes = root.descendantsOfType(family.functionTypes);
  const functionTypes = new Set(family.functionTypes);
  const containerTypes = new Set(family.containerTypes);
  const out: RawFunction[] = [];
  for (const node of nodes) {
    if (!node) continue;
    const name = family.functionName(node);
    if (!name) continue;
    // Qualifier chain: enclosing containers and enclosing named functions, outermost first.
    const parts: string[] = [];
    let directClass: string | undefined;
    let insideClass = false;
    let sawFunction = false;
    for (let p = node.parent, guard = 0; p && guard < 200; p = p.parent, guard++) {
      if (containerTypes.has(p.type)) {
        const cname = family.containerName(p);
        if (cname) {
          parts.unshift(cname);
          if (family.classLike(p)) {
            insideClass = true;
            if (!sawFunction && directClass === undefined) directClass = cname;
          }
        }
      } else if (functionTypes.has(p.type)) {
        const fname = family.functionName(p);
        if (fname) {
          parts.unshift(fname);
          sawFunction = true;
        }
      }
    }
    // Out-of-class C++ definitions (`Rect::area`) already carry their class; do not repeat it.
    const already = parts.length && name.startsWith(parts[parts.length - 1] + '.');
    const qualified = already ? qualify(parts.slice(0, -1).join('.'), name) : qualify(parts.join('.'), name);
    const simple = name.split('.').pop() ?? name;
    let kind: FunctionKind = 'function';
    if (node.type === 'constructor_declaration' || (directClass && (CONSTRUCTOR_NAMES.has(simple) || simple === directClass))) kind = 'constructor';
    else if (insideClass && !sawFunction) kind = 'method';
    else if (node.type === 'method_definition' || node.type === 'method_declaration') kind = 'method';
    const rangeNode = family.rangeNode ? family.rangeNode(node) : node;
    out.push({ name: qualified, kind, range: { startLine: rangeNode.startPosition.row, endLine: endRow(rangeNode) } });
  }
  return out;
}

/** tree-sitter end positions are exclusive; a node ending at column 0 stops on the previous row. */
function endRow(node: WTS.Node): number {
  const end = node.endPosition;
  return end.column === 0 && end.row > node.startPosition.row ? end.row - 1 : end.row;
}

export class TreeSitterService {
  private readonly wasmDir: string;
  private readonly log: Logger | undefined;
  private readonly parseTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly loadModule: () => TreeSitterModule;
  private module: TreeSitterModule | undefined;
  private initPromise: Promise<TreeSitterModule> | undefined;
  private readonly languageCache = new Map<string, Promise<WTS.Language>>();
  private parser: WTS.Parser | undefined;
  private available: string[] | undefined;
  private disposed = false;

  constructor(opts: TreeSitterServiceOptions) {
    this.wasmDir = opts.wasmDir;
    this.log = opts.logger;
    this.parseTimeoutMs = opts.parseTimeoutMs ?? 3000;
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 10000;
    // Lazy require keeps activation fast; esbuild still bundles the runtime because the specifier is static.
    this.loadModule = opts.loadModule ?? (() => require('@vscode/tree-sitter-wasm') as TreeSitterModule);
  }

  /** Language ids whose grammar file is present in the wasm directory. */
  languages(): string[] {
    if (!this.available) {
      this.available = Object.keys(GRAMMAR_BY_LANGUAGE).filter((id) => {
        try {
          return fs.existsSync(this.grammarPath(GRAMMAR_BY_LANGUAGE[id]));
        } catch {
          return false;
        }
      });
    }
    return [...this.available];
  }

  supports(languageId: string): boolean {
    return this.languages().includes(languageId);
  }

  grammarFor(languageId: string): string | undefined {
    return this.supports(languageId) ? GRAMMAR_BY_LANGUAGE[languageId] : undefined;
  }

  private grammarPath(grammar: string): string {
    return path.join(this.wasmDir, `tree-sitter-${grammar}.wasm`);
  }

  /** Initialises the wasm runtime once; a failed init is forgotten so a later call retries. */
  private async init(): Promise<TreeSitterModule> {
    if (this.module) return this.module;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const mod = this.loadModule();
        const doInit = (): Promise<void> => mod.Parser.init({ locateFile: (file: string) => path.join(this.wasmDir, file) });
        try {
          await withTimeout(doInit(), this.loadTimeoutMs, 'tree-sitter runtime load');
        } catch (e) {
          this.log?.warn('tree-sitter runtime failed to load once, retrying', e);
          await sleep(jitter(200));
          await withTimeout(doInit(), this.loadTimeoutMs, 'tree-sitter runtime load');
        }
        this.module = mod;
        return mod;
      })();
      this.initPromise.catch(() => {
        this.initPromise = undefined;
      });
    }
    return this.initPromise;
  }

  private async language(grammar: string): Promise<WTS.Language> {
    let p = this.languageCache.get(grammar);
    if (!p) {
      p = (async () => {
        const mod = await this.init();
        const file = this.grammarPath(grammar);
        const load = (): Promise<WTS.Language> => mod.Language.load(file);
        try {
          return await withTimeout(load(), this.loadTimeoutMs, `tree-sitter grammar ${grammar}`);
        } catch (e) {
          this.log?.warn(`tree-sitter grammar ${grammar} failed to load once, retrying`, e);
          await sleep(jitter(200));
          return await withTimeout(load(), this.loadTimeoutMs, `tree-sitter grammar ${grammar}`);
        }
      })();
      this.languageCache.set(grammar, p);
      p.catch(() => this.languageCache.delete(grammar));
    }
    return p;
  }

  /**
   * Parses `text` with the grammar for `languageId`. Returns undefined when the language is not
   * supported, the runtime cannot load, or parsing was abandoned (timeout / cancellation).
   */
  async parseFunctions(text: string, languageId: string, token?: CancelToken): Promise<TreeSitterParseResult | undefined> {
    const grammar = this.grammarFor(languageId);
    if (!grammar || this.disposed) return undefined;
    let mod: TreeSitterModule;
    let lang: WTS.Language;
    try {
      mod = await this.init();
      lang = await this.language(grammar);
    } catch (e) {
      this.log?.warn(`tree-sitter unavailable for ${languageId}: ${(e as Error).message}`);
      return undefined;
    }
    if (token?.isCancellationRequested || this.disposed) return undefined;
    if (!this.parser) this.parser = new mod.Parser();
    const parser = this.parser;
    parser.reset();
    parser.setLanguage(lang);
    const deadline = Date.now() + this.parseTimeoutMs;
    const started = Date.now();
    // Normalised text keeps tree-sitter rows equal to VS Code line numbers for \r\n and lone \r files.
    const tree = parser.parse(normalizeNewlines(text), null, {
      progressCallback: () => Date.now() > deadline || token?.isCancellationRequested === true,
    });
    if (!tree) {
      parser.reset();
      this.log?.warn(`tree-sitter parse of ${languageId} abandoned after ${Date.now() - started}ms`);
      return undefined;
    }
    try {
      const functions = extractFunctions(tree.rootNode, grammar);
      const hasError = tree.rootNode.hasError;
      this.log?.debug(`tree-sitter ${languageId}: ${functions.length} functions in ${Date.now() - started}ms${hasError ? ' (syntax errors)' : ''}`);
      return { functions, hasError };
    } finally {
      tree.delete();
    }
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.parser?.delete();
    } catch {
      /* ignore */
    }
    this.parser = undefined;
    this.languageCache.clear();
  }
}
