import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

suite('eval baseline lock (live extension)', () => {
  test('the running extension uses exactly the prompts the eval baseline was recorded with', async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension('BaharulIslam.explainit')!;
    const api = await ext.activate();
    const baselinePath = path.join(ext.extensionPath, 'eval', 'baseline.json');
    assert.ok(fs.existsSync(baselinePath), `missing ${baselinePath}`);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as { promptHash: string };
    assert.strictEqual(
      api.router.promptHash(),
      baseline.promptHash,
      'Prompts changed without re-running the eval: run npm run eval -- --channel <c> --update-baseline',
    );
  });
});
