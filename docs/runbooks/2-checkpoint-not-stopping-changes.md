# 2. The checkpoint is not stopping changes

## Symptoms

- Claude Code or Codex changed a file and no ExplainIT review panel appeared.
- The change landed on disk without an Accept, and no entry appeared in "Changes and restore points".
- The status bar shows "ExplainIT paused", or the Doctor reports a hook problem.

## Cause

The checkpoint works through a **hook** that each assistant runs before it writes a file. The hook is installed in the assistant's user-level configuration (`~/.claude/settings.json` for Claude Code, `~/.codex/hooks.json` plus `~/.codex/config.toml` for Codex). A change can slip past when:

1. The assistant was **already running** when the hook was installed. Hooks are read at start-up, so old sessions do not have it.
2. **Codex has not trusted the hook yet.** Codex asks once, on its next start, whether to trust a new hook. Until you answer "trust", the hook does not run. The trust record is shared by the Codex terminal tool and the Codex VS Code extension.
3. The checkpoint is **paused** (the kill switch), so every hook answers "use your own prompt".
4. The hook layer is **not installed or was changed** (an editor, a sync tool or a config reset rewrote the settings file; the hook script or its wrapper was modified).
5. The assistant is **Copilot**. Copilot offers no way for other extensions to stop its writes. ExplainIT reviews Copilot's changes *after* they land, with Copilot's own Keep/Undo, and says so in the interface. This is by design, not a fault.
6. The change came through a **shell command** (`sed -i`, `>`, `tee` ...) rather than the assistant's edit tool. By default ExplainIT refuses such commands and tells the assistant to use its edit tool; the setting `explainit.checkpoint.shellWrites` controls this.

## Fix

1. **Restart the assistant.** Close the Claude Code / Codex session (terminal or the VS Code extension's chat) and start it again. The hook is loaded at start.
2. **Codex trust step.** Start Codex once. When it asks about the ExplainIT hook, choose **trust**. Run **ExplainIT: Doctor**; the check "Codex trusts the ExplainIT hook" must be OK for both the terminal tool and the VS Code extension.
3. **Check the status bar.** If it says "ExplainIT paused", run **ExplainIT: Resume the checkpoint** (or click Resume on the banner). Also make sure `explainit.checkpoint.enabled` is on.
4. **Run the Doctor.** Open the Command Palette and run **ExplainIT: Doctor: check everything is installed, armed and healthy**. Look at:
   - "Claude Code checkpoint hook" / "Codex checkpoint hook" — if either is a problem, choose **Fix all** (it re-installs or re-arms the hooks), then restart the assistant.
   - "Hook wiring live test" — this runs the real hook script with a harmless synthetic write and expects the checkpoint to answer. If it fails, reload the VS Code window and run the Doctor again.
   - "Session file for hook scripts" — if missing, reload the window.
5. If the hooks keep disappearing, something else rewrites `~/.claude/settings.json` or `~/.codex/hooks.json`. ExplainIT refuses writes to those files from the assistants themselves; check dotfile sync tools or scripts. Then run **ExplainIT: Connect Claude Code** / **Connect Codex** again.
6. For Copilot, run **ExplainIT: Connect Copilot** so the review overlay and `.github/copilot-instructions.md` steering are in place, and use Copilot's Keep/Undo to decide about each function.
