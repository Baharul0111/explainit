/**
 * Where the eval's files live. Compiled output may sit in out/eval or out-eval/eval, so the repo
 * root is found by walking up from this file until the ExplainIT package.json appears.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

let cachedRoot: string | undefined;

/** Absolute path of the repository root (the folder holding package.json with name "explainit"). */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string };
      if (parsed.name === 'explainit') {
        cachedRoot = dir;
        return dir;
      }
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find the ExplainIT repository root above ${__dirname}. Run the eval from a checkout of the repo (npm run eval).`);
}

export const EVAL_PATHS = {
  dir: () => path.join(repoRoot(), 'eval'),
  subset: () => path.join(repoRoot(), 'eval', 'humaneval-subset.json'),
  baseline: () => path.join(repoRoot(), 'eval', 'baseline.json'),
  results: () => path.join(repoRoot(), 'eval', 'results'),
  fixtures: () => path.join(repoRoot(), 'eval', 'fixtures'),
  styleFixtures: () => path.join(repoRoot(), 'eval', 'fixtures', 'explanations.json'),
  /** Our own minimal fake of the `claude -p` CLI (used by --channel fake). */
  fakeClaude: () => path.join(repoRoot(), 'eval', 'fixtures', 'fake-claude.js'),
  /** The generation module's fake CLI, preferred when it exists. */
  sharedFakeClaude: () => path.join(repoRoot(), 'test', 'fixtures', 'fake-cli', 'claude.js'),
};

/** Extension version from package.json (the router wants it in CoreDeps). */
export function packageVersion(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
