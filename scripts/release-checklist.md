# Release checklist (manual, Baharul only)

Publishing is public and cannot be undone, so it waits for your explicit go-ahead. Everything else
is automated. Do these steps in order from a clean checkout of `main`.

## 0. Before you start

- CI is green on `main` for all three operating systems (`CI` workflow), including the fresh-install
  smoke test and the `no-network-and-security` job.
- `CHANGELOG.md` has an entry for this version and `package.json` `version` matches it.
- Tokens: `VSCE_PAT` (Azure DevOps personal access token with the Marketplace "Manage" scope for
  publisher `BaharulIslam`) and `OVSX_PAT` (Open VSX access token for the `BaharulIslam` namespace).
  Keep them in your shell or in the repo's GitHub secrets, never in a file that is committed. The
  local `.env` is git-ignored; do not paste tokens anywhere else.

## 1. Build and package

```
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run build
npm run package            # -> explainit-<version>.vsix in the repo root
npm run test:install       # fresh VS Code installs the VSIX and drives it end to end (Linux: xvfb-run -a npm run test:install)
```

Then run `node scripts/check-vsix.js` (CI and the release workflow run it too). It reads the package
and fails if anything is missing (`extension/dist/extension.js`, `extension/dist/wasm/`,
`extension/hooks/explainit-hook.js`, `extension/docs/runbooks/`) or if anything that must not ship is
in it: `src/`, `test/`, `.env`, `node_modules/`, scratch build folders (`out-*/`), `.workflows/`, `*.log`,
or simply too many files (a healthy package is a few dozen files, not thousands; `vsce` prints the
tree while packaging). If stray folders show up, delete them (they are git-ignored) or add them to
`.vscodeignore`, then package again from a clean checkout (`git clean -ndx` shows what a fresh clone
would not have). `unzip -l explainit-<version>.vsix` shows the full list if you want to look yourself.

## 2. Dry run in the release workflow (optional but recommended)

GitHub -> Actions -> `Release` -> Run workflow with `target = both`, `dry-run = true`.
It rebuilds, packages, runs the unit tests and uploads the VSIX as a workflow artifact without publishing.

## 3. Publish to the VS Code Marketplace

```
export VSCE_PAT=...            # or: set it only for this command
npx vsce publish --no-dependencies --packagePath explainit-<version>.vsix
```

Or, from the same workflow: `target = marketplace`, `dry-run = false` (uses the `VSCE_PAT` secret).
Check https://marketplace.visualstudio.com/items?itemName=BaharulIslam.explainit shows the new version
(it can take a few minutes to verify).

## 4. Publish to Open VSX (Cursor, VSCodium, Gitpod)

```
export OVSX_PAT=...
npx ovsx publish explainit-<version>.vsix
```

Or, from the workflow: `target = openvsx` (or `both`), `dry-run = false` (uses the `OVSX_PAT` secret).
Check https://open-vsx.org/extension/BaharulIslam/explainit.

## 5. Create the GitHub release

The workflow does this when `dry-run = false`: tag `v<version>` on the run's commit, release notes
generated from the merged pull requests, and the VSIX attached as an asset. By hand:

```
git tag v<version>
git push origin v<version>
gh release create v<version> explainit-<version>.vsix --title "ExplainIT v<version>" --generate-notes
```

## 6. After publishing

- Install the published version into a clean VS Code profile and run "ExplainIT: Doctor" once.
- Bump `package.json` to the next version with `-dev` in the changelog heading so nobody re-publishes
  the same version by accident (`vsce` refuses duplicates anyway).

## If something goes wrong

- `vsce publish` fails with 401/403: the PAT is wrong or expired, or lacks the "Marketplace (Manage)"
  scope for the `BaharulIslam` publisher. Create a new token at https://dev.azure.com and retry.
- `ovsx publish` fails with "namespace not found": create the namespace once with
  `npx ovsx create-namespace BaharulIslam -p $OVSX_PAT`.
- The same version was already published: bump the version, re-run from step 1. Published versions
  cannot be replaced, only unpublished (which people notice), so prefer a patch release.
