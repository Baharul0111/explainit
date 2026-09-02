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
 *     the last answer; a "still thinking" heartbeat from ExplainIT resets it) prints "ask", so the
 *     assistant falls back to its own permission prompt. It never hangs and never lets a change
 *     through unchecked.
 *   - The change targets ExplainIT's own files or the hook settings -> "deny", even when no
 *     ExplainIT window is running, so an assistant cannot switch the checkpoint off.
 *   - Anything unexpected (bad input, crash)          -> prints nothing and exits 0.
 *
 * Plain CommonJS, no dependencies, Node >= 16, same file on Windows, macOS and Linux.
 * Usage: explainit-hook.js --agent claude|codex [--event PreToolUse|PostToolUse]
 *                          [--watchdog <seconds>] [--home <explainit home>]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const MAX_STDIN = 8 * 1024 * 1024;
const HOOK_VERSION = '1';
const ASK_REASON = 'ExplainIT is not responding; falling back to your normal permission prompt.';
const CLAUDE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit|Bash)$/;
const CODEX_TOOLS = /^(apply_patch|Edit|Write|Bash|shell.*)$/;
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function parseArgs(argv) {
  const o = { agent: 'claude', event: 'PreToolUse', watchdog: 120, home: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--agent' && v) { o.agent = v; i++; }
    else if (a === '--event' && v) { o.event = v; i++; }
    else if (a === '--watchdog' && v) { o.watchdog = Math.max(1, parseInt(v, 10) || 120); i++; }
    else if (a === '--home' && v) { o.home = v; i++; }
  }
  if (!o.home) o.home = (process.env.EXPLAINIT_HOME || '').trim() || path.join(os.homedir(), '.explainit');
  o.home = path.resolve(o.home);
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
const askOut = function (agent) { return decisionOut(agent, { permissionDecision: 'ask', reason: ASK_REASON }); };
const denyOut = function (reason) { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }; };

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
  return Array.isArray(c) ? c.map(String).join(' ') : str(c);
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
function protectedReason(opts, tool, input, target) {
  const userHome = os.homedir();
  const claudeSettings = [path.join(userHome, '.claude', 'settings.json'), path.join(userHome, '.claude', 'settings.local.json')];
  // Codex keeps its files under CODEX_HOME when that is set (the installer follows it too).
  const codexHome = (process.env.CODEX_HOME || '').trim() || path.join(userHome, '.codex');
  const codexFiles = [path.join(codexHome, 'hooks.json'), path.join(codexHome, 'config.toml')];
  const refuse = function (what) {
    return 'ExplainIT refused this change: ' + what + ' If the person really wants this, they can change it by hand outside the assistant.';
  };
  if (isShell(tool)) {
    const cmd = shellText(input);
    if (!cmd) return null;
    // Case-insensitive on every OS (stricter is fine here: a false deny only costs the person a retry by hand).
    const cmdNorm = cmd.replace(/\\/g, '/').toLowerCase();
    // opts.home is absolute; '/.explainit' also catches ~/.explainit and $HOME/.explainit spellings of the default home.
    const needles = [opts.home, '/.explainit', '.claude/settings', '.codex/hooks.json', '.codex/config.toml', '.git/info/exclude', 'explainit-hook'];
    for (const n of needles) if (cmdNorm.includes(n.replace(/\\/g, '/').toLowerCase())) return refuse('the command references files that keep the ExplainIT checkpoint working (' + n + ').');
    return null;
  }
  if (!target) return null;
  if (inside(opts.home, target)) return refuse('ExplainIT keeps its own files under ' + opts.home + ' and assistants may not change them.');
  const segs = target.split(/[\\/]+/);
  const n = segs.length;
  if (n >= 3 && segs[n - 1] === 'exclude' && segs[n - 2] === 'info' && segs[n - 3] === '.git') return refuse('.git/info/exclude keeps the plain-English twin files out of git.');
  const base = segs[n - 1];
  const parent = segs[n - 2] || '';
  // User-layer files are protected outright for whole-file writes; project-layer copies and edits only when hooks change.
  const userLayer = claudeSettings.concat(codexFiles).some(function (f) { return sameFile(f, target); });
  const isClaudeSettings = parent === '.claude' && (base === 'settings.json' || base === 'settings.local.json');
  const isCodexHooks = base === 'hooks.json' && (parent === '.codex' || sameFile(codexFiles[0], target));
  const isCodexConfig = base === 'config.toml' && (parent === '.codex' || sameFile(codexFiles[1], target));
  if (isClaudeSettings && ((userLayer && tool === 'Write') || jsonHooksChange(tool, input, target))) return refuse(base + ' holds the hooks that run the ExplainIT checkpoint.');
  // hooks.json is nothing but hooks, so any partial edit of it is a hooks change.
  if (isCodexHooks && (userLayer || tool !== 'Write' || jsonHooksChange(tool, input, target))) return refuse('.codex/hooks.json holds the hooks that run the ExplainIT checkpoint.');
  if (isCodexConfig && ((userLayer && tool === 'Write') || tomlHooksChange(tool, input, target))) return refuse('.codex/config.toml records which hooks Codex trusts, including the ExplainIT checkpoint.');
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
        return finish(askOut(opts.agent));
      }
      deadline = Date.now() + watchdogMs; // any answer (including a pending heartbeat) resets the watchdog
      if (status === 200 && json && json.status === 'done') return finish(decisionOut(opts.agent, json.decision));
      if (status === 200 && json && json.status === 'pending') {
        const wait = Date.now() - started < 1000 ? 1000 : 0; // never spin if the gate answers instantly
        return setTimeout(function () { poll(id, false); }, wait);
      }
      return finish(askOut(opts.agent));
    });
  };

  const post = function (retried) {
    request(session, 'POST', '/v1/hook', envelope, remaining(), function (err, status, json) {
      if (err) {
        if (err.message !== 'timeout' && !retried && Date.now() < deadline) return setTimeout(function () { post(true); }, jitter());
        return finish(askOut(opts.agent));
      }
      deadline = Date.now() + watchdogMs;
      if (status === 200 && json && json.decision) return finish(decisionOut(opts.agent, json.decision));
      if (status === 202 && json && json.requestId) return poll(String(json.requestId), false);
      return finish(askOut(opts.agent));
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
    const reason = protectedReason(opts, tool, input, target);
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
