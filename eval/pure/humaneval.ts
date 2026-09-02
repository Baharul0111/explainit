/**
 * HumanEval plumbing for the round-trip eval (explain -> resynthesize -> run the tests). Pure.
 *
 * A HumanEval prompt is: optional preamble (imports, sometimes helper functions), then the target
 * function's `def` line(s) and a docstring, and no body. The canonical solution is the body.
 *  - For the EXPLAIN step the model sees signature + body with the docstring removed, so the
 *    explanation has to carry the meaning (a docstring would let the model just paraphrase it).
 *  - For the RESYNTH step the model sees only the name, the signature, the preamble (imports and
 *    helpers it may call) and the explanation. Never the original body.
 *  - The test program is: original prompt (defines imports/helpers and a docstring-only stub) +
 *    the generated code (which redefines the function) + the HumanEval test + check(entry_point).
 */

export interface HumanEvalProblem {
  task_id: string;
  prompt: string;
  canonical_solution: string;
  test: string;
  entry_point: string;
}

export interface HumanEvalSubset {
  source?: string;
  license?: string;
  selection?: string;
  problems: HumanEvalProblem[];
}

export interface SplitPrompt {
  /** Everything before the target function (imports, helper functions). May be empty. */
  preamble: string;
  /** The `def ...:` line(s) of the target function, without trailing newline. */
  signature: string;
  /** The docstring block exactly as written (indentation included), or '' when absent. */
  docstring: string;
  /** Anything after the docstring inside the prompt (normally empty). */
  rest: string;
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Parse the subset file content; throws a plain-English error when the shape is wrong. */
export function parseSubset(json: string): HumanEvalSubset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`eval/humaneval-subset.json is not valid JSON: ${(e as Error).message}`);
  }
  const problems = Array.isArray(parsed) ? parsed : (parsed as HumanEvalSubset | null)?.problems;
  if (!Array.isArray(problems) || !problems.length) throw new Error('eval/humaneval-subset.json has no "problems" array.');
  for (const [i, p] of problems.entries()) {
    for (const k of ['task_id', 'prompt', 'canonical_solution', 'test', 'entry_point'] as const) {
      if (typeof (p as HumanEvalProblem)[k] !== 'string') throw new Error(`Problem ${i} in eval/humaneval-subset.json is missing "${k}".`);
    }
  }
  const meta: Partial<HumanEvalSubset> = Array.isArray(parsed) ? {} : (parsed as HumanEvalSubset);
  return { source: meta.source, license: meta.license, selection: meta.selection, problems: problems as HumanEvalProblem[] };
}

/** Split the prompt into preamble / signature / docstring for the target function. */
export function splitPrompt(prompt: string, entryPoint: string): SplitPrompt {
  const text = normalize(prompt);
  const defRe = new RegExp(`^[ \\t]*(?:async\\s+)?def\\s+${escapeRe(entryPoint)}\\s*\\(`, 'm');
  const m = defRe.exec(text);
  if (!m) throw new Error(`The prompt does not define "${entryPoint}".`);
  const preamble = text.slice(0, m.index);
  const after = text.slice(m.index);
  // The signature ends at the first line that ends with ':' (multi-line signatures are rare but exist).
  const lines = after.split('\n');
  let sigEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/:\s*(#.*)?$/.test(lines[i])) {
      sigEnd = i;
      break;
    }
  }
  if (sigEnd < 0) throw new Error(`Could not find the end of the signature of "${entryPoint}".`);
  const signature = lines.slice(0, sigEnd + 1).join('\n');
  const body = lines.slice(sigEnd + 1).join('\n');
  const doc = /^(\s*)("""|''')([\s\S]*?)\2[ \t]*\n?/.exec(body);
  if (!doc) return { preamble, signature, docstring: '', rest: body };
  return { preamble, signature, docstring: doc[0], rest: body.slice(doc[0].length) };
}

/** The function as the explain step sees it: signature + canonical body, no docstring. */
export function functionTextForExplain(problem: HumanEvalProblem): string {
  const s = splitPrompt(problem.prompt, problem.entry_point);
  const body = normalize(problem.canonical_solution).replace(/\s+$/, '');
  return `${s.signature}\n${body}\n`;
}

/** Preamble trimmed to what is useful as context (imports and helper functions). */
export function preambleForContext(problem: HumanEvalProblem): string {
  return splitPrompt(problem.prompt, problem.entry_point).preamble.trim();
}

/**
 * Pull the Python code out of a model reply: the first fenced block that defines the function, else
 * the first fenced block, else the text from the first import/def line on. Returns '' when nothing
 * looks like code.
 */
export function extractPythonCode(reply: string, entryPoint: string): string {
  const text = normalize(reply ?? '');
  const fences: string[] = [];
  const fenceRe = /```[ \t]*(?:python|py|python3)?[^\n]*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) fences.push(m[1]);
  const defines = (s: string): boolean => new RegExp(`^[ \\t]*(?:async\\s+)?def\\s+${escapeRe(entryPoint)}\\s*\\(`, 'm').test(s);
  const chosen = fences.find(defines) ?? fences[0];
  if (chosen !== undefined) return chosen.replace(/\s+$/, '') + '\n';
  const start = text.search(/^[ \t]*(?:from\s+\S+\s+import|import\s+\S+|(?:async\s+)?def\s+\w+|@\w+)/m);
  if (start < 0) return '';
  return text.slice(start).replace(/\s+$/, '') + '\n';
}

/** Python prelude that blocks network access inside the test process (belt and braces; HumanEval never needs it). */
export const NO_NETWORK_PRELUDE = [
  'import socket as _explainit_socket',
  'def _explainit_no_net(*a, **k):',
  "    raise OSError('network access is disabled inside the ExplainIT eval')",
  '_explainit_socket.socket = _explainit_no_net',
  '_explainit_socket.create_connection = _explainit_no_net',
  '_explainit_socket.getaddrinfo = _explainit_no_net',
  '',
].join('\n');

/** The full program the sandboxed Python runs. Exit code 0 means every assertion held. */
export function buildTestProgram(problem: HumanEvalProblem, generatedCode: string): string {
  const parts = [
    NO_NETWORK_PRELUDE,
    '# --- original prompt (imports, helpers, docstring-only stub) ---',
    normalize(problem.prompt).replace(/\s+$/, ''),
    '',
    '# --- generated code (redefines the function) ---',
    normalize(generatedCode).replace(/\s+$/, ''),
    '',
    '# --- HumanEval test ---',
    normalize(problem.test).replace(/\s+$/, ''),
    '',
    `check(${problem.entry_point})`,
    "print('EXPLAINIT_EVAL_PASS')",
    '',
  ];
  return parts.join('\n');
}

/** Deterministic pick of `n` problems spread across the list (index floor(i * len / n)). */
export function pickSpread<T>(items: T[], n: number): T[] {
  if (n <= 0 || !items.length) return [];
  if (n >= items.length) return [...items];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
