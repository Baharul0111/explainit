# Changelog

All notable changes to ExplainIT are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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

### Privacy

- No backend, no accounts, no telemetry. Code goes only to the assistants you already use, under your existing agreements.
