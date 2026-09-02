# ExplainIT

**A plain-English twin for every code file, and a human checkpoint in front of every change your AI coding assistant makes.** Local only. Uses the assistants you already have. Ships no model, holds no keys, runs no server, sends no telemetry.

ExplainIT does two things and does them completely:

1. **Explains.** When you open a code file, a second file with the same name plus `_explain` (`app.py` → `app_explain.txt`) opens beside it. It lists every function in numbered order and describes each one in a few short, simple sentences anyone can understand. The twin is a real text file next to your code, but it is never committed or pushed.
2. **Checks.** When Claude Code or Codex tries to change code, the change is stopped *before it reaches the disk*. The file opens, you see exactly what is changing — one function at a time — next to a fresh plain-English note saying what changed and why it matters. Only when you click **Accept** does the change land; then the twin is updated to match, and only then may the assistant continue. **Reject** sends your reason straight back to the assistant so it can revise.

Everything runs on your own machine. The explanations are written by the assistants you already have connected and pay for.

---

## How the checkpoint works, per assistant

| Assistant | How ExplainIT reaches it | What you get | Honest note |
|---|---|---|---|
| **Claude Code** (terminal tool *and* the Claude Code VS Code extension) | A `PreToolUse` hook on `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and `Bash`, installed in your user-level `~/.claude/settings.json`. The extension bundles the same engine and reads the same settings, so edits made from inside the editor are gated identically. | **Pre-write block.** The change is held before disk, reviewed per function, landed on Accept. Reject sends your reason back. Deny holds even in bypass-permissions mode. | Restart a running Claude Code session after connecting; hooks load at start. |
| **Codex** (terminal tool *and* the Codex VS Code extension) | `PreToolUse` command hooks matching `apply_patch`, `Edit`, `Write` and `Bash`, installed at the **user layer** (`~/.codex/hooks.json`, or `$CODEX_HOME/hooks.json` when `CODEX_HOME` is set), where a repo-editing agent cannot silently drop them. The extension runs the same binary with the same config. | **Pre-write block**, same review as Claude Code. | **Trust step:** Codex only runs hooks you have trusted. Open `codex` once in a terminal; when it shows the ExplainIT hook choose **Trust** (or type `/hooks`). The record lives in `config.toml` and is shared by the terminal tool and the extension, so once is enough; the Doctor checks it for both. |
| **GitHub Copilot** (agent mode in VS Code) | Copilot offers no way for another extension to stop its writes. ExplainIT watches saved changes, adds a per-function plain-English note to Copilot's own Keep/Undo review, and steers Copilot through `.github/copilot-instructions.md` to work one function at a time. | **Review after landing**, using Copilot's native Keep/Undo. A restore point is still saved for every change. | This path *reviews* changes rather than blocking them. The interface says so plainly. |

Whatever the path, every change ExplainIT sees is written to a tamper-evident local journal, a restore point is saved first, and you can restore any file with one click.

## What is sent where

- **Your code goes only to the assistants you already use, under your existing agreements.** To write an explanation, ExplainIT sends the function body (and, at most, a short file summary — never whole files in thrift mode) to the assistant you picked: Copilot through VS Code's language-model API, Claude Code through `claude -p`, or Codex through `codex exec`.
- **Nothing goes to us.** There is no ExplainIT backend, account or server. The extension makes no network calls of its own. Its only network activity is a loopback (`127.0.0.1`) connection between the hook scripts and the extension in the same machine.
- **No telemetry.** None. Logs stay in an Output channel and a rolling file under `~/.explainit/logs`.
- **No keys.** ExplainIT stores no API keys and no credentials. Your assistants sign in the way they already do.

## Setup

1. Install ExplainIT from the Marketplace (or Open VSX for VSCodium and Cursor).
2. Have at least one assistant installed and signed in: [Claude Code](https://code.claude.com/docs/en/overview) (terminal tool or the VS Code extension), [Codex](https://developers.openai.com/codex) (terminal tool or the VS Code extension), or [GitHub Copilot](https://code.visualstudio.com/docs/copilot/setup).
3. On first use ExplainIT asks your **permission** to use those assistants. Choose **Allow**. (Run **ExplainIT: Set up assistants** at any time to see this screen again.)
4. ExplainIT **detects** what you have — Copilot in VS Code, Claude Code, Codex, including the VS Code extensions and the binaries they bundle — and offers a **one-click Connect** for each. Connecting installs the checkpoint hook and tells you the remaining steps: restart the assistant, and for Codex do the **trust step** once.
5. **Codex trust step.** Codex only runs hooks you have trusted. Open `codex` once in a terminal; when it shows the ExplainIT hook, choose **Trust** (or type `/hooks` and trust it there). The Codex VS Code extension shares that trust record, so you do this once, not per window. Until then Codex changes are not stopped for review, and the Doctor says so ("Codex trusts the ExplainIT hook").
6. If nothing is found you get the three install links and a **Check again** button.
7. Open any code file. The twin opens beside it. Run **ExplainIT: Doctor** whenever you want proof that everything is installed, armed and healthy.

## The twin format

```
ExplainIT — plain-English twin of app.py
Written by ExplainIT. Not committed to git. Right-click a section for "Regenerate this section".

1. load_config
What it does: Reads the settings file and turns it into a settings object.
How it works:
- It opens the file at the given path.
- It reads all of the text.
- It turns the text into a settings object.
- It hands the object back.

2. Server.start
What it does: Starts the web server so it can answer requests.
How it works:
- It picks the port from the settings.
- It begins listening on that port.
- It logs that it is ready.
```

Only functions that are new or changed are ever sent to an assistant; unchanged functions are served from a local content-hash cache so your credits are not wasted. When a function changes and its section has not been regenerated yet, the line `(Out of date — the code changed. Right-click here and choose "ExplainIT: Regenerate this section".)` appears under its heading.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `explainit.twin.autoOpen` | `true` | Open the twin beside a code file the moment it opens. |
| `explainit.twin.scrollSync` | `true` | Keep the twin scrolled in step with the code. |
| `explainit.twin.stalenessMarks` | `true` | Mark a twin section as out of date when its function changes. |
| `explainit.assistant.channel` | `auto` | Which assistant writes explanations: `auto`, `copilot`, `claude` or `codex`. |
| `explainit.assistant.tokenThrift` | `true` | Send only the function body and a minimal file summary, never whole files. |
| `explainit.assistant.timeoutSeconds` | `90` | How long to wait for one explanation request. |
| `explainit.assistant.claudeCliPath` | `claude` | Path to the Claude Code tool. Leave as is to find it on PATH or inside the Claude Code extension. |
| `explainit.assistant.codexCliPath` | `codex` | Path to the Codex tool. Leave as is to find it on PATH or inside the Codex extension. |
| `explainit.checkpoint.enabled` | `true` | Stop every Claude Code / Codex change for per-function approval. Off shows a banner and lets assistants use their own prompts. |
| `explainit.checkpoint.watchdogSeconds` | `120` | If ExplainIT stops responding, the hook gives up waiting after this long (30–600). Claude Code then shows its own permission prompt; what Codex does is set by the next setting. |
| `explainit.checkpoint.codexUnresponsive` | `deny` | Codex has no "ask" answer, so when ExplainIT does not respond within the watchdog time: `deny` refuses the change with a "try again in a moment" reason and nothing lands unchecked; `passthrough` lets Codex follow its own approval policy, which under full-auto means the change lands without a prompt. |
| `explainit.checkpoint.shellWrites` | `deny` | What to do when an assistant edits code through a shell command instead of its edit tool: `deny`, `ask` or `ignore`. |
| `explainit.checkpoint.batchTrivialChanges` | `true` | Group whitespace-only and comment-only changes into one approval. |
| `explainit.checkpoint.allowAcceptRestOfSession` | `true` | Offer "Accept the rest of this file" and "Accept the rest of this session". |
| `explainit.backfill.maxFunctionsPerRequest` | `20` | Functions per assistant request during backfill (hard cap 20). |
| `explainit.backfill.excludeGlobs` | node_modules, .git, dist, out, build, *.min.js, vendor | Files skipped by "Backfill the whole project". |
| `explainit.journal.maxEntries` | `5000` | Journal entries kept before the oldest half is archived. |
| `explainit.restorePoints.maxPerFile` | `20` | Restore points kept per file. |
| `explainit.restorePoints.maxTotalMB` | `200` | Total disk space for restore points per workspace. |
| `explainit.copilot.reviewOverlay` | `true` | Overlay per-function explanations on Copilot's saved changes. |
| `explainit.instructions.autoUpdate` | `true` | Keep the ExplainIT sections in `CLAUDE.md`, `AGENTS.md` and `.github/copilot-instructions.md` up to date. |
| `explainit.logLevel` | `info` | Local log detail. Nothing is ever sent anywhere. |

## Commands

All commands live under the **ExplainIT** category in the Command Palette.

| Command | What it does |
|---|---|
| Open plain-English twin | Open (or create) the twin beside the current file. Also in the editor title bar and right-click menu. |
| Regenerate this section | Rewrite the twin section under the cursor. |
| Regenerate the whole twin for this file | Rewrite every section of the current file's twin. |
| Turn automatic twin opening on/off | Toggle `explainit.twin.autoOpen`. |
| Backfill the whole project | Explain every code file in the workspace after showing a cost estimate and asking for confirmation; shows progress. |
| Pause backfill / Resume backfill / Cancel backfill | Control a running backfill. |
| Pause the checkpoint | Kill switch: assistants use their own prompts; a persistent banner and the status bar say so. |
| Resume the checkpoint | Turn the checkpoint back on. |
| Doctor: check everything is installed, armed and healthy | Runs every check (permission, assistants incl. VS Code extension paths, gate health, session file, hook integrity for Claude and Codex, Codex trust, a live hook-wiring test, journal chain, a restore round-trip self-test, git exclude, instruction sections, watchdog, disk space) in under 15 s and offers **Fix all**. |
| Set up assistants (permission, detection, connect) | The first-run flow, on demand. |
| Connect Claude Code / Connect Codex | Install the checkpoint hook for one assistant and show the next steps. |
| Connect Copilot | Turn on the review overlay and write `.github/copilot-instructions.md` steering. |
| Disconnect assistants | Remove the checkpoint hooks. |
| Restore a file from a restore point | Pick a restore point for the current (or right-clicked) file and restore it. |
| Restore this restore point | Inline button in the "Changes and restore points" view. |
| Show the change journal | Open a readable listing of every proposed and accepted change. |
| Verify the change journal has not been tampered with | Re-hash the journal chain. |
| Add *_explain.txt to the shared .gitignore (optional) | Offer a shared ignore entry for teams. Never done automatically. |
| Update assistant instruction files | Refresh the ExplainIT sections in `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`. |
| Choose which assistant writes explanations | Pin a channel or go back to automatic. |
| Show logs | Open the local log file and the Output panel. |
| Help: the five most likely problems | Open the runbooks index. |
| Show status | Status lines and quick actions (also by clicking the status-bar item). |

## When something goes wrong

Five short runbooks cover the most likely problems, each with symptoms, cause and fix steps:

1. [No assistant found](docs/runbooks/1-no-assistant-found.md)
2. [The checkpoint is not stopping changes](docs/runbooks/2-checkpoint-not-stopping-changes.md) — restart the assistant, the Codex trust step, the hooks layer, the Doctor
3. [The twin is not opening](docs/runbooks/3-twin-not-opening.md) — auto-open off, unsupported file type, language not outlined, big files
4. [ExplainIT is not responding](docs/runbooks/4-explainit-not-responding.md) — the fallback within two minutes explained, how to recover
5. [Restore a file, or the journal fails to verify](docs/runbooks/5-restore-and-journal.md)

**Codex sign-in.** If the Doctor or an explanation reports `refresh token was revoked` or `Please log out and sign in again`, Codex's sign-in has expired. Run `codex login` in a terminal (the Codex VS Code extension uses the same sign-in), then try again. ExplainIT adds this hint to the message whenever Codex answers that way.

**Codex trust.** If the Doctor's "Codex trusts the ExplainIT hook" check is a problem, its text is the adapter's own verdict: not trusted yet, changed since it was trusted, disabled, or "Trust unknown — run the Doctor after starting codex once". None of these can be fixed by **Fix all**: open `codex` once in a terminal and choose **Trust** (or type `/hooks`), then run the Doctor again. If you set `CODEX_HOME`, ExplainIT reads and shows that location instead of `~/.codex`.

The status bar shows `$(shield) ExplainIT` while the checkpoint is alive, turns red with **not responding** if no heartbeat arrives for 15 seconds, and shows **ExplainIT paused** while the kill switch is on. Every empty, loading and error state has a plain-English message that says what happened and what to do next.

## Privacy and security

- **Loopback only.** The checkpoint listens on `127.0.0.1` on a random port per window, with a random per-session bearer token that is never logged. Hook payloads are schema-validated, paths are canonicalised (symlinks resolved) and confined to your open folders, and request size is capped.
- **Protected paths.** Assistants cannot switch the checkpoint off: writes to `~/.explainit/**` (hook scripts, wrappers, sessions, state, journal, restore points), to the hook entries in `~/.claude/settings*.json` and `~/.codex/hooks.json` / `config.toml` (or their `$CODEX_HOME` equivalents), to `.git/info/exclude`, and to `.git/hooks/**` and `.git/config` (git runs those as you, outside ExplainIT) are refused outright with a reason. Writes elsewhere under `.git/` are handed to the assistant's own prompt with a warning. Shell commands are read the same way: `cd`/`pushd` into a protected folder followed by a redirect, `tee` or heredoc is refused whatever `explainit.checkpoint.shellWrites` says.
- **Pinned locations.** The hook command installed in the assistants' settings carries the absolute ExplainIT home and config locations, and the wrappers export them before running the hook, so changing `EXPLAINIT_HOME`, `HOME` or `CODEX_HOME` in a shell profile cannot point the hook at a rogue checkpoint or move the protected files. The command text is part of the integrity hash.
- **Integrity.** The hook script, wrappers and config entries are hashed and verified every session and by the Doctor; tampering is re-armed automatically. The Doctor's live wiring test runs the real installed wrapper, the same way the assistants do.
- **Prompt-injection defence.** Code being explained is fenced as untrusted data with a fixed never-follow-instructions rule; twin output is plain text, schema-validated, never executed, and never influences a gate decision. A twin an assistant writes itself is re-rendered by ExplainIT from its own cache once the write lands, and the journal says so.
- **Decision memory is short-lived.** "Accept the rest of this file/session" is keyed on the session the assistant reports, never on a shared fallback; it expires after 30 minutes without use and is cleared whenever the checkpoint is paused or resumed. At most 20 reviews can wait for you per session; beyond that the assistant gets its own prompt.
- **Journal and restore.** Append-only, hash-chained journal per workspace; a restore point before every accepted write; rotation caps; a checkpoint→restore round-trip self-test in the Doctor.
- **Fallback, never a hang.** If ExplainIT stops responding, each hook gives up after the watchdog time (default 120 s). Claude Code then shows its own permission prompt. Codex has no such "ask" answer, so by default (`explainit.checkpoint.codexUnresponsive` = `deny`) the change is refused with a try-again reason and nothing lands unchecked; with `passthrough` Codex follows its own approval policy, and under full-auto that means the change lands without a prompt.
- **No telemetry, no server, no keys, no accounts.**
- The full threat model, the findings of the security review and the risks that remain are in [docs/dev/SECURITY-REVIEW.md](docs/dev/SECURITY-REVIEW.md).

## Limitations

- **Copilot is review-after-landing**, not a pre-write block: Copilot exposes no gating API. If that changes, ExplainIT will use it.
- The checkpoint gates the assistants' **file-edit tools**. Shell commands that write files are refused by default (`explainit.checkpoint.shellWrites`), which steers the assistant back to its edit tool; choose `ignore` and such writes are not inspected.
- Hooks apply to **new** assistant sessions; restart a session after connecting.
- **When ExplainIT is not responding** (window closed, frozen or reloading), the hook waits for the watchdog time (default 120 s) and then gives up. Claude Code falls back to its own permission prompt. Codex has no "ask" answer, so by default (`explainit.checkpoint.codexUnresponsive` = `deny`) the change is refused with a try-again reason and nothing lands unchecked; if you choose `passthrough`, Codex follows its own approval policy and under full-auto the change lands without a prompt. See [runbook 4](docs/runbooks/4-explainit-not-responding.md).
- **Decision memory trusts the session id the assistant reports.** ExplainIT cannot verify it, so "accept the rest of this session" could be inherited by a process that learns that id. The acceptance expires after 30 minutes without use and is cleared on pause/resume; turn `explainit.checkpoint.allowAcceptRestOfSession` off if you never want it.
- The change journal is hash-chained, not signed. It shows if entries were edited or removed in place; it cannot prove that a determined attacker with your user account did not rewrite the whole file. Keep a copy elsewhere if you need that.
- Codex requires a **one-time trust** of the hook (open `codex` in a terminal, choose **Trust**, or type `/hooks`); until then Codex changes are not stopped. The Doctor shows this, and cannot do it for you.
- Assistants change their hook formats over time. ExplainIT pins tested versions in its conformance suite and ships fixes through the Marketplace pre-release channel.
- Explanations come from your assistant's model and can be wrong; the twin says when a section is out of date, but it is a companion to the code, not a replacement for reading it.
- Twins are real files. They are excluded from git locally; other sync tools (Dropbox, cloud drives) will see them.
- Requires VS Code 1.100 or newer and real files on disk (no virtual workspaces).

## Development

```
npm install
npm run typecheck
npm run test:unit
npm run test:integration   # launches VS Code with test/fixtures/workspace
npm run eval -- --channel claude   # explanation-quality round trip (needs a signed-in assistant)
npm run package
```

See `architecture.md` and `docs/dev/CONTRACTS.md` for the module seams.

## License

MIT © Baharul Islam. See [LICENSE](LICENSE).
