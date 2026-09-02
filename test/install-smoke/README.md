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
5. The probe waits for the VSIX-installed ExplainIT, activates it, checks the commands, opens
   `src/app.py`, runs `explainit.openTwin`, waits for `app_explain.txt` with `1. load_config`
   explained, checks the twin is open beside the code and that `.git/info/exclude` has
   `*_explain.txt`, writes `probe-result.json`, and quits VS Code.
6. Prints one line per check and a final `PASS` or `FAIL` with the reasons. Exit code 1 on failure.

Flags: `--vsix <file>`, `--version <stable|insiders|x.y.z>`, `--timeout <seconds>` (default 180),
`--keep` (or `EXPLAINIT_SMOKE_KEEP=1`) to keep the temp profile for inspection,
`EXPLAINIT_SMOKE_VERBOSE=1` to echo VS Code's own output.

Pure helpers live in `pure/smoke.ts` and are unit-tested in `test/*.test.ts`
(`npx mocha "out/test/install-smoke/test/**/*.test.js"`).
