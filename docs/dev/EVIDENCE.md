# Evidence that ExplainIT meets goal.md (build of 2026-09-02)

This file is updated with every verification run. Commands are exact; counts come from the runs named.

## Automated suites

| Suite | Command | Result |
|---|---|---|
| Unit (all modules + eval + install-smoke helpers) | `npm run test:unit` | 999 passing, 0 failing (local macOS, 2026-09-02) |
| Hook conformance (hook script against a stub gate) | `npm run test:conformance` | 29 passing |
| VS Code integration (extension activated in a real VS Code, fixture workspace) | `npm run test:integration` | 91 passing, 0 failing, twice in a row on a fresh ExplainIT home |
| Fresh-install smoke (VSIX into a fresh VS Code user-data-dir) | `npm run package && node scripts/check-vsix.js && npm run test:install` | PASS, 17 checks; VSIX 27 files, 1.7 MB |
| Real agents (env-gated, spends credits) | `EXPLAINIT_REAL_AGENTS=1 npx mocha --ui tdd out/test/conformance/real-agents.test.js` | Claude Code CLI on PATH: deny stops the edit before disk, allow lets it land (pass). Claude binary bundled in the Claude Code VS Code extension: same two scenarios pass. Codex hooks/list trust conformance (PATH 0.152.0 and the bundled 0.151): pass. Codex `exec` deny/allow (4 tests): blocked on this Mac by a revoked Codex sign-in (`codex login` needed); the hook wiring itself is proven by the trust checks and the hook conformance suite. |
| Explanation quality eval (REQ-020) | `npm run eval -- --channel <claude|codex|fake> --update-baseline` | claude 12/12 pass@1, 12/12 style; codex 12/12, 12/12; fake 11/12, 12/12 (eval/baseline.json, prompt hash locked by eval/baseline.test.ts) |
| CI, three operating systems | `.github/workflows/ci.yml` on push | run 3 pending at the time of writing (see the Actions tab of Baharul0111/explainit) |

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

## Manual step that remains with Baharul

Publishing to the Marketplace and Open VSX (`scripts/release-checklist.md`, `.github/workflows/release.yml`) waits for the explicit go-ahead.
Codex real-agent `exec` scenarios need `codex login` on this Mac (sign-in was revoked server-side on 2026-09-02).
