# 4. ExplainIT is not responding

## Symptoms

- The status bar item is red and says "ExplainIT: not responding" or "ExplainIT: not running".
- Claude Code or Codex shows its own permission prompt with the reason "ExplainIT is not responding; falling back to your normal permission prompt."
- A review panel never appears for a change, and the assistant waits for up to two minutes before continuing.

## Cause

The checkpoint is a small local HTTP server inside this VS Code window, bound to `127.0.0.1` on a random port with a per-session token. The hook script that each assistant runs talks to it. "Not responding" means the hook (or the status bar's own health probe) got no answer within the expected time. Usual reasons:

- The VS Code window that owns the folder was closed, reloaded or is frozen (for example a very long-running task in the extension host).
- The session file in `~/.explainit/sessions/` is stale (left by a window that crashed), so the hook talks to a port nobody listens on.
- A local firewall or security tool blocks loopback connections for Node processes.
- The window has the folder open, but the file being changed lives outside every open folder (then the hook finds no session and lets the assistant use its own prompt; that is by design).

**What happens while ExplainIT is unresponsive.** Every hook has a watchdog (`explainit.checkpoint.watchdogSeconds`, default 120 seconds). If no answer arrives in that time, the hook answers **ask**, which hands the decision to the assistant's own permission prompt. The assistant never hangs forever and never slips through unchecked: you still get a prompt, just the assistant's own instead of the per-function review. Protected paths (the hooks, the journal, restore points, `.git/info/exclude`) stay refused even in that state.

## Fix

1. **Reload the window**: Command Palette → **Developer: Reload Window**. This restarts the checkpoint on a fresh port, rewrites the session file and removes stale ones.
2. Run **ExplainIT: Doctor**. The checks "Checkpoint is listening", "Checkpoint answers over HTTP", "Session file for hook scripts" and "Hook wiring live test" should all be OK. If "Checkpoint is listening" fails right after a reload, run **ExplainIT: Show logs** and look for "gate failed to start" — it names the reason (usually a permissions problem on `~/.explainit`).
3. Make sure the file the assistant is changing is inside a folder that is open in the window where ExplainIT runs. Open that folder (or a workspace containing it).
4. If a security tool blocks loopback connections, allow `127.0.0.1` for VS Code, Node and your assistants. ExplainIT never listens on any other address.
5. If the watchdog fires too early for your reviews (you take longer than two minutes to decide), raise `explainit.checkpoint.watchdogSeconds` (30–600). The Doctor warns when the value is outside that range.
6. Restart the assistant session after the window is back so it reconnects cleanly. Sessions already running keep working; they simply used their own prompt while ExplainIT was away.
