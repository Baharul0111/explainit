import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { HOME_LAYOUT } from '../../src/core/paths';

suite('extension activation', () => {
  test('activates, exports the api, and the gate is listening with a session file', async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension('BaharulIslam.explainit-code');
    assert.ok(ext, 'extension not found');
    const api = await ext!.activate();
    assert.ok(api.gate && api.twin && api.router && api.structure && api.adapters && api.ux, 'api incomplete');
    const info = api.gate.info;
    assert.ok(info && info.port > 0 && info.token.length === 64, 'gate not started');
    const file = `${HOME_LAYOUT.sessions()}/${process.pid}.json`;
    assert.ok(fs.existsSync(file), `session file missing: ${file}`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.port, info!.port);
    const res = await fetch(`http://127.0.0.1:${info!.port}/v1/health`);
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.strictEqual(body.ok, true);
  });

  test('every contributed command is registered', async () => {
    const ext = vscode.extensions.getExtension('BaharulIslam.explainit-code')!;
    await ext.activate();
    const declared: string[] = (ext.packageJSON.contributes.commands as { command: string }[]).map((c) => c.command);
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = declared.filter((c) => !all.has(c));
    assert.deepStrictEqual(missing, [], `missing commands: ${missing.join(', ')}`);
  });
});
