// Bundles the extension host code into dist/extension.js and copies runtime assets.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** Grammars bundled for the tree-sitter fallback (top 8; C files use the C++ grammar). */
const GRAMMARS = ['python', 'javascript', 'typescript', 'tsx', 'java', 'go', 'cpp', 'rust'];

function copyAssets() {
  const src = join('node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
  const dst = join('dist', 'wasm');
  mkdirSync(dst, { recursive: true });
  for (const f of ['tree-sitter.wasm', ...GRAMMARS.map((g) => `tree-sitter-${g}.wasm`)]) {
    const p = join(src, f);
    if (existsSync(p)) cpSync(p, join(dst, f));
    else console.warn(`[esbuild] missing grammar asset ${p}`);
  }
}

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  define: { 'process.env.EXPLAINIT_BUILD': JSON.stringify(production ? 'production' : 'development') },
});

copyAssets();
if (production) { try { rmSync(join('dist', 'extension.js.map'), { force: true }); } catch { /* no stale source map */ } }
if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
