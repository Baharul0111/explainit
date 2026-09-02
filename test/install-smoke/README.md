# Fresh-install smoke test

Proves the finish criterion in goal.md: the extension installs from its package into a fresh copy of
VS Code and, with nothing but the person's assistant permission, writes a correct twin beside a real
code file, opens it next to the code, and keeps it out of git.

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
   count), checks the twin is open beside the code and that `.git/info/exclude` has `*_explain.txt`,
   writes `probe-result.json`, and quits VS Code.
6. After VS Code has quit, `run.ts` re-reads the twin and the exclude file from disk and checks them
   again independently of the probe (what is on disk is what the person keeps).
7. Prints one line per check and a final `PASS` or `FAIL` with the reasons. Exit code 1 on failure.

Flags: `--vsix <file>`, `--version <stable|insiders|x.y.z>`, `--timeout <seconds>` (default 180),
`--keep` (or `EXPLAINIT_SMOKE_KEEP=1`) to keep the temp profile for inspection,
`EXPLAINIT_SMOKE_VERBOSE=1` to echo VS Code's own output.

Pure helpers live in `pure/smoke.ts` and are unit-tested in `test/*.test.ts`
(`npx mocha "out/test/install-smoke/test/**/*.test.js"`), together with the hardening scripts in
`scripts/` (`check-no-network.js`, `check-workflows.js`, `check-vsix.js`, `perf-report.js`).

Before the smoke test, `node scripts/check-vsix.js` checks that the package contains only what ships
(no sources, tests, scratch `out-*/` folders or `.env`); CI runs it right after `npm run package`.
