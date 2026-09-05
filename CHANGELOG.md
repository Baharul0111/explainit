# Changelog

All notable changes to ExplainIT are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-09-04

### Changed

- **Twins wrap.** `*_explain.txt` files now open with word wrap on (they register as the `explainit-twin` language), so long sentences fold to the editor width instead of scrolling sideways. Explanations themselves are unchanged.
- **Ask once per project.** Before ExplainIT explains anything in a workspace folder it asks *Explain this project?* and remembers the answer. A refused project gets no twins, no backfill and no instruction files; the checkpoint still protects it. New command **Allow or stop explanations for this project**; new setting `explainit.twin.projectPermission` (`ask` | `always`).
- **Armed automatically.** After you allow ExplainIT to use your assistants, the checkpoint hook is installed for every Claude Code and Codex found on the machine, at setup and at every start, without a click per assistant. If an assistant is present but not armed, the status bar shows **ExplainIT: not armed** with an **Arm the checkpoint now** action. This closes the gap where a fresh install could leave Claude Code writing unchecked when the setup list was dismissed.
- **Instruction files stay out of git.** `CLAUDE.md`, `AGENTS.md` and `.github/copilot-instructions.md` that ExplainIT creates are added to the repository's local exclude list, never to the shared `.gitignore`; files your team already had are left alone. New setting `explainit.instructions.keepOutOfGit`.

## [0.1.0] — 2026-09-02

First public release.

### Added

- **Plain-English twin** for every code file: `<name>_explain.txt` opens beside the source, one numbered section per function (one sentence on what it does, two to five short sentences on how). Auto-open can be turned off; scroll-sync keeps the twin in step with the code.
- **Human checkpoint** for Claude Code and Codex (terminal tools and their VS Code extensions): every proposed write is stopped before it reaches the disk, shown one function at a time next to a fresh "what changed and why it matters" note, and lands only on Accept. Reject sends your reason back to the assistant. "Accept rest of file" / "Accept rest of session" and trivial-change batching fight approval fatigue.
- **Copilot path**: per-function explanations overlaid on Copilot's own Keep/Undo review, plus `.github/copilot-instructions.md` steering. Stated plainly in the interface as review-after-landing, not a pre-write block.
- **Stale marks, per-section regeneration and whole-project backfill** with a cost estimate, confirmation, progress and pause/resume.
- **Twins stay out of GitHub** through `.git/info/exclude`; an optional shared `.gitignore` entry is offered, never forced.
- **Tamper-evident journal** (hash chain) and a **restore point before every accepted change**, with one-click restore from the ExplainIT view.
- **Self-protection**: writes to the checkpoint's own hooks, scripts, journal and `.git/info/exclude` are refused; hook integrity is verified every session; code being explained is treated as data, never as instructions.
- **Resilience**: loopback-only gate with a per-session token, a 120 s hook watchdog that falls back to the assistant's own prompt, a status-bar heartbeat, a pause switch with a persistent banner, and a Doctor with fourteen or more checks (including a live hook wiring test and a restore round trip) that completes in under 15 seconds.
- **First-run setup**: permission screen, assistant detection (including the Claude Code and Codex VS Code extensions and their bundled binaries), one-click connect with next steps, and guidance when nothing is connected.
- **Five runbooks** for the most likely problems, reachable from "ExplainIT: Help".
- **Explanation quality eval** (HumanEvalExplain subset round trip) with a baseline lock so prompt changes cannot silently make explanations worse.

### Security hardening (pre-release review)

A security review that treated the assistant as a process running with your own account produced ten findings; the fixes below ship in this release, and the remaining risks are written down in `docs/dev/SECURITY-REVIEW.md`.

- The installed hook command now pins the absolute ExplainIT home and the Claude / Codex config locations, and the wrappers export them before running the hook, so an assistant that edits a shell profile (`EXPLAINIT_HOME`, `HOME`, `CODEX_HOME`) can no longer point the hook at a rogue checkpoint or relocate the protected files. The pinned command is part of the integrity hash.
- `.git/hooks/**` and `.git/config` are refused outright in the checkpoint and in the hook's own protected list (git runs them as you, outside ExplainIT). Other `.git/**` writes still go to the assistant's own prompt.
- Shell commands are read with their working directory: `cd`/`pushd` into a protected folder followed by a redirect, `tee` or heredoc is caught, and a protected target is refused in every `checkpoint.shellWrites` mode.
- "Accept the rest of this file/session" is never keyed on a shared fallback when the assistant reports no session id, expires after 30 minutes without use, and is cleared whenever the checkpoint is paused or resumed.
- A `PostToolUse` report is honoured only for writes the checkpoint was expecting; anything else is journaled as a note and otherwise ignored.
- At most 20 reviews can wait for a person per session; beyond that the assistant gets its own prompt.
- A twin file an assistant writes itself is re-rendered by ExplainIT from its own cache after the write lands, with a journal note saying so.
- New setting `explainit.checkpoint.codexUnresponsive` (`deny` by default): Codex has no "ask" answer, so when ExplainIT does not respond within the watchdog time the change is refused with a try-again reason instead of slipping through; `passthrough` restores Codex's own policy. Claude Code keeps falling back to its own prompt.
- The Doctor's "Hook wiring live test" now runs the installed wrapper the same way the assistants do, and says which path it exercised.
- The canonical path of a partially accepted file is checked again immediately before the accepted parts are written.

### Privacy

- No backend, no accounts, no telemetry. Code goes only to the assistants you already use, under your existing agreements.
