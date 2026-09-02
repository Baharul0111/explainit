# Design decisions (why things are the way they are)

1. **Hooks live at the user layer** (`~/.claude/settings.json`, `~/.codex/hooks.json`). A repo-editing agent cannot
   silently drop a project-layer hook it can edit, and the same user-layer hooks arm both the CLIs and the VS Code
   extensions (which bundle the same engines). Writes to these files that touch hook entries are hard-denied by the gate
   and by the hook script itself.
2. **Partial acceptance lands in the gate, not the agent.** When the person accepts some functions and rejects others,
   the gate writes the accepted parts itself (checkpoint first), then answers `deny` with a reason listing what landed and
   what was rejected. Full acceptance answers `allow` and lets the agent perform its own write, which keeps the agent's
   bookkeeping (read-before-edit checks, diffs) intact.
3. **Shell writes default to deny.** `sed -i`, redirects onto code files, `git apply`, etc. bypass per-function review, so
   by default the gate refuses them with a reason that steers the agent to its edit tool. A setting relaxes this to `ask`
   or `ignore`; protected paths are always refused.
4. **Watchdog counts silence, not time.** A human may take ten minutes to review; the hook only falls back to the
   agent's own prompt when the gate stops answering heartbeats for `checkpoint.watchdogSeconds` (default 120).
5. **Twin metadata lives in a sidecar**, never in the twin, so the twin stays plain English for anyone to read.
6. **Everything the agents must not touch lives under `~/.explainit/`** (hook script, wrappers, sessions, journal,
   restore points, cache, logs), outside every repository.
7. **No `--bare` for the Claude channel**: it disables OAuth sign-in. The channel runs `claude -p` with tools disabled,
   session persistence off, strict MCP config, and a neutral working directory so project hooks/MCP do not load.
8. **Copilot is review-compose, not pre-write block**, because Copilot exposes no hook for other extensions. The UI says so.
9. **GitHub repo is public** (`Baharul0111/explainit`, MIT) so CI runs free on all three operating systems; Marketplace and
   Open VSX publishing wait for Baharul's explicit go-ahead.
