# ExplainIT security review (0.1.0, 2026-09-02)

This is the written record of the pre-release security review: what ExplainIT defends against, how, what the
review found, what was fixed in this build, and what is still true that a careful person should know. It is
plain about its limits. `architecture.md` and `docs/dev/CONTRACTS.md` remain the source of truth for the
mechanisms; this document explains why they are shaped the way they are.

## 1. Threat model

**The assistant runs as you.** Claude Code, Codex and Copilot execute with your user account, your home
folder, your shell and your file permissions. Nothing ExplainIT does can take that away, and nothing here
pretends otherwise. The question the review asked is narrower and answerable:

> Given an assistant that can read and write anything you can, can it make a code change land **without the
> person seeing it in the ExplainIT review**, silently switch the review off, or make the record of what
> happened lie?

The assistant is treated as a possibly hostile process: it may be prompt-injected by a file in the repository,
it may be running under `--dangerously-skip-permissions` / full-auto, and it may try every write path it has
(edit tools, shell redirects, git, environment variables, its own hook and config files).

Out of scope, by design:

- Another human or malware with your account editing ExplainIT's files by hand. That is the same trust level
  as you; ExplainIT detects it (integrity hashes, journal chain) but cannot prevent it.
- The assistant vendors' own code and hook semantics. ExplainIT pins the versions it was tested against and
  re-tests them in the conformance suite; if a vendor removes hooks, the checkpoint cannot exist for that
  assistant, and the interface must say so (as it does for Copilot today).
- Explanations being wrong. A model wrote them; they are advice to the person, never an input to a decision.

## 2. Mechanisms

| Mechanism | What it does | Where |
|---|---|---|
| **Loopback gate + per-session token** | The checkpoint listens on `127.0.0.1` on a random port; every hook call carries a 64-hex bearer token written to a `0600` session file under `<home>/sessions/`. Bodies are schema-validated and capped at 8 MB; paths are canonicalised and confined to open folders. | `src/gate/server.ts`, `src/gate/pure/ingress.ts`, `src/gate/pure/sessionFile.ts` |
| **Hook script + wrappers** | A dependency-free CommonJS script the assistants run before (`PreToolUse`) and after (`PostToolUse`) each write. The installer copies it to `<home>/hooks/` and writes `explainit-hook.sh` / `.cmd` wrappers that pin the Node runtime and export the ExplainIT home. The installed command carries `--home`, `--claude-home` and `--codex-home` as absolute paths (and `--unresponsive deny|passthrough` for Codex). | `hooks/explainit-hook.js`, `src/adapters/runtime.ts`, `src/adapters/pure/wrappers.ts`, `src/adapters/pure/hookConfig.ts` |
| **Protected paths** | Refused with a reason in the gate **and** in the hook's own mirror (so they hold even with no window running): `<home>/**`; hook entries in `~/.claude/settings*.json`, `~/.codex/hooks.json`, `config.toml` (and project-layer copies, and `$CODEX_HOME`); `.git/info/exclude`; `.git/hooks/**`; `.git/config`. Other `.git/**` -> `ask` with a warning. Shell commands are analysed per segment with the effective working directory (`cd`/`pushd`), including redirect, `tee` and heredoc targets. | `src/gate/pure/policy.ts`, `src/gate/pure/shell.ts`, `hooks/explainit-hook.js` |
| **Integrity hashes, verified every session** | Script, wrapper and config-entry hashes are stored in `state.json` and verified at activation and by the Doctor; a mismatch is re-armed automatically. Because the pinned paths are part of the command text, they are part of the hash. | `src/adapters/installer.ts`, `src/ux/pure/doctorChecks.ts` |
| **Prompt fencing** | Code sent to a model is wrapped in a fixed sentinel fence with the rule that it is data to describe, never instructions to follow; replies are schema-validated; the twin is plain text that is never executed and never consulted by the gate. | `src/generation/pure/prompts.ts`, `src/generation/pure/schema.ts` |
| **Journal chain** | One canonical-JSON entry per line, `hash = sha256(prevHash + entry)`; `verifyChain` re-hashes every line; rotation keeps the chain verifiable across archive files. | `src/journal/` |
| **Restore points** | A snapshot before every accepted write; restore saves a safety snapshot first; a round-trip self-test in the Doctor. | `src/journal/` |
| **Decision memory with a short life** | "Accept the rest of this file/session" is keyed on agent + session id + path; no session id means no memory; entries expire after 30 minutes without use and are cleared on pause/resume. | `src/review/pure/memory.ts`, `src/ux/index.ts` |
| **Watchdog** | The hook gives up after `checkpoint.watchdogSeconds` of silence (heartbeats reset it). Claude Code gets `ask`; Codex, which has no `ask`, gets `deny` with a try-again reason unless the person chose `passthrough`. | `hooks/explainit-hook.js`, setting `checkpoint.codexUnresponsive` |

## 3. Findings and their status in this build

Severity is the reviewer's; "proven" means a probe reproduced it against the pre-fix build.

### F1 — HIGH, proven — `EXPLAINIT_HOME` / `HOME` / `CODEX_HOME` spoofing redirects the hook. **Fixed.**

The hook found the ExplainIT home from `EXPLAINIT_HOME` and the installed command carried no `--home`. An
assistant that appended `export EXPLAINIT_HOME=/rogue` to `~/.zshrc` and dropped a fake session file there
redirected every future hook call to a rogue gate that answered `allow`: a silent bypass. The same trick with
`HOME` / `CODEX_HOME` relocated the protected `~/.claude` and `~/.codex` files out of the protected list.

Fix: the installed command pins `--home <explainit home> --claude-home <dir> --codex-home <dir>` as absolute
paths; the wrappers export `EXPLAINIT_HOME` before `exec`; the hook prefers the arguments over any environment
variable. The command text is part of the integrity hash, so removing the pins is detected and re-armed. The
Doctor's live wiring test now runs the installed wrapper the way the assistants do (`src/ux/pure/hookLaunch.ts`).

### F2 — MEDIUM/HIGH, proven — `.git/hooks/**` and `.git/config` were only `ask`. **Fixed.**

Git hooks run as the user, outside ExplainIT, on the next commit or checkout; `core.hooksPath` and friends in
`.git/config` do the same. Both were `ask`-only in the gate and unprotected in the hook mirror, so an assistant in
bypass-permissions mode could plant code that runs on your next `git commit`.

Fix: hard `deny` for `.git/hooks/**` and `.git/config` in the gate policy and in the hook's mirror; other
`.git/**` internals stay `ask` with a warning.

### F3 — MEDIUM — decision memory keyed on the assistant-supplied session id. **Mitigated; residual risk.**

"Accept the rest of this session" was stored under the `session_id` from the hook payload, with an
`unknown-session` bucket when it was missing. Any request claiming the same id inherited the acceptance.

Fix: a missing or blank id gets no memory at all (never a shared bucket); session- and file-scope acceptances
expire after 30 minutes of inactivity; everything is cleared when the checkpoint is paused or resumed. What
remains: ExplainIT cannot verify the id, so a process that learns a live session's id during those 30 minutes
inherits its acceptance. See section 4.

### F4 — MEDIUM, proven — substring matching missed `cd ~/.claude && cat > settings.json`. **Fixed.**

The shell guard in the hook and `protectedPathMentioned` in the gate matched protected paths as substrings of
the command text, so a command that changed directory first and then used a relative target was not caught.

Fix: shell analysis tracks `cd`/`pushd` per segment and resolves redirect, `tee` and heredoc targets against
the effective working directory; a protected target is denied in every `checkpoint.shellWrites` mode; the hook
mirrors the same logic.

### F5 — LOW/MEDIUM — a forged `PostToolUse` made the gate journal "applied". **Fixed.**

The assistant can read the session token, so it can send its own `PostToolUse` for any in-workspace path,
making the gate journal `applied`, record a landing and regenerate twins for a file it never proposed.

Fix: `PostToolUse` is honoured only for paths the controller is expecting; for anything else the gate writes a
journal note and does nothing more.

### F6 — INFO — the journal chain is unkeyed. **Documented residual risk.**

The chain detects edits, removals and insertions inside the file; it cannot detect a full rewrite by someone
who recomputes every hash, which anyone with your account can do. A keyed or externally anchored chain would
need a secret the assistant cannot read, and there is no such place on a machine where the assistant is you.

### F7 — LOW — no cap on pending human reviews. **Fixed.**

A flood of proposals could queue an unbounded number of review cards. Fix: at most 20 pending human reviews
per session; beyond that the gate answers `ask`, with a unit test.

### F8 — LOW — assistant-written `*_explain.txt` files were auto-allowed. **Fixed.**

A twin write that passes the structure check is allowed on the fast path (the Doctor's live test relies on
this), so an assistant could plant a misleading twin. Fix: after such a write lands (`PostToolUse` or the
fallback timer), ExplainIT re-renders the twin from its own cache/sidecar (no model cost for unchanged
functions) and journals a system note: "twin written by an assistant; re-rendered by ExplainIT".

### F9 — INFO — explanations can steer a human. **Documented residual risk.**

A prompt-injected model could write a reassuring explanation for a harmful change. Explanations never feed a
decision — only the person's click does — but a person reads them. The review card always shows the actual
diff beside the explanation, and the explanation is labelled as the assistant's words.

### F10 — INFO — TOCTOU between canonicalisation and the partial-accept write. **Fixed.**

Between resolving a path and writing the accepted hunks, a symlink swap could redirect the write. Fix: the
real path is re-validated immediately before the partial-accept write.

## 4. Residual risks, stated plainly

- **The assistant is you.** Everything above raises the cost of a bypass and makes one visible; none of it
  is a sandbox. An assistant with your account can, in the end, edit `~/.explainit` by hand and re-arm
  nothing. ExplainIT detects that on the next session (integrity check) and the Doctor says so.
- **Unkeyed journal chain (F6).** Partial tampering is detected; a determined full rewrite is not. Keep a copy
  of `journal.jsonl` elsewhere if you need evidence that survives your own account.
- **Explanations steer humans, not decisions (F9).** Read the diff, not just the note.
- **Decision memory trusts the reported session id (F3).** The window is 30 minutes of inactivity, cleared on
  pause/resume; set `checkpoint.allowAcceptRestOfSession` to `false` to remove it entirely.
- **Copilot is review-after-landing.** Copilot exposes no pre-write hook. Its changes land first and are
  reviewed with Copilot's own Keep/Undo; a restore point is still saved for each.
- **Codex `passthrough`.** With `checkpoint.codexUnresponsive` = `passthrough`, an unresponsive ExplainIT
  means Codex follows its own approval policy, and under full-auto the change lands without a prompt. The
  default is `deny`; choose `passthrough` knowingly.
- **Hooks apply to new sessions and need Codex trust.** A session started before the hook was installed, or a
  Codex that has not trusted the hook, is not stopped. The Doctor reports both; the interface says so.
- **Vendor hook semantics can change.** Conformance tests pin the tested versions; fixes ship through the
  pre-release channel.

## 5. How to re-run the review

- `npm run test:unit` covers the policy, shell analysis, decision memory, hook config pins and the Doctor's
  launch plan with stubs; `npm run test:conformance` drives the real hook script and, when the environment
  variables are set, the real assistants.
- The probes that proved F1, F2 and F4 are reproducible by hand: set `EXPLAINIT_HOME` in a shell profile and
  run any hook; ask an assistant to write `.git/hooks/pre-commit`; ask it to run
  `cd ~/.claude && cat > settings.json`. Each must now be refused with a reason, with or without a running
  ExplainIT window.
- Run **ExplainIT: Doctor**: "Claude Code checkpoint hook", "Codex checkpoint hook" and "Hook wiring live test"
  must be OK and the live test must say it ran through the installed wrapper.
