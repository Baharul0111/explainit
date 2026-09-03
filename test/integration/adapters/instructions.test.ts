import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { InstructionsGenerator } from '../../../src/core/interfaces';

interface Api {
  instructions: InstructionsGenerator;
}

suite('instructions (integration)', function () {
  this.timeout(60000);
  let api: Api;
  let dir: string;

  suiteSetup(async () => {
    api = (await vscode.extensions.getExtension('BaharulIslam.explainit-code')!.activate()) as Api;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-instr-int-'));
  });
  suiteTeardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ensure(folder) creates CLAUDE.md, AGENTS.md and .github/copilot-instructions.md', async () => {
    const r = await api.instructions.ensure(dir);
    assert.strictEqual(r.written.length, 3);
    for (const f of ['CLAUDE.md', 'AGENTS.md', path.join('.github', 'copilot-instructions.md')]) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(text.includes('<!-- explainit:start -->') && text.includes('<!-- explainit:end -->'), f);
      assert.ok(text.includes('_explain.txt'), f);
    }
    assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').trim(), api.instructions.sectionText('claude'));
  });

  test('a second ensure changes nothing and keeps text outside the markers', async () => {
    const claude = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claude, '# Mine\n\nKeep this.\n\n' + fs.readFileSync(claude, 'utf8'));
    const r = await api.instructions.ensure(dir);
    assert.strictEqual(r.written.length, 0);
    assert.strictEqual(r.unchanged.length, 3);
    assert.ok(fs.readFileSync(claude, 'utf8').startsWith('# Mine\n\nKeep this.\n'));
  });
});
