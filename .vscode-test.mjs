import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
// A fresh ExplainIT home per run keeps the explanation cache, journal and hook state hermetic.
const freshHome = () => mkdtempSync(join(tmpdir(), 'explainit-home-'));

export default defineConfig([
  {
    label: 'integration',
    files: 'out/test/integration/**/*.test.js',
    workspaceFolder: join(here, 'test', 'fixtures', 'workspace'),
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
    env: {
      EXPLAINIT_TEST_MODE: '1',
      EXPLAINIT_HOME: process.env.EXPLAINIT_HOME || freshHome(),
    },
    mocha: { ui: 'tdd', timeout: 120000, color: true },
  },
]);
