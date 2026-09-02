/**
 * Tiny JSON state store for <home>/state.json (consent, onboarding, adapter integrity hashes).
 * Read-modify-write under an in-process mutex; the file is private to the user (0600).
 */
import * as fs from 'node:fs';
import { HOME_LAYOUT, writePrivateFile } from './paths';

export interface ExplainitState {
  version: 1;
  consentGranted?: boolean;
  consentAt?: string;
  onboardingDone?: boolean;
  checkpointPaused?: boolean;
  adapters?: Partial<Record<'claude' | 'codex' | 'copilot', AdapterRecord>>;
  channelPin?: string;
  [extra: string]: unknown;
}

export interface AdapterRecord {
  installedAt?: string;
  scriptHash?: string;
  wrapperHash?: string;
  configHash?: string;
  configPath?: string;
  wrapperPath?: string;
  runtime?: string;
  notes?: string[];
}

export interface StateStore {
  read(): ExplainitState;
  update(mutate: (s: ExplainitState) => void): Promise<ExplainitState>;
  readonly file: string;
}

export function createStateStore(file: string = HOME_LAYOUT.stateFile()): StateStore {
  let chain: Promise<unknown> = Promise.resolve();
  const read = (): ExplainitState => {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return { version: 1, ...parsed };
    } catch {
      /* missing or corrupt -> fresh */
    }
    return { version: 1 };
  };
  return {
    file,
    read,
    update(mutate) {
      const run = chain.then(() => {
        const s = read();
        mutate(s);
        writePrivateFile(file, JSON.stringify(s, null, 2) + '\n');
        return s;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
