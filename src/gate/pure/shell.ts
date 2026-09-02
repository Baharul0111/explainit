/**
 * Shell-command heuristics (CONTRACTS "Protected paths", shell bullet). Pure.
 *
 * We do not try to be a shell parser. We split a command line into simple segments (`;`, `&&`,
 * `||`, `|`, newlines), tokenise each with basic quote handling, and look for the well-known ways
 * of writing to a code file without going through the agent's edit tool. False negatives are
 * possible (obfuscated commands); the point is to steer well-behaved agents back to Write/Edit.
 *
 * The analysis also follows `cd` / `pushd` from segment to segment so that a write target is known
 * as an absolute path (`cd ~/.claude && cat > settings.json` writes `~/.claude/settings.json`).
 * `writeTargets` lists EVERY file the command would write, code file or not, resolved against the
 * effective directory of its segment; `enteredDirs` lists the directories the command changes into.
 * The policy uses both to refuse writes into protected places that a plain text match would miss.
 */
import * as path from 'node:path';
import { isCodeFile } from './text';

export interface ShellAnalysis {
  /** True when the command appears to write a code file in place. */
  writes: boolean;
  /** Code files it appears to target (as written in the command). */
  targets: string[];
  /** Which heuristic matched, for logs and the reason text. */
  matched?: string;
  /**
   * Every file the command would write (redirects, tee, in-place tools, copies, deletes), whatever
   * its extension, resolved against the segment's effective directory when one is known.
   */
  writeTargets: string[];
  /** Directories the command changes into with cd / pushd, resolved the same way. */
  enteredDirs: string[];
}

export interface ShellContext {
  /** The directory the command starts in (the agent's cwd). Relative targets resolve against it. */
  cwd?: string;
  /** The person's home directory, for `~`, `$HOME` and `%USERPROFILE%` spellings. */
  home?: string;
  /** ExplainIT home, for `$EXPLAINIT_HOME` spellings. */
  explainitHome?: string;
  /** Codex home, for `$CODEX_HOME` spellings. */
  codexHome?: string;
}

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\||\n)\s*/;

/**
 * Split a command line into simple segments on `&&`, `||`, `;`, `|` and newlines that sit OUTSIDE
 * quotes, so `bash -c "cd ~/.claude && cat > settings.json"` stays one segment and its inner script
 * is analysed as a whole (with its own cd tracking). When the quotes do not balance the naive split
 * is used instead: a stray apostrophe must never hide the commands after it.
 */
export function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += ch + command[++i];
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  if (quote) return command.split(SEGMENT_SPLIT).filter((s) => s.trim());
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Inside a token that has already started as a Windows path (`C:` / `C:\x`, or a UNC `\\srv`), a
 * backslash is a separator, not a POSIX escape. Without this, `cd C:\Users\me\.claude` would
 * tokenise as `C:Usersme.claude` and the protected-directory check would never see the path.
 * Everywhere else the POSIX rule stands (`a\ b` is one token holding a space).
 */
function inWindowsPath(cur: string, next: string): boolean {
  if (/^[a-zA-Z]:/.test(cur)) return true; // C:\Users\me
  if (cur === '' && next === '\\') return true; // the first slash of a UNC path (\\srv\share)
  return cur.startsWith('\\'); // ...and the rest of it (a token can only start with `\` that way)
}

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
      else if (ch === '\\' && quote === '"' && i + 1 < segment.length && !inWindowsPath(cur, segment[i + 1])) cur += segment[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length && !inWindowsPath(cur, segment[i + 1])) {
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

/** Drop subshell / group punctuation glued to tokens: `(cd`, `1.json)`, lone `{` and `}`. */
function stripGrouping(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    if (i === 0) t = t.replace(/^[({]+/, '');
    if (i === tokens.length - 1) t = t.replace(/[)}]+$/, '');
    if (t === '' || t === '(' || t === ')' || t === '{' || t === '}') continue;
    out.push(t);
  }
  return out;
}

/** `sudo`, `env`, `command`, `exec`, `nohup`, `time` prefixes and leading `FOO=bar` assignments. */
function stripPrefixes(tokens: string[]): string[] {
  let out = stripEnvAssignments(tokens);
  while (out.length && ['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'builtin'].includes(baseCommand(out[0]))) {
    out = stripEnvAssignments(out.slice(1));
  }
  return out;
}

/** The spellings a shell would expand for the home directories we know (same set as the hook script). */
function expandHome(tok: string, ctx: ShellContext): string {
  let t = tok;
  if (ctx.home) {
    t = t
      .replace(/^~(?=$|[\\/])/, ctx.home)
      .replace(/^\$\{?HOME\}?(?=$|[\\/])/, ctx.home)
      .replace(/^%(USERPROFILE|HOME)%(?=$|[\\/])/i, ctx.home);
  }
  if (ctx.explainitHome) t = t.replace(/^\$\{?EXPLAINIT_HOME\}?(?=$|[\\/])/, ctx.explainitHome).replace(/^%EXPLAINIT_HOME%(?=$|[\\/])/i, ctx.explainitHome);
  if (ctx.codexHome) t = t.replace(/^\$\{?CODEX_HOME\}?(?=$|[\\/])/, ctx.codexHome).replace(/^%CODEX_HOME%(?=$|[\\/])/i, ctx.codexHome);
  return t;
}

const WIN_ABS = /^[a-zA-Z]:[\\/]/;

/** Resolve a path as written against the effective directory (kept as written when nothing is known). */
function resolveAgainst(p: string, ctx: ShellContext): string {
  const e = expandHome(p, ctx);
  if (path.isAbsolute(e) || WIN_ABS.test(e)) return path.normalize(e);
  return ctx.cwd ? path.resolve(ctx.cwd, e) : e;
}

/** `git config` options that only read; anything else (set, --unset, --add, --edit, ...) writes a config file. */
const GIT_CONFIG_READ = /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--get-urlmatch|--name-only|list|get)$/;
const GIT_CONFIG_WRITE = /^(--unset|--unset-all|--add|--replace-all|--edit|-e|--rename-section|--remove-section|set|unset|edit|rename-section|remove-section)$/;

/**
 * The file a `git config ...` call would write, resolved against the effective cwd: `.git/config`
 * of the repo (`-C <dir>` honoured), `~/.gitconfig` for `--global` / `--system` (which can point
 * `core.hooksPath` anywhere for every repo), or the `--file` argument. Undefined when it only reads.
 */
function gitConfigWriteTarget(args: string[], ctx: ShellContext): string | undefined {
  let j = 0;
  let repo = ctx.cwd;
  while (j < args.length && args[j].startsWith('-')) {
    if (args[j] === '-C' && args[j + 1]) repo = resolveAgainst(args[j + 1], ctx);
    if (args[j] === '-C' || args[j] === '-c') j++;
    j++;
  }
  if (args[j] !== 'config') return undefined;
  const rest = args.slice(j + 1);
  const readOnly = rest.some((a) => GIT_CONFIG_READ.test(a)) && !rest.some((a) => GIT_CONFIG_WRITE.test(a));
  if (readOnly) return undefined;
  const fileIdx = rest.findIndex((a) => a === '--file' || a === '-f');
  if (fileIdx >= 0 && rest[fileIdx + 1]) return resolveAgainst(rest[fileIdx + 1], ctx);
  const file = rest.find((a) => a.startsWith('--file='));
  if (file) return resolveAgainst(file.slice('--file='.length), ctx);
  if (rest.includes('--global') || rest.includes('--system')) return ctx.home ? path.join(ctx.home, '.gitconfig') : '~/.gitconfig';
  return repo ? path.join(repo, '.git', 'config') : path.join('.git', 'config');
}

const NULL_DEVICES = new Set(['/dev/null', 'nul', '/dev/stdout', '/dev/stderr', '/dev/tty']);

interface SegmentResult {
  writes: boolean;
  targets: string[];
  matched?: string;
  written: string[];
  enteredDirs: string[];
}

function analyseSegment(rawTokens: string[], ctx: ShellContext): SegmentResult | undefined {
  if (rawTokens.length === 0) return undefined;
  const resolve = (p: string): string => resolveAgainst(p, ctx);
  const written: string[] = [];
  let writes = false;
  let matched: string | undefined;
  const targets: string[] = [];
  const hit = (why: string, code: string[]): void => {
    writes = true;
    matched = matched ?? why;
    targets.push(...code);
  };

  // Redirections `>`/`>>` (also `> file` attached: `>x.py`), including heredocs (`cat <<EOF > x.ts`),
  // which are just a redirection from our point of view. Every target counts as written; only code
  // files count as an in-place write of source.
  for (let i = 0; i < rawTokens.length; i++) {
    const t = rawTokens[i];
    let target: string | undefined;
    if (isRedirectOp(t) && i + 1 < rawTokens.length) target = rawTokens[i + 1];
    else {
      const m = /^(\d?>>?)(.+)$/.exec(t);
      if (m && !m[2].startsWith('&')) target = m[2];
    }
    if (!target || target.startsWith('&') || NULL_DEVICES.has(target.toLowerCase())) continue;
    written.push(resolve(target));
    if (isCodeFile(target)) hit('redirect', [target]);
  }

  const tokens = stripPrefixes(rawTokens);
  if (tokens.length === 0) return { writes, targets, matched, written, enteredDirs: [] };
  const cmd = baseCommand(tokens[0]);
  const args = tokens.slice(1);
  const nonFlags = args.filter((a) => !a.startsWith('-'));
  const codeArgs = nonFlags.filter(isCodeFile);
  const hasFlag = (re: RegExp): boolean => args.some((a) => re.test(a));
  const writeAll = (list: string[]): void => {
    for (const a of list) written.push(resolve(a));
  };

  switch (cmd) {
    case 'sed':
    case 'gsed':
      if (hasFlag(/^(-[a-zA-Z]*i|--in-place)/)) {
        hit('sed -i', codeArgs);
        writeAll(nonFlags);
      }
      break;
    case 'perl':
      if (hasFlag(/^-[a-zA-Z]*i/) && (hasFlag(/^-[a-zA-Z]*[pn]/) || hasFlag(/^-[a-zA-Z]*i/))) {
        hit('perl -i', codeArgs);
        writeAll(nonFlags);
      }
      break;
    case 'tee':
      writeAll(nonFlags);
      if (codeArgs.length) hit('tee', codeArgs);
      break;
    case 'git': {
      if (args[0] === 'apply' || args[0] === 'am') hit(`git ${args[0]}`, codeArgs);
      else if (args[0] === 'checkout' && codeArgs.length) {
        hit('git checkout <file>', codeArgs);
        writeAll(nonFlags.slice(1));
      } else if (args[0] === 'restore' && codeArgs.length) {
        hit('git restore <file>', codeArgs);
        writeAll(nonFlags.slice(1));
      }
      // `git config` writes .git/config (or ~/.gitconfig), which decides what git runs (F2 parity with the hook).
      const config = gitConfigWriteTarget(args, ctx);
      if (config) written.push(config);
      break;
    }
    case 'ln':
    case 'copy':
    case 'move':
    case 'xcopy':
    case 'robocopy': {
      const dest = nonFlags[nonFlags.length - 1];
      if (dest) written.push(resolve(dest));
      break;
    }
    case 'chmod':
      // Not a code write, but `chmod +x .git/hooks/pre-commit` arms a hook: every file counts as written.
      writeAll(nonFlags.filter((a) => !/^([ugoa]*[+=-][rwxXst]*|[0-7]{3,4})$/.test(a)));
      break;
    case 'chown':
    case 'chattr':
      // The first plain argument is the owner / attribute list, the rest are files.
      writeAll(nonFlags.slice(1));
      break;
    case 'touch':
    case 'shred':
    case 'attrib':
    case 'icacls':
      writeAll(nonFlags);
      break;
    case 'patch':
      hit('patch', codeArgs);
      break;
    case 'apply_patch':
      hit('apply_patch', []);
      break;
    case 'mv':
    case 'cp':
    case 'rename':
    case 'install': {
      const dest = nonFlags[nonFlags.length - 1];
      const src = nonFlags.slice(0, -1);
      if (dest) written.push(resolve(dest));
      if (dest && (isCodeFile(dest) || src.some(isCodeFile))) hit(cmd, [dest, ...src].filter(isCodeFile));
      break;
    }
    case 'rm':
    case 'unlink':
    case 'del':
      writeAll(nonFlags);
      if (codeArgs.length) hit('rm', codeArgs);
      break;
    case 'truncate':
      writeAll(nonFlags);
      if (codeArgs.length) hit('truncate', codeArgs);
      break;
    case 'dd':
      for (const a of args) {
        const m = /^of=(.+)$/.exec(a);
        if (!m) continue;
        written.push(resolve(m[1]));
        if (isCodeFile(m[1])) hit('dd', [m[1]]);
      }
      break;
    case 'awk':
    case 'gawk':
      // `awk -i inplace` (gawk extension).
      if (hasFlag(/^-i$/) && args.includes('inplace')) {
        hit('awk -i inplace', codeArgs);
        writeAll(nonFlags.filter((a) => a !== 'inplace'));
      }
      break;
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'ksh':
    case 'cmd':
    case 'powershell':
    case 'pwsh': {
      // `bash -c "<inner>"`: analyse the inner command string in the same directory.
      const idx = args.findIndex((a) => /^-(l?c|Command)$/i.test(a));
      if (idx >= 0 && args[idx + 1]) {
        const inner = analyseCommand(args[idx + 1], ctx);
        if (inner.writes) hit(inner.matched ?? 'shell -c', inner.targets);
        written.push(...inner.writeTargets);
        return { writes, targets, matched, written, enteredDirs: inner.enteredDirs };
      }
      break;
    }
    default:
      break;
  }
  return { writes, targets, matched, written, enteredDirs: [] };
}

const CD_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'set-location']);

/** Analyse a full command line. Pass the agent's cwd and the person's home to get absolute targets. */
export function analyseCommand(command: string, ctx: ShellContext = {}): ShellAnalysis {
  const segments = splitSegments(command);
  const targets = new Set<string>();
  const writeTargets = new Set<string>();
  const enteredDirs = new Set<string>();
  let matched: string | undefined;
  let cwd = ctx.cwd;
  const stack: (string | undefined)[] = [];

  for (const seg of segments) {
    const tokens = stripGrouping(tokenize(seg));
    if (tokens.length === 0) continue;
    const bare = stripPrefixes(tokens);
    const cmd = bare.length ? baseCommand(bare[0]) : '';
    if (CD_COMMANDS.has(cmd)) {
      // `cd [-L|-P] [/d] <dir>`; bare `cd` goes home; `cd -` goes somewhere we cannot know.
      const args = bare.slice(1).filter((a) => !/^-[A-Za-z]+$/.test(a) && !/^\/d$/i.test(a));
      const arg = args.find((a) => a !== '-');
      if (cmd === 'pushd') stack.push(cwd);
      if (arg !== undefined) cwd = resolveAgainst(arg, { ...ctx, cwd });
      else if (args.includes('-')) cwd = undefined;
      else cwd = ctx.home;
      if (cwd !== undefined) enteredDirs.add(cwd);
      continue;
    }
    if (cmd === 'popd') {
      cwd = stack.length ? stack.pop() : cwd;
      continue;
    }
    const r = analyseSegment(tokens, { ...ctx, cwd });
    if (!r) continue;
    if (r.writes) {
      matched = matched ?? r.matched;
      for (const t of r.targets) targets.add(t);
    }
    for (const w of r.written) writeTargets.add(w);
    for (const d of r.enteredDirs) enteredDirs.add(d);
  }
  return { writes: matched !== undefined, targets: [...targets], matched, writeTargets: [...writeTargets], enteredDirs: [...enteredDirs] };
}

/** The reason text that steers the agent back to a reviewable edit. */
export function shellWriteReason(analysis: ShellAnalysis, agent: string): string {
  const tool = agent === 'codex' ? 'apply_patch' : 'the Write or Edit tool';
  const what = analysis.targets.length ? ` (${analysis.targets.slice(0, 5).join(', ')})` : '';
  return `ExplainIT: this shell command would change code files in place${what} without review (${analysis.matched}). Use ${tool} instead so the person can review the change function by function.`;
}
