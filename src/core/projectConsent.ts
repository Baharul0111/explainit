/**
 * Per-project permission: ExplainIT asks once per project before it writes twins or instruction
 * files there. Decisions live in <home>/state.json keyed by the canonical workspace folder path.
 * The checkpoint (gate) never consults this: it protects every project regardless.
 */
import type { EventLike, ProjectConsent, ProjectDecision } from './interfaces';
import { canonicalPath, isInside } from './paths';
import type { StateStore } from './state';

export function createProjectConsent(state: StateStore): ProjectConsent {
  const listeners = new Set<(e: { folder: string; decision: ProjectDecision }) => void>();
  const key = (folder: string): string => canonicalPath(folder);

  const fire = (folder: string, decision: ProjectDecision): void => {
    for (const l of listeners) {
      try {
        l({ folder, decision });
      } catch {
        /* a listener must never break the store */
      }
    }
  };

  const onDidChange: EventLike<{ folder: string; decision: ProjectDecision }> = (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };

  return {
    status(folder) {
      const rec = state.read().projects?.[key(folder)];
      if (rec?.twins === 'allowed') return 'allowed';
      if (rec?.twins === 'denied') return 'denied';
      return 'unknown';
    },
    async set(folder, decision) {
      const k = key(folder);
      await state.update((s) => {
        s.projects = s.projects ?? {};
        s.projects[k] = { twins: decision, decidedAt: new Date().toISOString() };
      });
      fire(k, decision);
    },
    async clear(folder) {
      const k = key(folder);
      await state.update((s) => {
        if (s.projects) delete s.projects[k];
      });
      fire(k, 'unknown');
    },
    folderFor(fsPath, folders) {
      return folders.map(key).find((f) => isInside(f, fsPath));
    },
    onDidChange,
  };
}
