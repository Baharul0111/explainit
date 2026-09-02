/**
 * Explanation-quality eval (REQ-020, goal item 13). Entry: `npm run eval -- --channel <c> [...]`
 * (= `node out/eval/run.js`). Plain Node, no `vscode`.
 *
 * For each HumanEval problem in eval/humaneval-subset.json:
 *   1. explain   the canonical solution (signature + body, docstring stripped) through the REAL
 *                generation router and its real prompts (createGenerationRouter, forced channel)
 *   2. style     deterministic style-conformance check of the explanation (eval/style.ts)
 *   3. resynth   ask the same assistant to write the function again from the name, signature and
 *                explanation only (eval/resynth.ts) — the original body is never shown
 *   4. test      run the HumanEval tests on the result in a sandboxed Python subprocess (10 s)
 * Scores: pass@1 = fraction that passed the tests; style = fraction that passed the style check.
 * Writes eval/results/<channel>-<ts>.json, prints a table, and with --update-baseline folds the
 * scores into eval/baseline.json (prompt hash + latest scores + history) which eval/baseline.test.ts
 * locks in CI.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConsentStore, Disposable, ExplainRequest, GenerationRouter } from '../src/core/interfaces';
import type { Channel } from '../src/core/types';
import { contentHashOf } from '../src/core/hash';
import { createLogger, type Logger } from '../src/core/log';
import { inMemorySettings, type Settings } from '../src/core/settings';
import { createFileCache, createGenerationRouter } from '../src/generation';
import { parseArgs, USAGE, type EvalArgs } from './pure/args';
import { compareNewestToPrevious, updateBaseline, validateBaseline, type Baseline, type EvalChannelName } from './pure/baseline';
import { buildTestProgram, functionTextForExplain, parseSubset, preambleForContext, splitPrompt, type HumanEvalProblem } from './pure/humaneval';
import { fileStamp, formatProblems, formatTable, summarize, toChannelScore, type ProblemResult, type RunSummary } from './pure/report';
import { EVAL_PATHS, packageVersion, repoRoot } from './paths';
import { findPython, pythonMissingMessage, runPythonProgram, stderrTail, type PythonSpec } from './python';
import { resynthesize, type ResynthKind } from './resynth';
import { checkStyle } from './style';

const PYTHON_TIMEOUT_MS = 10_000;

interface Harness {
  args: EvalArgs;
  router: GenerationRouter;
  settings: Settings;
  logger: Logger;
  /** Channel the router is forced to use ('claude' for fake). */
  routerChannel: Channel;
  resynthKind: ResynthKind;
  homeDir: string;
  python: PythonSpec;
}

/** Consent is implied by running the eval on purpose from a terminal. */
function grantedConsent(): ConsentStore {
  return { granted: () => true, setGranted: async () => undefined };
}

function stderrLogger(verbose: boolean): Logger {
  return createLogger([{ write: (l) => process.stderr.write(l + '\n') }], 'eval', verbose ? 'debug' : 'warn');
}

function readBaseline(file: string, log: Logger): Baseline | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    const problems = validateBaseline(parsed);
    if (problems.length) {
      log.warn(`The existing eval/baseline.json is unusable and will be replaced: ${problems.join(' ')}`);
      return undefined;
    }
    return parsed as Baseline;
  } catch (e) {
    log.warn(`The existing eval/baseline.json is not valid JSON and will be replaced: ${(e as Error).message}`);
    return undefined;
  }
}

async function runProblem(h: Harness, problem: HumanEvalProblem): Promise<ProblemResult> {
  const result: ProblemResult = { taskId: problem.task_id, entryPoint: problem.entry_point, explainMs: 0, styleOk: false, styleProblems: [], resynthMs: 0, passed: false, testMs: 0 };
  const timeoutMs = h.args.timeoutSeconds * 1000;

  // 1. explain
  let text: string;
  try {
    text = functionTextForExplain(problem);
  } catch (e) {
    result.explainError = `Could not prepare the problem: ${(e as Error).message}`;
    return result;
  }
  const req: ExplainRequest = {
    fileName: `${problem.entry_point}.py`,
    languageId: 'python',
    fileSummary: preambleForContext(problem) || undefined,
    functions: [{ functionId: `${problem.entry_point}#0`, name: problem.entry_point, text, contentHash: contentHashOf(text) }],
  };
  const t0 = Date.now();
  try {
    const [exp] = await h.router.explainFunctions(req, { channel: h.routerChannel, timeoutMs });
    result.explainMs = Date.now() - t0;
    if (!exp) throw new Error('the router returned no explanation');
    result.explanation = { summary: exp.summary, steps: exp.steps, warnings: exp.warnings, uncertainty: exp.uncertainty };
    if (h.args.verbose) h.logger.debug(`explanation for ${problem.entry_point}`, result.explanation);
  } catch (e) {
    result.explainMs = Date.now() - t0;
    result.explainError = (e as Error).message;
    return result;
  }

  // 2. style
  const style = checkStyle(result.explanation);
  result.styleOk = style.ok;
  result.styleProblems = style.problems;

  // 3. resynth (from the explanation only)
  const t1 = Date.now();
  try {
    const split = splitPrompt(problem.prompt, problem.entry_point);
    const r = await resynthesize(h.resynthKind, h.settings, { entryPoint: problem.entry_point, signature: split.signature, context: split.preamble.trim(), explanation: result.explanation }, { timeoutMs, homeDir: h.homeDir });
    result.resynthMs = Date.now() - t1;
    if (!r.code.trim()) throw new Error(`the reply contained no Python code (${r.reply.trim().slice(0, 120)})`);
    result.resynthCode = r.code;
    if (h.args.verbose) h.logger.debug(`resynthesized ${problem.entry_point} (${r.detail})\n${r.code}`);
  } catch (e) {
    result.resynthMs = Date.now() - t1;
    result.resynthError = (e as Error).message;
    return result;
  }

  // 4. sandboxed tests
  const t2 = Date.now();
  const run = await runPythonProgram(buildTestProgram(problem, result.resynthCode), { timeoutMs: PYTHON_TIMEOUT_MS, python: h.python });
  result.testMs = Date.now() - t2;
  result.passed = run.passed && run.stdout.includes('EXPLAINIT_EVAL_PASS');
  if (!result.passed) result.testError = run.timedOut ? `the tests did not finish within ${PYTHON_TIMEOUT_MS / 1000} s` : stderrTail(run.stderr) || `python exited with code ${run.code}`;
  return result;
}

/** Run problems with at most `parallel` in flight; results keep the input order. */
async function runAll(h: Harness, problems: HumanEvalProblem[]): Promise<ProblemResult[]> {
  const out: ProblemResult[] = new Array(problems.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= problems.length) return;
      const p = problems[i];
      process.stderr.write(`[${i + 1}/${problems.length}] ${p.task_id} ${p.entry_point} …\n`);
      out[i] = await runProblem(h, p);
      done++;
      const r = out[i];
      const state = r.explainError ? 'explain error' : r.resynthError ? 'resynth error' : r.passed ? 'pass' : 'FAIL';
      process.stderr.write(`[${i + 1}/${problems.length}] ${p.task_id} ${p.entry_point}: ${state}, style ${r.styleOk ? 'ok' : 'no'} (${done} of ${problems.length} done)\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(h.args.parallel, problems.length) }, worker));
  return out;
}

function fakeCliSetting(): string {
  const own = EVAL_PATHS.fakeClaude();
  if (!fs.existsSync(own)) throw new Error(`The fake assistant script is missing: ${own}`);
  // The shared test fake (test/fixtures/fake-cli/claude.js) only answers explain prompts; the eval
  // needs the resynthesis task too, so it always uses its own scripted stand-in.
  return `node ${own}`;
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }
  const args = parsed.args!;
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const logger = stderrLogger(args.verbose);

  if (args.channel === 'copilot') {
    process.stderr.write('The Copilot channel talks to VS Code\'s language model API and cannot run from the command line. Run the eval with --channel claude or --channel codex instead.\n');
    return 2;
  }
  const python = await findPython();
  if (!python) {
    process.stderr.write(pythonMissingMessage() + '\n');
    return 2;
  }

  let subset;
  try {
    subset = parseSubset(fs.readFileSync(EVAL_PATHS.subset(), 'utf8'));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  let problems = subset.problems.slice(0, args.n);
  if (args.only) {
    const needle = args.only.toLowerCase();
    problems = problems.filter((p) => p.task_id.toLowerCase().includes(needle) || p.entry_point.toLowerCase().includes(needle));
    if (!problems.length) {
      process.stderr.write(`No problem matches --only "${args.only}". Ids: ${subset.problems.map((p) => p.task_id).join(', ')}\n`);
      return 2;
    }
  }

  // Everything the run touches on disk lives in one temp folder: the explanation cache (so no
  // earlier answer is reused), the CLIs' working directory, and nothing in the person's ~/.explainit.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-eval-'));
  if (!process.env.EXPLAINIT_HOME) process.env.EXPLAINIT_HOME = tmpRoot;
  const homeDir = process.env.EXPLAINIT_HOME;
  const disposables: Disposable[] = [];
  const cache = createFileCache(path.join(tmpRoot, 'cache.json'));
  const routerChannel: Channel = args.channel === 'fake' ? 'claude' : args.channel;
  const resynthKind: ResynthKind = routerChannel === 'codex' ? 'codex' : 'claude';
  const settings = inMemorySettings({
    channelPin: routerChannel,
    generationTimeoutSeconds: args.timeoutSeconds,
    ...(args.channel === 'fake' ? { claudeCliPath: fakeCliSetting() } : {}),
  });
  const router = createGenerationRouter({ logger, settings, extensionPath: repoRoot(), version: packageVersion(), cache, consent: grantedConsent(), disposables });
  const promptHash = router.promptHash();

  let code = 0;
  try {
    const availability = await router.availableChannels();
    const mine = availability.find((a) => a.channel === routerChannel);
    if (!mine?.available) {
      process.stderr.write(`The ${args.channel} channel is not available: ${mine?.reason ?? 'unknown reason'}${mine?.detail ? ` (${mine.detail})` : ''}\n`);
      return 2;
    }
    process.stderr.write(`ExplainIT eval — channel ${args.channel} (${mine.detail ?? ''}), ${problems.length} problem(s), prompt hash ${promptHash.slice(0, 12)}…, python ${python.version}\n`);

    const harness: Harness = { args, router, settings, logger, routerChannel, resynthKind, homeDir, python };
    const ranAt = new Date();
    const started = Date.now();
    const results = await runAll(harness, problems);
    const summary: RunSummary = summarize(args.channel, promptHash, ranAt.toISOString(), results, Date.now() - started, mine.detail);

    fs.mkdirSync(EVAL_PATHS.results(), { recursive: true });
    const resultsFile = path.join(EVAL_PATHS.results(), `${args.channel}-${fileStamp(ranAt)}.json`);
    fs.writeFileSync(resultsFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');

    process.stdout.write('\n' + formatTable(summary) + '\n');
    const notes = formatProblems(summary);
    if (notes) process.stdout.write('\n' + notes + '\n');
    process.stdout.write(`\nresults: ${path.relative(repoRoot(), resultsFile)}\n`);

    if (args.updateBaseline) {
      code = updateBaselineFile(summary, promptHash, logger);
    } else if (summary.n > 0) {
      process.stdout.write('(baseline not changed; add --update-baseline to record these scores)\n');
    }
  } finally {
    await cache.flush().catch(() => undefined);
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  return code;
}

function updateBaselineFile(summary: RunSummary, promptHash: string, logger: Logger): number {
  if (summary.n === 0 || summary.explainFailures === summary.n) {
    process.stderr.write('Not updating the baseline: no problem was explained successfully, so these scores say nothing about the prompts. Fix the channel (see the errors above) and run again.\n');
    return 1;
  }
  if (summary.explainFailures + summary.resynthFailures > summary.n / 2) {
    process.stderr.write(`Warning: ${summary.explainFailures + summary.resynthFailures} of ${summary.n} problems hit an assistant error; the scores mostly reflect those errors. Recording them anyway because --update-baseline was given.\n`);
  }
  const file = EVAL_PATHS.baseline();
  const existing = readBaseline(file, logger);
  const channel = summary.channel as EvalChannelName;
  const updated = updateBaseline(existing, channel, toChannelScore(summary), promptHash);
  const regression = compareNewestToPrevious(updated.history);
  if (existing && existing.promptHash !== promptHash) {
    process.stdout.write(`prompt hash changed: ${existing.promptHash.slice(0, 12)}… -> ${promptHash.slice(0, 12)}… (other channels' scores were measured with the old prompts until they are re-run)\n`);
  }
  fs.writeFileSync(file, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  process.stdout.write(`baseline written: ${path.relative(repoRoot(), file)} (${updated.history.length} history entr${updated.history.length === 1 ? 'y' : 'ies'})\n`);
  if (!regression.ok) {
    process.stderr.write(`\nWARNING — ${regression.problems.join('\n')}\nThe CI test eval/baseline.test.ts will fail with this baseline until the prompts are improved and the eval re-run.\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`The eval stopped: ${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
