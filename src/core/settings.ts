/**
 * Typed view of the `explainit.*` settings. The vscode-backed implementation lives in
 * src/core/settingsVscode.ts; tests use `inMemorySettings()`.
 */
import type { Channel } from './types';

export interface SettingsValues {
  autoOpenTwin: boolean;
  scrollSync: boolean;
  channelPin: Channel | 'auto';
  tokenThrift: boolean;
  generationTimeoutSeconds: number;
  claudeCliPath: string;
  codexCliPath: string;
  gateEnabled: boolean;
  gateWatchdogSeconds: number;
  gateShellWrites: 'deny' | 'ask' | 'ignore';
  gateBatchTrivial: boolean;
  gateAllowSessionAccept: boolean;
  backfillMaxFunctionsPerRequest: number;
  backfillExcludeGlobs: string[];
  journalMaxEntries: number;
  checkpointsMaxPerFile: number;
  checkpointsMaxTotalMB: number;
  copilotWatcher: boolean;
  instructionsAutoUpdate: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  stalenessMarks: boolean;
}

export const SETTINGS_DEFAULTS: SettingsValues = {
  autoOpenTwin: true,
  scrollSync: true,
  channelPin: 'auto',
  tokenThrift: true,
  generationTimeoutSeconds: 90,
  claudeCliPath: 'claude',
  codexCliPath: 'codex',
  gateEnabled: true,
  gateWatchdogSeconds: 120,
  gateShellWrites: 'deny',
  gateBatchTrivial: true,
  gateAllowSessionAccept: true,
  backfillMaxFunctionsPerRequest: 20,
  backfillExcludeGlobs: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/build/**', '**/*.min.js', '**/vendor/**'],
  journalMaxEntries: 5000,
  checkpointsMaxPerFile: 20,
  checkpointsMaxTotalMB: 200,
  copilotWatcher: true,
  instructionsAutoUpdate: true,
  logLevel: 'info',
  stalenessMarks: true,
};

/** Maps SettingsValues keys to the `explainit.*` configuration keys in package.json. */
export const SETTING_KEYS: Record<keyof SettingsValues, string> = {
  autoOpenTwin: 'twin.autoOpen',
  scrollSync: 'twin.scrollSync',
  channelPin: 'assistant.channel',
  tokenThrift: 'assistant.tokenThrift',
  generationTimeoutSeconds: 'assistant.timeoutSeconds',
  claudeCliPath: 'assistant.claudeCliPath',
  codexCliPath: 'assistant.codexCliPath',
  gateEnabled: 'checkpoint.enabled',
  gateWatchdogSeconds: 'checkpoint.watchdogSeconds',
  gateShellWrites: 'checkpoint.shellWrites',
  gateBatchTrivial: 'checkpoint.batchTrivialChanges',
  gateAllowSessionAccept: 'checkpoint.allowAcceptRestOfSession',
  backfillMaxFunctionsPerRequest: 'backfill.maxFunctionsPerRequest',
  backfillExcludeGlobs: 'backfill.excludeGlobs',
  journalMaxEntries: 'journal.maxEntries',
  checkpointsMaxPerFile: 'restorePoints.maxPerFile',
  checkpointsMaxTotalMB: 'restorePoints.maxTotalMB',
  copilotWatcher: 'copilot.reviewOverlay',
  instructionsAutoUpdate: 'instructions.autoUpdate',
  logLevel: 'logLevel',
  stalenessMarks: 'twin.stalenessMarks',
};

export interface Settings {
  get<K extends keyof SettingsValues>(key: K): SettingsValues[K];
  set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K], scope?: 'global' | 'workspace'): Promise<void>;
  onDidChange(listener: (keys: (keyof SettingsValues)[]) => void): { dispose(): void };
}

export function inMemorySettings(overrides: Partial<SettingsValues> = {}): Settings {
  const values: SettingsValues = { ...SETTINGS_DEFAULTS, ...overrides };
  const listeners = new Set<(keys: (keyof SettingsValues)[]) => void>();
  return {
    get: (k) => values[k],
    set: async (k, v) => {
      (values as any)[k] = v;
      for (const l of listeners) l([k]);
    },
    onDidChange: (l) => {
      listeners.add(l);
      return { dispose: () => listeners.delete(l) };
    },
  };
}
