import * as vscode from 'vscode';
import { SETTINGS_DEFAULTS, SETTING_KEYS, type Settings, type SettingsValues } from './settings';

const SECTION = 'explainit';

export function vscodeSettings(): Settings & vscode.Disposable {
  const emitter = new vscode.EventEmitter<(keyof SettingsValues)[]>();
  const sub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(SECTION)) return;
    const changed = (Object.keys(SETTING_KEYS) as (keyof SettingsValues)[]).filter((k) =>
      e.affectsConfiguration(`${SECTION}.${SETTING_KEYS[k]}`),
    );
    if (changed.length) emitter.fire(changed);
  });
  return {
    get: (k) => {
      const v = vscode.workspace.getConfiguration(SECTION).get(SETTING_KEYS[k]);
      return (v === undefined || v === null ? SETTINGS_DEFAULTS[k] : v) as any;
    },
    set: async (k, v, scope) => {
      const target = scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration(SECTION).update(SETTING_KEYS[k], v, target);
    },
    onDidChange: (l) => emitter.event(l),
    dispose: () => {
      sub.dispose();
      emitter.dispose();
    },
  };
}
