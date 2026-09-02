/**
 * Command-line parsing for `node out/eval/run.js`. Pure; returns either options or a usage error.
 */
import type { EvalChannelName } from './baseline';

export const CHANNELS: readonly EvalChannelName[] = ['claude', 'codex', 'copilot', 'fake'];

export interface EvalArgs {
  channel: EvalChannelName;
  /** Problems to run (from the start of the subset). */
  n: number;
  updateBaseline: boolean;
  /** Concurrent problems (each problem = 2 model calls + 1 python run). */
  parallel: number;
  /** Per model call, seconds. */
  timeoutSeconds: number;
  verbose: boolean;
  help: boolean;
  /** Run only the problems whose task_id or entry point contains this text. */
  only?: string;
}

export const DEFAULTS: EvalArgs = { channel: 'fake', n: 12, updateBaseline: false, parallel: 2, timeoutSeconds: 120, verbose: false, help: false };

export const USAGE = [
  'ExplainIT explanation-quality eval (HumanEvalExplain-style round trip).',
  '',
  'Usage: npm run eval -- --channel <claude|codex|fake> [--n 12] [--update-baseline] [--parallel 2] [--timeout 120] [--only <text>] [--verbose]',
  '',
  '  --channel <c>        which assistant writes and re-implements the explanations (default: fake).',
  '                       claude / codex use the signed-in CLIs and spend a little of your credits.',
  '                       fake uses a scripted stand-in (no network, deterministic).',
  '                       copilot cannot run from the command line (it needs VS Code).',
  '  --n <count>          how many of the 12 problems to run (default: all 12).',
  '  --update-baseline    write eval/baseline.json (prompt hash + scores + history) after the run.',
  '  --parallel <count>   problems in flight at once (default: 2).',
  '  --timeout <seconds>  per model call (default: 120).',
  '  --only <text>        run only problems whose id or function name contains the text.',
  '  --verbose            show the router log and the prompts/replies as they happen.',
  '',
  'Results are written to eval/results/<channel>-<timestamp>.json and a table is printed.',
].join('\n');

export interface ParseResult {
  args?: EvalArgs;
  error?: string;
}

function intArg(name: string, raw: string | undefined, min: number, max: number): { value?: number; error?: string } {
  if (raw === undefined) return { error: `${name} needs a value.` };
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) return { error: `${name} must be a whole number between ${min} and ${max} (got "${raw}").` };
  return { value: v };
}

export function parseArgs(argv: string[]): ParseResult {
  const args: EvalArgs = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const inlineValue = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : undefined;
    const next = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return undefined;
      i++;
      return v;
    };
    switch (key) {
      case '--channel': {
        const v = next();
        if (!v || !CHANNELS.includes(v as EvalChannelName)) return { error: `--channel must be one of ${CHANNELS.join(', ')} (got "${v ?? ''}").` };
        args.channel = v as EvalChannelName;
        break;
      }
      case '--n': {
        const r = intArg('--n', next(), 1, 1000);
        if (r.error) return { error: r.error };
        args.n = r.value!;
        break;
      }
      case '--parallel': {
        const r = intArg('--parallel', next(), 1, 8);
        if (r.error) return { error: r.error };
        args.parallel = r.value!;
        break;
      }
      case '--timeout': {
        const r = intArg('--timeout', next(), 10, 3600);
        if (r.error) return { error: r.error };
        args.timeoutSeconds = r.value!;
        break;
      }
      case '--only': {
        const v = next();
        if (!v) return { error: '--only needs a value.' };
        args.only = v;
        break;
      }
      case '--update-baseline':
        args.updateBaseline = true;
        break;
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        return { error: `Unknown option "${a}". Run with --help to see the options.` };
    }
  }
  return { args };
}
