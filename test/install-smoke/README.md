# Fresh-install smoke test

Proves the finish criterion in goal.md: the extension installs from its package into a fresh copy of
VS Code and, with nothing but the person's assistant permission, writes a correct twin beside a real
code file, opens it next to the code, keeps it out of git, and puts a working checkpoint in front of
an assistant's write: the Claude Code hook is installed through the installed extension and run the
way Claude Code runs it, once rejected and once accepted.

```
npm run package        # builds explainit-<version>.vsix in the repo root
npm run test:install   # compiles and runs out/test/install-smoke/run.js
```

On Linux without a display: `xvfb-run -a npm run test:install` (CI does this).

What it does, in order:

1. Finds the newest `explainit-*.vsix` in the repo root (fails with "run npm run package first" if none).
2. Downloads VS Code with `@vscode/test-electron` into `.vscode-test` (reused across runs).
3. Installs the VSIX into a brand-new `--user-data-dir` / `--extensions-dir` under the OS temp folder
   and checks `--list-extensions` shows `BaharulIslam.explainit`.
4. Copies `test/fixtures/workspace` to a temp folder, runs `git init` there, writes a `settings.json`
   that points ExplainIT at the fake Claude CLI (`test/fixtures/fake-cli/claude.js`) and pre-seeds the
   permission grant, then launches VS Code with `probe/` as the development extension.
5. The probe waits for the VSIX-installed ExplainIT, activates it, checks the commands and that the
   checkpoint gate listens on 127.0.0.1, opens `src/app.py`, runs `explainit.openTwin`, waits until
   `app_explain.txt` has a *complete* `1. load_config` section (a real "What it does:" sentence from
   the fake assistant plus 2..5 "How it works" steps; the "(explaining...)" placeholder does not
   count), checks the twin is open beside the code and that `.git/info/exclude` has `*_explain.txt`.
6. The probe then exercises the checkpoint exactly as a real install would: it calls
   `api.adapters.install('claude')` on the installed extension, which writes the wrapper and hook
   script under `EXPLAINIT_HOME/hooks/` and the hook entry (pinned with `--home`, `--claude-home`,
   `--codex-home`) into `.claude/settings.json` under `EXPLAINIT_USER_HOME` (a folder inside the temp
   profile, never the real `~/.claude`). It reads that exact command back from `settings.json` and
   runs it through the shell (`sh -c` / `cmd.exe /d /s /c`) with a Claude Code `PreToolUse` `Write`
   payload for `src/app.py` that changes one line of `greet()` on stdin, drives the review through
   `globalThis.__explainitReviewTestHook` (rejects with "keep it"; then, after waiting for the
   explanation, accepts) and checks: the rejected run printed `deny` with a reason carrying
   "keep it" and `app.py` is unchanged; the accepted run printed `allow` and
   `api.kits()[0].checkpoints.list()` gained a restore point holding the pre-change `app.py`.
   It writes `probe-result.json` (each step as it completes, so a timeout still shows how far it
   got) and quits VS Code.
7. After VS Code has quit, `run.ts` re-reads the twin, the exclude file, the temp `settings.json`,
   the wrapper, the raw hook stdout the probe recorded and the restore-point index from disk and
   checks them again independently of the probe (what is on disk is what the person keeps). Every
   name in `REQUIRED_STEPS` (`pure/smoke.ts`) must appear in the probe result; a step that was never
   recorded is a named failure, never a shorter list of green ticks.
8. Prints one line per check and a final `PASS` or `FAIL` with the reasons. Exit code 1 on failure.

Flags: `--vsix <file>`, `--version <stable|insiders|x.y.z>`, `--timeout <seconds>` (default 300),
`--keep` (or `EXPLAINIT_SMOKE_KEEP=1`) to keep the temp profile for inspection,
`EXPLAINIT_SMOKE_VERBOSE=1` to echo VS Code's own output.

Pure helpers live in `pure/smoke.ts` and are unit-tested in `test/*.test.ts`
(`npx mocha "out/test/install-smoke/test/**/*.test.js"`), together with the hardening scripts in
`scripts/` (`check-no-network.js`, `check-workflows.js`, `check-vsix.js`, `perf-report.js`).

Before the smoke test, `node scripts/check-vsix.js` checks that the package contains only what ships
(no sources, tests, scratch `out-*/` folders or `.env`); CI runs it right after `npm run package`.
