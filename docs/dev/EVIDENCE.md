# Evidence that ExplainIT meets goal.md (build of 2026-09-02)

This file is updated with every verification run. Commands are exact; counts come from the runs named.

## Automated suites

| Suite | Command | Result |
|---|---|---|
| Unit (all modules + eval + install-smoke helpers) | `npm run test:unit` | 1065 passing, 0 failing (local macOS, 2026-09-02 evening; CI Linux/macOS green) |
| Hook conformance (hook script against a stub gate, incl. rogue-home redirect, wrapper execution, Codex deny/passthrough) | `npm run test:conformance` | 36 passing |
| VS Code integration (extension activated in a real VS Code, fixture workspace) | `npm run test:integration` | 98 passing, 0 failing (local; CI Linux and macOS green in run 5) |
| Fresh-install smoke (VSIX into a fresh VS Code user-data-dir) | `npm run package && node scripts/check-vsix.js && npm run test:install` | PASS, 26 checks including a full checkpoint round trip through the installed hook wrapper (reject -> deny with the reason, accept -> allow with a restore point); VSIX 27 files, 1.7 MB |
| Real agents (env-gated, spends credits) | `EXPLAINIT_REAL_AGENTS=1 npx mocha --ui tdd out/test/conformance/real-agents.test.js` | Claude Code CLI on PATH: deny stops the edit before disk, allow lets it land (pass). Claude binary bundled in the Claude Code VS Code extension: same two scenarios pass. Codex hooks/list trust conformance (PATH 0.152.0 and the bundled 0.151): pass. Codex `exec` deny/allow (4 tests): blocked on this Mac by a revoked Codex sign-in (`codex login` needed); the hook wiring itself is proven by the trust checks and the hook conformance suite. |
| Explanation quality eval (REQ-020) | `npm run eval -- --channel <claude|codex|fake> --update-baseline` | claude 12/12 pass@1, 12/12 style; codex 12/12, 12/12; fake 11/12, 12/12 (eval/baseline.json, prompt hash locked by eval/baseline.test.ts) |
| CI, three operating systems | `.github/workflows/ci.yml` on push | Run 9 (https://github.com/Baharul0111/explainit/actions/runs/33663723478): ubuntu-latest, windows-latest and macos-latest all green end to end (lint, typecheck, 1068 unit, 36 conformance, 98 integration inside VS Code, package, check-vsix, fresh-install smoke with 26 checks) plus the no-network-and-security job |

## Goal items ("What it must do") -> proof

1. First-use permission, detection, one-click connect, guidance -> `src/ux/onboarding.ts`; integration `test/integration/ux/ux.test.ts` (onboarding in test mode sets consent + onboardingDone), `test/integration/adapters/adapters.test.ts` (detect returns all three agents, install/uninstall claude and codex).
2. Twin opens beside any code file; toggle -> `src/twin/autoOpen.ts`, `twin.setAutoOpen`; `test/integration/twin/twin.test.ts` (auto-open beside; autoOpen off -> nothing opens).
3. Fixed style; only new/changed functions explained -> `src/twin/pure/render.ts` (exact format, `test/unit/twin/render.test.ts`), `src/generation/pure/prompts.ts` + `schema.ts`; cache-first `src/generation/router.ts` (`test/unit/generation/router.test.ts` cache hit never spawns the CLI); `updateAfterChange` sends only the changed function (`test/integration/twin/twin.test.ts`).
4. Every language -> DocumentSymbol -> tree-sitter (8 grammars) -> heuristics -> AI segmentation; `test/unit/structure/treeSitter.test.ts` (py, ts, js, go, rs, java, c, cpp), `heuristic.test.ts` (COBOL, shell), `test/integration/structure/structure.test.ts`.
5. Stale marks, one-section regenerate, scroll sync, backfill with estimate/confirm/progress/pause/resume -> `src/twin/staleWatch.ts`, `scrollSync.ts`, `backfill.ts`; `test/integration/twin/twin.test.ts`, `backfill.test.ts`.
6. Twins out of GitHub via `.git/info/exclude`, optional shared `.gitignore` offer -> `src/twin/pure/gitExclude.ts`; `test/unit/twin/gitExclude.test.ts`, `test/integration/twin/gitExclude.test.ts`, install smoke check.
7. Claude Code and Codex writes stopped before disk, per-function review, Accept only after the explanation is visible, reject reason back, accept-rest-of-file/session, trivial batching -> `hooks/explainit-hook.js`, `src/gate/**`, `src/review/**`; `test/conformance/hook.test.ts`, `test/unit/gate/*.test.ts` (236), `test/unit/review/*.test.ts`, `test/integration/gate/gate.test.ts`, `test/integration/review/presenter.test.ts`, `test/conformance/real-agents.test.ts`.
8. Self-tamper protection and injection defence -> protected paths in `src/gate/pure/policy.ts` and the hook mirror; integrity + rearm `src/adapters/installer.ts` (verified at every activation in `src/extension.ts`); fenced prompts `src/generation/pure/prompts.ts` with `test/fixtures/workspace/injection.py` red-team tests.
9. Fallback within two minutes -> hook watchdog (`--watchdog`, default 120 s) -> `ask`; `test/conformance/hook.test.ts` (silent gate, gate stops answering mid long-poll, refused connection).
10. Copilot review-compose path, said plainly -> `src/adapters/copilotWatcher.ts` (notice text), README, `test/integration/adapters/copilotWatcher.test.ts`.
11. Tamper-evident journal, restore point before every accepted change, one-click restore -> `src/journal/**`; `test/unit/journal/*.test.ts` (chain verify, tamper detection, restore), gate integration test (journal + restore point on accept), journal tree view.
12. Pause switch + banner, heartbeat, Doctor with live restore self-test, empty/loading/error messages, five runbooks -> `src/ux/**`, `docs/runbooks/1..5`; `test/unit/ux/*.test.ts`, `test/integration/ux/ux.test.ts`.
13. Built-in quality test that refuses worse prompts -> `eval/**`, `eval/baseline.test.ts` (prompt-hash lock + no-regression), `test/integration/eval/promptHash.test.ts`.
14. Fast, three OSes, packaged, honest description -> cached-open budget test (`test/integration/twin/twin.test.ts`), streaming provisional twin, CI matrix, `npm run package` + `scripts/check-vsix.js`, README "what is sent where".
15. Claude Code and Codex VS Code extensions -> detection of bundled binaries (`src/adapters/pure/extensionDirs.ts`), CLI resolver falls back to them (`src/generation/channels/cli.ts`), same user-layer hooks arm both (`test/conformance/real-agents.test.ts` bundled-binary scenarios), Doctor covers both paths.

## Publication

Published 2026-09-03 to the VS Code Marketplace as `BaharulIslam.explainit-code` v0.1.0 (display name "ExplainIT: Plain-English Twins & AI Checkpoint"; the identifier and display name `explainit` were already taken by another publisher). Listing: https://marketplace.visualstudio.com/items?itemName=BaharulIslam.explainit-code

Verified 2026-09-03 21:16 IST: the public gallery query for "ExplainIT" lists `BaharulIslam.explainit-code`, and a fresh VS Code profile installed it from the Marketplace (`--install-extension BaharulIslam.explainit-code` -> `baharulislam.explainit-code@0.1.0`).

## 0.2.0 (2026-09-05): four fixes from first real use

| Change | Proof |
|---|---|
| Twins wrap instead of scrolling sideways | `package.json` registers `explainit-twin` for `*_explain.txt` with `editor.wordWrap: on`; the scroll-sync suite (sticky scroll on and off) passes with the new defaults |
| Ask once per project before explaining | `test/unit/core/projectConsent.test.ts`; `test/integration/twin/projectPermission.test.ts` (refused project gets no twin on open nor on request; allowed project does; an undecided project is asked once and remembered; the command flips it; the `always` setting skips the question) |
| Checkpoint armed automatically on a fresh machine | `src/adapters/arm.ts` + `test/unit/adapters/ensureArmed.test.ts` (no consent: nothing; consent: every assistant found is armed into a temp user home, second call finds it armed); status bar `unarmed` state in `test/unit/ux/statusUnarmed.test.ts`; called at every activation and from onboarding |
| Instruction files ExplainIT creates stay out of git | `test/unit/core/gitExcludeFile.test.ts`, `test/unit/instructions/exclude.test.ts` (created files excluded locally, team files untouched, setting turns it off) |

Local runs on 2026-09-05: 1084 unit, 36 hook conformance, 103 VS Code integration, install smoke PASS (26 checks) against `explainit-code-0.2.0.vsix`. CI run https://github.com/Baharul0111/explainit/actions/runs/33971265987 green on ubuntu, windows and macos. Published 2026-09-05 19:52 IST as `BaharulIslam.explainit-code` v0.2.0; the public gallery served 0.2.0 by 19:56 and a fresh VS Code profile installed `baharulislam.explainit-code@0.2.0` from the Marketplace.

## Manual step that remains with Baharul

Publishing to the Marketplace and Open VSX (`scripts/release-checklist.md`, `.github/workflows/release.yml`) waits for the explicit go-ahead.
Codex real-agent `exec` scenarios need `codex login` on this Mac (sign-in was revoked server-side on 2026-09-02).

## Security hardening evidence (docs/dev/SECURITY-REVIEW.md)

- Rogue-home redirect (F1): `test/conformance/hook.test.ts` "rogue EXPLAINIT_HOME ... never contacted with --home"; unit tests assert every installed hook command pins `--home`, `--claude-home`, `--codex-home` and the wrappers export `EXPLAINIT_HOME`.
- Git hooks/config (F2), cd-relocated shell writes (F4): `test/unit/gate/policy.test.ts`, `test/unit/gate/shell.test.ts`, `test/conformance/hook.test.ts` (17 denied / 10 allowed shell cases).
- Decision-memory expiry and no-session isolation (F3): `test/unit/review/memory.test.ts`, `test/unit/gate/controller.test.ts`.
- Forged PostToolUse ignored (F5), pending cap (F7), twin re-render (F8), pre-write realpath re-check (F10): `test/unit/gate/controller.test.ts`, `test/unit/gate/server.test.ts`.
- Session-start integrity pass (goal item 8): `test/unit/adapters/startup.test.ts`, wired in `src/extension.ts`.
