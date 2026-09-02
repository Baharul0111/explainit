import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same as the repo's .vscode-test.mjs but the compiled tests come from the twin agent's own outDir.
const root = '/Users/baharulislam/Desktop/explainit';
const freshHome = () => mkdtempSync(join(tmpdir(), 'explainit-home-twin-'));

export default defineConfig([
  {
    label: 'integration',
    extensionDevelopmentPath: root,
    files: '../../../out-twin/test/integration/**/*.test.js',
    workspaceFolder: join(root, 'test', 'fixtures', 'workspace'),
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
    env: {
      EXPLAINIT_TEST_MODE: '1',
      EXPLAINIT_HOME: process.env.EXPLAINIT_HOME || freshHome(),
    },
    mocha: { ui: 'tdd', timeout: 120000, color: false },
  },
]);
