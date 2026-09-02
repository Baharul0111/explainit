#!/usr/bin/env node
/*
 * ExplainIT checkpoint hook
 * =========================
 * Claude Code and Codex run this script before (PreToolUse) and after (PostToolUse) a file
 * change. It forwards the proposed change to the ExplainIT window that owns the file, waits for
 * the person's Accept / Reject decision, and prints that decision back to the assistant.
 *
 * What happens when things go wrong (plain English):
 *   - No ExplainIT window is running for this file  -> prints nothing: the assistant uses its own
 *     normal permission prompt, exactly as if ExplainIT were not installed.
 *   - ExplainIT is running but stops answering       -> after the watchdog (default 120 s since
 *     the last answer; a "still thinking" heartbeat from ExplainIT resets it) Claude Code gets
 *     "ask", so it falls back to its own permission prompt. Codex has no "ask", so it gets "deny"
 *     with a try-again reason (--unresponsive deny, the default) or nothing (--unresponsive
 *     passthrough, when the person chose that). It never hangs and never lets a change through
 *     unchecked unless the person asked for that.
 *   - The change targets ExplainIT's own files, the hook settings, .git/hooks or .git/config
 *     -> "deny", even when no ExplainIT window is running, so an assistant cannot switch the
 *     checkpoint off or plant code that git runs as the person.
 *   - Anything unexpected (bad input, crash)          -> prints nothing and exits 0.
 *
 * The installer bakes --home, --claude-home and --codex-home into the hook command (and the
 * wrapper pins EXPLAINIT_HOME), so the locations this script protects and the folder it looks in
 * for a running ExplainIT never depend on environment variables an assistant could change.
 *
 * Plain CommonJS, no dependencies, Node >= 16, same file on Windows, macOS and Linux.
 * Usage: explainit-hook.js --agent claude|codex [--event PreToolUse|PostToolUse]
 *                          [--watchdog <seconds>] [--home <explainit home>]
 *                          [--claude-home <dir>] [--codex-home <dir>] [--unresponsive deny|passthrough]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const MAX_STDIN = 8 * 1024 * 1024;
const HOOK_VERSION = '1';
const ASK_REASON = 'ExplainIT is not responding; falling back to your normal permission prompt.';
const UNRESPONSIVE_DENY_REASON = 'ExplainIT is not responding; try again in a moment (nothing lands unchecked).';
const CLAUDE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|Bash)$/;
const CODEX_TOOLS = /^(apply_patch|Edit|Write|Bash|shell.*)$/;
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function parseArgs(argv) {
  const o = { agent: 'claude', event: 'PreToolUse', watchdog: 120, home: '', claudeHome: '', codexHome: '', unresponsive: 'deny' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--agent' && v) { o.agent = v; i++; }
    else if (a === '--event' && v) { o.event = v; i++; }
    else if (a === '--watchdog' && v) { o.watchdog = Math.max(1, parseInt(v, 10) || 120); i++; }
    else if (a === '--home' && v) { o.home = v; i++; }
    else if (a === '--claude-home' && v) { o.claudeHome = v; i++; }
    else if (a === '--codex-home' && v) { o.codexHome = v; i++; }
    else if (a === '--unresponsive' && v) { o.unresponsive = v === 'passthrough' ? 'passthrough' : 'deny'; i++; }
  }
  // Pinned arguments win; the environment is only a fallback for a hand-run script.
  const userHome = os.homedir();
  if (!o.home) o.home = (process.env.EXPLAINIT_HOME || '').trim() || path.join(userHome, '.explainit');
  if (!o.claudeHome) o.claudeHome = path.join(userHome, '.claude');
  if (!o.codexHome) o.codexHome = (process.env.CODEX_HOME || '').trim() || path.join(userHome, '.codex');
  o.home = path.resolve(o.home);
  o.claudeHome = path.resolve(o.claudeHome);
  o.codexHome = path.resolve(o.codexHome);
  return o;
}

let finished = false;
function finish(obj) {
  if (finished) return;
  finished = true;
  const done = function () { process.exit(0); };
  if (obj) process.stdout.write(JSON.stringify(obj), done);
  else done();
}
function decisionOut(agent, decision) {
  if (!decision || typeof decision !== 'object') return null;
  const pd = decision.permissionDecision;
  if (pd !== 'allow' && pd !== 'deny' && pd !== 'ask') return null; // 'none' -> agent's own flow
  if (pd === 'ask' && agent === 'codex') {
    // Codex has no "ask" answer for PreToolUse; printing nothing hands the change to its own approval flow.
    process.stderr.write((decision.reason || ASK_REASON) + '\n');
    return null;
  }
  const out = { hookEventName: 'PreToolUse', permissionDecision: pd };
  out.permissionDecisionReason = decision.reason || (pd === 'ask' ? ASK_REASON : 'ExplainIT checkpoint: ' + pd);
  if (decision.updatedInput !== undefined && decision.updatedInput !== null) out.updatedInput = decision.updatedInput;
  // Codex only accepts "allow" together with updatedInput; a bare allow is reported as a hook error there,
  // so print nothing instead: the change proceeds through Codex's normal flow, which is what allow means.
  if (pd === 'allow' && agent === 'codex' && out.updatedInput === undefined) return null;
  return { hookSpecificOutput: out };
}
const denyOut = function (reason) { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }; };
/** What to print when ExplainIT did not answer in time (watchdog) or could not be reached at all. */
function unresponsiveOut(opts) {
  if (opts.agent === 'codex') {
    // Codex cannot show its own prompt on request, so the only safe answer is a deny the assistant can retry.
    if (opts.unresponsive === 'deny') return denyOut(UNRESPONSIVE_DENY_REASON);
    process.stderr.write(ASK_REASON + '\n');
    return null;
  }
  return decisionOut(opts.agent, { permissionDecision: 'ask', reason: ASK_REASON });
}

function readStdin(cb) {
  const chunks = [];
  let size = 0;
  let over = false;
  process.stdin.on('data', function (c) {
    size += c.length;
    if (size > MAX_STDIN) over = true;
    else chunks.push(c);
  });
  process.stdin.on('end', function () { cb(over ? null : Buffer.concat(chunks).toString('utf8')); });
  process.stdin.on('error', function () { cb(null); });
  process.stdin.resume();
}

// ---- paths ------------------------------------------------------------------------------------
function norm(p) { return CASE_INSENSITIVE ? p.toLowerCase() : p; }
function canonical(p) {
  let abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    try { const real = fs.realpathSync.native(cur); abs = rest.length ? path.join(real, ...rest.reverse()) : real; break; }
    catch (e) { const parent = path.dirname(cur); if (parent === cur) break; rest.push(path.basename(cur)); cur = parent; }
  }
  return abs;
}
function inside(parent, child) {
  const rel = path.relative(norm(canonical(parent)), norm(canonical(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function sameFile(a, b) { return norm(canonical(a)) === norm(canonical(b)); }
function str(v) { return typeof v === 'string' ? v : ''; }

/** Absolute path the tool is about to touch (null for shell commands). */
function targetPath(agent, tool, input, cwd) {
  let p = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (!p && agent === 'codex' && tool === 'apply_patch') {
    const patch = str(input.command) || str(input.patch) || str(input.input);
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(patch);
    if (m) p = m[1].trim();
  }
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p);
}
function isShell(tool) { return tool === 'Bash' || /^shell/.test(tool); }
function shellText(input) {
  const c = input.command !== undefined ? input.command : input.cmd;
  if (!Array.isArray(c)) return str(c);
  // Codex's shell tool sends argv: `["bash", "-lc", "<script>"]`. Analyse the script itself, not a re-joined
  // approximation of it; other argv shapes are re-quoted so tokens with spaces stay whole.
  if (c.length >= 3 && /^-(l?c|Command)$/i.test(String(c[1])) && /^(sh|bash|zsh|dash|ksh|cmd|powershell|pwsh)(\.exe)?$/i.test(baseCommand(String(c[0])))) return String(c[2]);
  return c.map(function (t) { t = String(t); return /\s/.test(t) ? '"' + t.replace(/"/g, '\\"') + '"' : t; }).join(' ');
}

// ---- protected paths (mirror of the gate policy; applies even without a running window) ----------
// Config files are denied only when the hook-related part would change. For Write we have the whole
// new content; for Edit/MultiEdit we apply the replacement to the current file first. When we cannot
// tell what the file would look like afterwards, we fall back to "does the edit mention hooks at all".
const HOOK_WORDS = /hooks|explainit/i;
const TOML_TRUST_WORDS = /hooks|explainit|trusted_hash|sha256:|enabled\s*=/i;
function currentText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } }
function editMentionsHooks(tool, input, words) {
  const parts = [];
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) for (const e of input.edits) parts.push(str(e && e.old_string), str(e && e.new_string));
  else parts.push(str(input.old_string), str(input.new_string), str(input.content), str(input.command), str(input.patch));
  return (words || HOOK_WORDS).test(parts.join('\n'));
}
/** The file content after the tool ran, or null when the tool's input shape is not one we can replay. */
function proposedText(tool, input, file) {
  if (tool === 'Write') return str(input.content);
  const edits = tool === 'MultiEdit' ? (Array.isArray(input.edits) ? input.edits : null) : tool === 'Edit' ? [input] : null;
  if (!edits) return null;
  let text = currentText(file);
  for (const e of edits) {
    if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null;
    if (e.old_string === '') { text = e.new_string; continue; }
    if (text.indexOf(e.old_string) < 0) return null;
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, function () { return e.new_string; });
  }
  return text;
}
function jsonHooksChange(tool, input, file) {
  const next = proposedText(tool, input, file);
  if (next === null) return editMentionsHooks(tool, input);
  let parsed, current;
  try { parsed = JSON.parse(next); } catch (e) { return true; }
  try { current = JSON.parse(currentText(file)); } catch (e) { current = {}; }
  const pick = function (o) { return JSON.stringify((o && typeof o === 'object' && o.hooks) || null); };
  return pick(parsed) !== pick(current);
}
function tomlHooksChange(tool, input, file) {
  const next = proposedText(tool, input, file);
  if (next === null) return editMentionsHooks(tool, input, TOML_TRUST_WORDS);
  const lines = function (t) { return t.split(/\r?\n/).filter(function (l) { return TOML_TRUST_WORDS.test(l); }).join('\n'); };
  return lines(next) !== lines(currentText(file));
}
// ---- shell analysis (mirror of src/gate/pure/shell.ts, plus cwd tracking) -------------------------
// We do not parse shell for real. Commands are split into simple segments (`;`, `&&`, `||`, `|`,
// newlines), each segment is tokenised with basic quote handling, `cd`/`pushd` move an "effective
// cwd" forward, and every file a segment writes (redirects, tee, heredocs, cp/mv, rm, sed -i, ...)
// is resolved against that cwd before it is checked against the protected list. So
// `cd ~/.claude && cat > settings.json` is caught even though no token names the protected file.
const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\||\n)\s*/;
const PATCH_FILE_LINE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
function tokenize(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < segment.length) { cur += segment[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
    has = true;
  }
  if (cur || has) out.push(cur);
  return out;
}
function isRedirectOp(tok) { return /^(\d?>>?|&>|>\|)$/.test(tok); }
function baseCommand(tok) { return tok.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, ''); }
function stripEnvAssignments(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens.slice(i);
}
/** Expands the home spellings a shell would (`~`, `$HOME`, `%USERPROFILE%`, `$CODEX_HOME`, `$EXPLAINIT_HOME`). */
function expandHome(tok, opts) {
  const userHome = os.homedir();
  let t = tok;
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) t = userHome + t.slice(1);
  t = t.replace(/\$\{?EXPLAINIT_HOME\}?/g, opts.home).replace(/%EXPLAINIT_HOME%/gi, opts.home);
  t = t.replace(/\$\{?CODEX_HOME\}?/g, opts.codexHome).replace(/%CODEX_HOME%/gi, opts.codexHome);
  t = t.replace(/\$\{?HOME\}?/g, userHome).replace(/%USERPROFILE%/gi, userHome).replace(/%HOME%/gi, userHome);
  return t;
}
function resolveAgainst(cwd, tok, opts) {
  const t = expandHome(tok, opts);
  return path.isAbsolute(t) ? path.normalize(t) : path.resolve(cwd, t);
}
/** Segments of a path split on either separator. */
function segmentsOf(p) { return p.split(/[\\/]+/).filter(function (x) { return x !== ''; }); }
function underGitHooks(segs) {
  for (let i = 0; i + 1 < segs.length; i++) if (segs[i] === '.git' && segs[i + 1] === 'hooks') return true;
  return false;
}
function isGitConfig(segs) { const n = segs.length; return n >= 2 && segs[n - 1] === 'config' && segs[n - 2] === '.git'; }
function isGitExclude(segs) { const n = segs.length; return n >= 3 && segs[n - 1] === 'exclude' && segs[n - 2] === 'info' && segs[n - 3] === '.git'; }
function refuse(what) {
  return 'ExplainIT refused this change: ' + what + ' If the person really wants this, they can change it by hand outside the assistant.';
}
/** Why a shell command may not write `abs` (a resolved absolute path), or null. Shell writes cannot be replayed, so any hook config file is refused. */
function protectedShellTarget(abs, opts) {
  if (inside(opts.home, abs)) return refuse('ExplainIT keeps its own files under ' + opts.home + ' and assistants may not change them.');
  const segs = segmentsOf(abs);
  const n = segs.length;
  const base = segs[n - 1] || '';
  const parent = segs[n - 2] || '';
  if (isGitExclude(segs)) return refuse('.git/info/exclude keeps the plain-English twin files out of git.');
  if (underGitHooks(segs)) return refuse('.git/hooks holds scripts that git runs as the person, outside the ExplainIT checkpoint.');
  if (isGitConfig(segs)) return refuse('.git/config decides where git looks for hooks and what it runs.');
  const claudeFiles = [path.join(opts.claudeHome, 'settings.json'), path.join(opts.claudeHome, 'settings.local.json')];
  const codexFiles = [path.join(opts.codexHome, 'hooks.json'), path.join(opts.codexHome, 'config.toml')];
  if (claudeFiles.concat(codexFiles).some(function (f) { return sameFile(f, abs); })) return refuse(base + ' holds the hooks that run the ExplainIT checkpoint; a shell command cannot be reviewed, so use the person\'s own editor for it.');
  if (parent === '.claude' && (base === 'settings.json' || base === 'settings.local.json')) return refuse(base + ' may hold hooks that run the ExplainIT checkpoint; a shell command cannot be reviewed, so use the Edit tool for it.');
  if (parent === '.codex' && (base === 'hooks.json' || base === 'config.toml')) return refuse('.codex/' + base + ' may hold hooks that run the ExplainIT checkpoint; a shell command cannot be reviewed, so use the Edit tool for it.');
  return null;
}
/** Why a shell command may not move into `abs`, or null. */
function protectedShellDir(abs, opts) {
  if (inside(opts.home, abs)) return refuse('the command moves into ' + opts.home + ', where ExplainIT keeps the files assistants may not change.');
  if (inside(opts.claudeHome, abs)) return refuse('the command moves into ' + opts.claudeHome + ', which holds the hooks that run the ExplainIT checkpoint.');
  if (inside(opts.codexHome, abs)) return refuse('the command moves into ' + opts.codexHome + ', which holds the hooks Codex trusts, including the ExplainIT checkpoint.');
  if (underGitHooks(segmentsOf(abs))) return refuse('the command moves into .git/hooks, whose scripts git runs as the person outside the ExplainIT checkpoint.');
  return null;
}
const GIT_CONFIG_READ = /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--get-urlmatch|--name-only|list|get)$/;
const GIT_CONFIG_WRITE = /^(--unset|--unset-all|--add|--replace-all|--edit|-e|--rename-section|--remove-section|set|unset|edit|rename-section|remove-section)$/;
/** Files and directories a segment writes / enters. Returns { cwd, reason } with the cwd after the segment. */
function analyseSegment(segment, cwd, opts, depth) {
  const raw = tokenize(segment);
  if (raw.length === 0) return { cwd: cwd, reason: null };
  const targets = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (isRedirectOp(t) && i + 1 < raw.length) { targets.push(raw[i + 1]); continue; }
    const m = /^(\d?>>?)(.+)$/.exec(t);
    if (m && !m[2].startsWith('&')) targets.push(m[2]);
  }
  let tokens = stripEnvAssignments(raw);
  while (tokens.length && ['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'builtin'].indexOf(baseCommand(tokens[0])) >= 0) tokens = stripEnvAssignments(tokens.slice(1));
  let next = cwd;
  if (tokens.length) {
    const cmd = baseCommand(tokens[0]);
    const args = tokens.slice(1);
    const plain = args.filter(function (a) { return !a.startsWith('-') && !isRedirectOp(a); });
    const hasFlag = function (re) { return args.some(function (a) { return re.test(a); }); };
    switch (cmd) {
      case 'cd': case 'pushd': case 'chdir': {
        const dir = plain.length ? plain[plain.length - 1] : '~';
        next = resolveAgainst(cwd, dir, opts);
        const r = protectedShellDir(next, opts);
        if (r) return { cwd: next, reason: r };
        break;
      }
      case 'tee': targets.push.apply(targets, plain); break;
      case 'cp': case 'mv': case 'install': case 'ln': case 'rename': case 'copy': case 'move': case 'xcopy': case 'robocopy':
        if (plain.length) targets.push(plain[plain.length - 1]);
        break;
      case 'rm': case 'unlink': case 'del': case 'erase': case 'truncate': case 'shred': case 'chmod': case 'chown': case 'chattr': case 'touch': case 'attrib': case 'icacls':
        targets.push.apply(targets, plain);
        break;
      case 'sed': case 'gsed': case 'perl': case 'awk': case 'gawk':
        if (hasFlag(/^(-[a-zA-Z]*i|--in-place)/)) targets.push.apply(targets, plain);
        break;
      case 'git': {
        // Skip global options (`-C dir`, `-c k=v`, `--git-dir=...`) to find the subcommand.
        let j = 0;
        while (j < args.length && args[j].startsWith('-')) { if (args[j] === '-C' || args[j] === '-c') j++; j++; }
        const sub = args[j];
        if (sub === 'config') {
          const rest = args.slice(j + 1);
          const readOnly = rest.some(function (a) { return GIT_CONFIG_READ.test(a); }) && !rest.some(function (a) { return GIT_CONFIG_WRITE.test(a); });
          if (!readOnly) return { cwd: next, reason: refuse('"git config" changes .git/config (or the global git config), which decides where git looks for hooks and what it runs.') };
        }
        break;
      }
      case 'sh': case 'bash': case 'zsh': case 'dash': case 'ksh': case 'cmd': case 'powershell': case 'pwsh': {
        const idx = args.findIndex(function (a) { return /^-(l?c|Command|c)$/i.test(a); });
        if (idx >= 0 && args[idx + 1] && depth < 4) {
          const inner = analyseShell(args[idx + 1], cwd, opts, depth + 1);
          if (inner) return { cwd: next, reason: inner };
        }
        break;
      }
      default: break;
    }
  }
  for (const t of targets) {
    if (!t || t.startsWith('&') || t === '/dev/null' || t.toUpperCase() === 'NUL') continue;
    const r = protectedShellTarget(resolveAgainst(cwd, t, opts), opts);
    if (r) return { cwd: next, reason: r };
  }
  return { cwd: next, reason: null };
}
/** Reason a whole command line is refused, or null. `cwd` is where the assistant runs it. */
function analyseShell(command, cwd, opts, depth) {
  let cur = cwd;
  const segments = command.split(SEGMENT_SPLIT);
  for (const seg of segments) {
    if (!seg.trim()) continue;
    const r = analyseSegment(seg, cur, opts, depth || 0);
    if (r.reason) return r.reason;
    cur = r.cwd;
  }
  // A heredoc-fed apply_patch names its files on `*** Update File:` lines.
  let m;
  PATCH_FILE_LINE.lastIndex = 0;
  while ((m = PATCH_FILE_LINE.exec(command)) !== null) {
    const r = protectedShellTarget(resolveAgainst(cwd, m[1].trim(), opts), opts);
    if (r) return r;
  }
  return null;
}

function protectedReason(opts, tool, input, target, cwd) {
  // The installer pins these locations into the hook command; env-based fallbacks only apply to a hand-run script.
  const claudeSettings = [path.join(opts.claudeHome, 'settings.json'), path.join(opts.claudeHome, 'settings.local.json')];
  const codexFiles = [path.join(opts.codexHome, 'hooks.json'), path.join(opts.codexHome, 'config.toml')];
  if (isShell(tool)) {
    const cmd = shellText(input);
    if (!cmd) return null;
    // Case-insensitive on every OS (stricter is fine here: a false deny only costs the person a retry by hand).
    const cmdNorm = cmd.replace(/\\/g, '/').toLowerCase();
    // opts.home is absolute; '/.explainit' also catches ~/.explainit and $HOME/.explainit spellings of the default home.
    const needles = [opts.home, '/.explainit', '.claude/settings', '.codex/hooks.json', '.codex/config.toml', '.git/info/exclude', '.git/hooks', '.git/config', 'core.hookspath', 'explainit-hook'];
    for (const n of needles) if (cmdNorm.includes(n.replace(/\\/g, '/').toLowerCase())) return refuse('the command references files that keep the ExplainIT checkpoint working (' + n + ').');
    // Structural check: where the command really writes, after any cd/pushd, redirect, tee or copy.
    return analyseShell(cmd, cwd || process.cwd(), opts, 0);
  }
  if (!target) return null;
  if (inside(opts.home, target)) return refuse('ExplainIT keeps its own files under ' + opts.home + ' and assistants may not change them.');
  const segs = target.split(/[\\/]+/);
  const n = segs.length;
  if (isGitExclude(segs)) return refuse('.git/info/exclude keeps the plain-English twin files out of git.');
  if (underGitHooks(segs)) return refuse('.git/hooks holds scripts that git runs as the person, outside the ExplainIT checkpoint.');
  if (isGitConfig(segs)) return refuse('.git/config decides where git looks for hooks and what it runs.');
  const base = segs[n - 1];
  const parent = segs[n - 2] || '';
  // User-layer files are protected outright for whole-file writes; project-layer copies and edits only when hooks change.
  const userLayer = claudeSettings.concat(codexFiles).some(function (f) { return sameFile(f, target); });
  const isClaudeSettings = (parent === '.claude' || claudeSettings.some(function (f) { return sameFile(f, target); })) && (base === 'settings.json' || base === 'settings.local.json');
  const isCodexHooks = base === 'hooks.json' && (parent === '.codex' || sameFile(codexFiles[0], target));
  const isCodexConfig = base === 'config.toml' && (parent === '.codex' || sameFile(codexFiles[1], target));
  // For the pinned user-layer files an edit whose outcome cannot be replayed (unknown tool shape, an
  // old_string that is not in the file, a patch that deletes the file) fails closed: the person can make
  // that change by hand, and guessing wrong here would hand an assistant the checkpoint switch.
  const opaque = userLayer && tool !== 'Write' && proposedText(tool, input, target) === null;
  if (isClaudeSettings && ((userLayer && tool === 'Write') || opaque || jsonHooksChange(tool, input, target))) return refuse(base + ' holds the hooks that run the ExplainIT checkpoint.');
  // hooks.json is nothing but hooks, so any partial edit of it is a hooks change.
  if (isCodexHooks && (userLayer || tool !== 'Write' || jsonHooksChange(tool, input, target))) return refuse('.codex/hooks.json holds the hooks that run the ExplainIT checkpoint.');
  if (isCodexConfig && ((userLayer && tool === 'Write') || opaque || tomlHooksChange(tool, input, target))) return refuse('.codex/config.toml records which hooks Codex trusts, including the ExplainIT checkpoint.');
  return null;
}

// ---- session discovery --------------------------------------------------------------------------
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
function findSession(home, target) {
  const dir = path.join(home, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const want = norm(canonical(target));
  let best = null;
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (e) { continue; }
    if (!s || typeof s.pid !== 'number' || typeof s.port !== 'number' || typeof s.token !== 'string' || !Array.isArray(s.folders)) continue;
    if (!alive(s.pid)) continue;
    const owns = s.folders.some(function (f) {
      if (typeof f !== 'string') return false;
      const rel = path.relative(norm(canonical(f)), want);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!owns) continue;
    if (!best || String(s.startedAt || '') > String(best.startedAt || '')) best = s;
  }
  return best;
}

// ---- gate HTTP ----------------------------------------------------------------------------------
function request(session, method, p, body, timeoutMs, cb) {
  let called = false;
  const once = function (err, status, json) { if (!called) { called = true; cb(err, status, json); } };
  const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
  const headers = { Authorization: 'Bearer ' + session.token, Accept: 'application/json' };
  if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
  let req;
  try {
    req = http.request({ host: '127.0.0.1', port: session.port, method: method, path: p, headers: headers }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json = null; }
        once(null, res.statusCode, json);
      });
      res.on('error', function (e) { once(e); });
    });
  } catch (e) { return once(e); }
  req.setTimeout(timeoutMs, function () { req.destroy(new Error('timeout')); });
  req.on('error', function (e) { once(e); });
  if (data) req.write(data);
  req.end();
}

function gateFlow(opts, session, envelope) {
  const watchdogMs = opts.watchdog * 1000;
  let deadline = Date.now() + watchdogMs;
  const remaining = function () { return Math.max(500, deadline - Date.now()); };
  const jitter = function () { return 300 + Math.floor(Math.random() * 600); };

  const poll = function (id, retried) {
    const started = Date.now();
    request(session, 'GET', '/v1/decision/' + encodeURIComponent(id), null, remaining(), function (err, status, json) {
      if (err) {
        if (err.message !== 'timeout' && !retried && Date.now() < deadline) return setTimeout(function () { poll(id, true); }, jitter());
        return finish(unresponsiveOut(opts));
      }
      deadline = Date.now() + watchdogMs; // any answer (including a pending heartbeat) resets the watchdog
      if (status === 200 && json && json.status === 'done') return finish(decisionOut(opts.agent, json.decision));
      if (status === 200 && json && json.status === 'pending') {
        const wait = Date.now() - started < 1000 ? 1000 : 0; // never spin if the gate answers instantly
        return setTimeout(function () { poll(id, false); }, wait);
      }
      return finish(unresponsiveOut(opts));
    });
  };

  const post = function (retried) {
    request(session, 'POST', '/v1/hook', envelope, remaining(), function (err, status, json) {
      if (err) {
        if (err.message !== 'timeout' && !retried && Date.now() < deadline) return setTimeout(function () { post(true); }, jitter());
        return finish(unresponsiveOut(opts));
      }
      deadline = Date.now() + watchdogMs;
      if (status === 200 && json && json.decision) return finish(decisionOut(opts.agent, json.decision));
      if (status === 202 && json && json.requestId) return poll(String(json.requestId), false);
      return finish(unresponsiveOut(opts));
    });
  };
  post(false);
}

function run(opts, text) {
  let payload;
  try { payload = JSON.parse(text); } catch (e) { return finish(null); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return finish(null);
  const tool = str(payload.tool_name);
  const relevant = opts.agent === 'codex' ? CODEX_TOOLS.test(tool) : CLAUDE_TOOLS.test(tool);
  if (!relevant) return finish(null);
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const cwd = str(payload.cwd) || process.cwd();
  const target = targetPath(opts.agent, tool, input, cwd);
  const pre = opts.event !== 'PostToolUse';
  if (pre) {
    const reason = protectedReason(opts, tool, input, target, cwd);
    if (reason) return finish(denyOut(reason));
  }
  const session = findSession(opts.home, target || cwd);
  if (!session) return finish(null);
  const envelope = { agent: opts.agent, event: pre ? 'PreToolUse' : 'PostToolUse', payload: payload, hookVersion: HOOK_VERSION };
  if (!pre) {
    // Fire and forget: the gate only uses this to refresh twins / journal after a write landed.
    const t = setTimeout(function () { finish(null); }, 5000);
    return request(session, 'POST', '/v1/hook', envelope, 5000, function () { clearTimeout(t); finish(null); });
  }
  gateFlow(opts, session, envelope);
}

process.on('uncaughtException', function () { finish(null); });
process.on('unhandledRejection', function () { finish(null); });
const opts = parseArgs(process.argv.slice(2));
readStdin(function (text) {
  if (text === null) return finish(null);
  try { run(opts, text); } catch (e) { finish(null); }
});
