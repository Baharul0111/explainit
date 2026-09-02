/**
 * Shell-command heuristics (CONTRACTS "Protected paths", shell bullet). Pure.
 *
 * We do not try to be a shell parser. We split a command line into simple segments (`;`, `&&`,
 * `||`, `|`, newlines), tokenise each with basic quote handling, and look for the well-known ways
 * of writing to a code file without going through the agent's edit tool. False negatives are
 * possible (obfuscated commands); the point is to steer well-behaved agents back to Write/Edit.
 */
import { isCodeFile } from './text';

export interface ShellAnalysis {
  /** True when the command appears to write a code file in place. */
  writes: boolean;
  /** Code files it appears to target (as written in the command). */
  targets: string[];
  /** Which heuristic matched, for logs and the reason text. */
  matched?: string;
}

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\||\n)\s*/;

/** Tokenise a shell segment: whitespace-separated, quotes grouped, quotes stripped. */
export function tokenize(segment: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === '\\' && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) {
      cur += segment[++i];
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}

function isRedirectOp(tok: string): boolean {
  return /^(\d?>>?|&>|>\|)$/.test(tok);
}

function stripEnvAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens.slice(i);
}

function baseCommand(tok: string): string {
  return tok.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '');
}

function analyseSegment(segment: string): ShellAnalysis | undefined {
  const rawTokens = tokenize(segment);
  if (rawTokens.length === 0) return undefined;

  // Redirections `>`/`>>` onto a code file (also `> file` attached: `>x.py`), including heredocs
  // (`cat <<EOF > x.ts`) which are just a redirection from our point of view.
  for (let i = 0; i < rawTokens.length; i++) {
    const t = rawTokens[i];
    let target: string | undefined;
    if (isRedirectOp(t) && i + 1 < rawTokens.length) target = rawTokens[i + 1];
    else {
      const m = /^(\d?>>?)(.+)$/.exec(t);
      if (m && !m[2].startsWith('&')) target = m[2];
    }
    if (target && !target.startsWith('&') && target !== '/dev/null' && isCodeFile(target)) {
      return { writes: true, targets: [target], matched: 'redirect' };
    }
  }

  let tokens = stripEnvAssignments(rawTokens);
  // `sudo`, `env`, `command`, `exec`, `nohup`, `time` prefixes.
  while (tokens.length && ['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'builtin'].includes(baseCommand(tokens[0]))) {
    tokens = stripEnvAssignments(tokens.slice(1));
  }
  if (tokens.length === 0) return undefined;
  const cmd = baseCommand(tokens[0]);
  const args = tokens.slice(1);
  const codeArgs = args.filter((a) => !a.startsWith('-') && isCodeFile(a));

  const hasFlag = (re: RegExp): boolean => args.some((a) => re.test(a));

  switch (cmd) {
    case 'sed':
    case 'gsed':
      if (hasFlag(/^(-[a-zA-Z]*i|--in-place)/)) return { writes: true, targets: codeArgs, matched: 'sed -i' };
      return undefined;
    case 'perl':
      if (hasFlag(/^-[a-zA-Z]*i/) && (hasFlag(/^-[a-zA-Z]*[pn]/) || hasFlag(/^-[a-zA-Z]*i/))) {
        return { writes: true, targets: codeArgs, matched: 'perl -i' };
      }
      return undefined;
    case 'tee':
      if (codeArgs.length) return { writes: true, targets: codeArgs, matched: 'tee' };
      return undefined;
    case 'git':
      if (args[0] === 'apply' || args[0] === 'am') return { writes: true, targets: codeArgs, matched: `git ${args[0]}` };
      if (args[0] === 'checkout' && codeArgs.length) return { writes: true, targets: codeArgs, matched: 'git checkout <file>' };
      if (args[0] === 'restore' && codeArgs.length) return { writes: true, targets: codeArgs, matched: 'git restore <file>' };
      return undefined;
    case 'patch':
      return { writes: true, targets: codeArgs, matched: 'patch' };
    case 'apply_patch':
      return { writes: true, targets: [], matched: 'apply_patch' };
    case 'mv':
    case 'cp':
    case 'rename':
    case 'install': {
      const nonFlags = args.filter((a) => !a.startsWith('-'));
      const dest = nonFlags[nonFlags.length - 1];
      const src = nonFlags.slice(0, -1);
      if (dest && (isCodeFile(dest) || src.some(isCodeFile))) {
        return { writes: true, targets: [dest, ...src].filter(isCodeFile), matched: cmd };
      }
      return undefined;
    }
    case 'rm':
    case 'unlink':
    case 'del':
      if (codeArgs.length) return { writes: true, targets: codeArgs, matched: 'rm' };
      return undefined;
    case 'truncate':
      if (codeArgs.length) return { writes: true, targets: codeArgs, matched: 'truncate' };
      return undefined;
    case 'dd':
      for (const a of args) {
        const m = /^of=(.+)$/.exec(a);
        if (m && isCodeFile(m[1])) return { writes: true, targets: [m[1]], matched: 'dd' };
      }
      return undefined;
    case 'awk':
    case 'gawk':
      // `awk -i inplace` (gawk extension).
      if (hasFlag(/^-i$/) && args.includes('inplace')) return { writes: true, targets: codeArgs, matched: 'awk -i inplace' };
      return undefined;
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'cmd':
    case 'powershell':
    case 'pwsh': {
      // `bash -c "<inner>"`: analyse the inner command string.
      const idx = args.findIndex((a) => /^-(l?c|Command)$/i.test(a));
      if (idx >= 0 && args[idx + 1]) return analyseCommand(args[idx + 1]).writes ? analyseCommand(args[idx + 1]) : undefined;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Analyse a full command line. */
export function analyseCommand(command: string): ShellAnalysis {
  const segments = command.split(SEGMENT_SPLIT).filter((s) => s.trim());
  const targets = new Set<string>();
  let matched: string | undefined;
  for (const seg of segments) {
    const r = analyseSegment(seg);
    if (r?.writes) {
      matched = matched ?? r.matched;
      for (const t of r.targets) targets.add(t);
    }
  }
  return { writes: matched !== undefined, targets: [...targets], matched };
}

/** The reason text that steers the agent back to a reviewable edit. */
export function shellWriteReason(analysis: ShellAnalysis, agent: string): string {
  const tool = agent === 'codex' ? 'apply_patch' : 'the Write or Edit tool';
  const what = analysis.targets.length ? ` (${analysis.targets.slice(0, 5).join(', ')})` : '';
  return `ExplainIT: this shell command would change code files in place${what} without review (${analysis.matched}). Use ${tool} instead so the person can review the change function by function.`;
}
