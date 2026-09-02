# 1. No assistant found

## Symptoms

- The status bar tooltip says "Explanations: no assistant connected".
- Opening a code file shows a twin whose sections say "(not explained yet — connect an assistant ...)".
- "ExplainIT: Set up assistants" lists Copilot, Claude Code and Codex all as "not found", or found but "not signed in".
- The Doctor reports "Assistants detected" or "An assistant can write explanations" as a problem.

## Cause

ExplainIT ships no model of its own. It writes explanations by asking an assistant you already have:

- **Copilot** through VS Code's built-in language model API (the GitHub Copilot Chat extension must be installed and signed in).
- **Claude Code** through the `claude` terminal tool, or the Claude Code VS Code extension (which bundles the same tool).
- **Codex** through the `codex` terminal tool, or the Codex VS Code extension (which bundles the same tool).

If none of these is installed, or one is installed but not signed in, or the tool is installed somewhere that is not on your PATH, ExplainIT has nothing to ask.

## Fix

1. Install at least one assistant and sign in:
   - Claude Code: https://code.claude.com/docs/en/overview — then run `claude` once in a terminal and sign in.
   - Codex: https://developers.openai.com/codex — then run `codex` once in a terminal and sign in.
   - Copilot: https://code.visualstudio.com/docs/copilot/setup — install GitHub Copilot Chat and sign in to GitHub.
   Installing the Claude Code or Codex **VS Code extension** is enough: ExplainIT finds the tool bundled inside the extension.
2. Run **ExplainIT: Set up assistants** from the Command Palette and choose **Allow** on the permission screen. Without that permission ExplainIT never contacts an assistant.
3. In the same setup list, choose **Check again**. Each assistant shows "found, ready", "found, not signed in" or "not found" together with where it was found.
4. If a terminal tool is installed in an unusual place, set `explainit.assistant.claudeCliPath` or `explainit.assistant.codexCliPath` to its full path.
5. If Copilot is installed but ExplainIT still cannot use it, open any chat with Copilot once so VS Code finishes its own sign-in, then run **ExplainIT: Doctor**. The first explanation request through Copilot shows VS Code's own consent dialog; choose Allow.
6. To choose which assistant writes explanations, run **ExplainIT: Choose which assistant writes explanations**.
7. **Codex sign-in expired.** If the Doctor or an explanation reports `refresh token was revoked` or `Please log out and sign in again`, Codex's sign-in has lapsed. Run `codex login` in a terminal (the Codex VS Code extension uses the same sign-in), then try again. ExplainIT adds this hint to the message whenever Codex answers that way.

Nothing in this flow sends code anywhere but to the assistant you pick, under the agreement you already have with it.
