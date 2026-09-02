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
| **Codex** (terminal tool *and* the Codex VS Code extension) | `PreToolUse` command hooks matching `apply_patch`, `Edit`, `Write` and `Bash`, installed at the **user layer** (`~/.codex/hooks.json`), where a repo-editing agent cannot silently drop them. The extension runs the same binary with the same config. | **Pre-write block**, same review as Claude Code. | **Trust step:** the first time Codex starts after the hook is installed it asks whether to trust the ExplainIT hook. Choose *trust*. The record is shared by the terminal tool and the extension; the Doctor checks it for both. |
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
4. ExplainIT **detects** what you have — Copilot in VS Code, Claude Code, Codex, including the VS Code extensions and the binaries they bundle — and offers a **one-click Connect** for each. Connecting installs the checkpoint hook and tells you the remaining steps (restart the assistant; for Codex, choose *trust* once).
5. If nothing is found you get the three install links and a **Check again** button.
6. Open any code file. The twin opens beside it. Run **ExplainIT: Doctor** whenever you want proof that everything is installed, armed and healthy.

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
| `explainit.checkpoint.watchdogSeconds` | `120` | If ExplainIT stops responding, the assistant falls back to its own prompt after this long (30–600). |
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

The status bar shows `$(shield) ExplainIT` while the checkpoint is alive, turns red with **not responding** if no heartbeat arrives for 15 seconds, and shows **ExplainIT paused** while the kill switch is on. Every empty, loading and error state has a plain-English message that says what happened and what to do next.

## Privacy and security

- **Loopback only.** The checkpoint listens on `127.0.0.1` on a random port per window, with a random per-session bearer token that is never logged. Hook payloads are schema-validated, paths are canonicalised (symlinks resolved) and confined to your open folders, and request size is capped.
- **Protected paths.** Assistants cannot switch the checkpoint off: writes to `~/.explainit/**` (hook scripts, wrappers, sessions, state, journal, restore points), to the hook entries in `~/.claude/settings*.json` and `~/.codex/hooks.json` / `config.toml`, and to `.git/info/exclude` are refused outright with a reason. Writes elsewhere under `.git/` are handed to the assistant's own prompt with a warning.
- **Integrity.** The hook script, wrappers and config entries are hashed and verified every session and by the Doctor; tampering is re-armed automatically.
- **Prompt-injection defence.** Code being explained is fenced as untrusted data with a fixed never-follow-instructions rule; twin output is plain text, schema-validated, never executed, and never influences a gate decision.
- **Journal and restore.** Append-only, hash-chained journal per workspace; a restore point before every accepted write; rotation caps; a checkpoint→restore round-trip self-test in the Doctor.
- **Fallback, never a hang.** If ExplainIT stops responding, each hook times out (default 120 s) and answers *ask*, so the assistant shows its own permission prompt instead of hanging or slipping through.
- **No telemetry, no server, no keys, no accounts.**

## Limitations

- **Copilot is review-after-landing**, not a pre-write block: Copilot exposes no gating API. If that changes, ExplainIT will use it.
- The checkpoint gates the assistants' **file-edit tools**. Shell commands that write files are refused by default (`explainit.checkpoint.shellWrites`), which steers the assistant back to its edit tool; choose `ignore` and such writes are not inspected.
- Hooks apply to **new** assistant sessions; restart a session after connecting.
- Codex requires a **one-time trust** of the hook; until then Codex changes are not stopped. The Doctor shows this.
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
