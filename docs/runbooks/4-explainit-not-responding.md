# 4. ExplainIT is not responding

## Symptoms

- The status bar item is red and says "ExplainIT: not responding" or "ExplainIT: not running".
- Claude Code shows its own permission prompt with the reason "ExplainIT is not responding; falling back to your normal permission prompt."
- Codex reports that the change was refused with a reason that says ExplainIT did not answer and asks it to try again in a moment (the default), or, if you set `explainit.checkpoint.codexUnresponsive` to `passthrough`, Codex simply follows its own approval policy.
- A review panel never appears for a change, and the assistant waits for up to two minutes before continuing.

## Cause

The checkpoint is a small local HTTP server inside this VS Code window, bound to `127.0.0.1` on a random port with a per-session token. The hook script that each assistant runs talks to it. "Not responding" means the hook (or the status bar's own health probe) got no answer within the expected time. Usual reasons:

- The VS Code window that owns the folder was closed, reloaded or is frozen (for example a very long-running task in the extension host).
- The session file in `~/.explainit/sessions/` is stale (left by a window that crashed), so the hook talks to a port nobody listens on.
- A local firewall or security tool blocks loopback connections for Node processes.
- The window has the folder open, but the file being changed lives outside every open folder (then the hook finds no session and lets the assistant use its own prompt; that is by design).

**What happens while ExplainIT is unresponsive.** Every hook has a watchdog (`explainit.checkpoint.watchdogSeconds`, default 120 seconds). If no answer arrives in that time the hook gives up, and the assistant never hangs forever. What happens next differs by assistant, and it is worth knowing plainly:

- **Claude Code** falls back to its own permission prompt: the hook answers **ask**, so you still get a prompt, just Claude Code's own instead of the per-function review. Nothing lands without you.
- **Codex has no "ask" answer.** Its hooks can only allow or refuse. So by default (`explainit.checkpoint.codexUnresponsive` = `deny`) the hook **refuses the change** with a reason that tells Codex ExplainIT did not answer and to try again in a moment. Nothing lands unchecked; once ExplainIT is back, Codex retries and the normal review appears. If you set the setting to `passthrough`, the hook stays silent instead and **Codex follows its own approval policy**: in its default mode that is Codex's own approval prompt, but under full-auto (`--full-auto`, `--yolo` or an "approval never" policy) **the change lands without any prompt**. Choose `passthrough` only if you would rather have unreviewed Codex changes than a refused one while ExplainIT is down.

Protected paths (the hooks, ExplainIT's own folder, `.git/info/exclude`, `.git/hooks`, `.git/config`) stay refused in every state, for both assistants, even when no ExplainIT window is running at all.

## Fix

1. **Reload the window**: Command Palette → **Developer: Reload Window**. This restarts the checkpoint on a fresh port, rewrites the session file and removes stale ones.
2. Run **ExplainIT: Doctor**. The checks "Checkpoint is listening", "Checkpoint answers over HTTP", "Session file for hook scripts" and "Hook wiring live test" should all be OK. If "Checkpoint is listening" fails right after a reload, run **ExplainIT: Show logs** and look for "gate failed to start" — it names the reason (usually a permissions problem on `~/.explainit`).
3. Make sure the file the assistant is changing is inside a folder that is open in the window where ExplainIT runs. Open that folder (or a workspace containing it).
4. If a security tool blocks loopback connections, allow `127.0.0.1` for VS Code, Node and your assistants. ExplainIT never listens on any other address.
5. If the watchdog fires too early for your reviews (you take longer than two minutes to decide), raise `explainit.checkpoint.watchdogSeconds` (30–600). The Doctor warns when the value is outside that range.
6. Restart the assistant session after the window is back so it reconnects cleanly. Sessions already running keep working; Claude Code simply used its own prompt while ExplainIT was away, and Codex had its changes refused (default) or followed its own policy (`passthrough`).
7. If Codex keeps reporting refused changes with a "try again" reason, ExplainIT is still not answering: go back to step 1 and 2. Do not switch `explainit.checkpoint.codexUnresponsive` to `passthrough` to make the message go away unless you accept that Codex changes then land unreviewed while ExplainIT is down.
