/**
 * Consent store backed by <home>/state.json (`consentGranted`). The ux onboarding sets it after the
 * person agrees that code goes only to the assistants they already use, under their existing
 * agreements. No channel is used before `granted()` is true.
 */
import type { ConsentStore } from '../../core/interfaces';
import type { StateStore } from '../../core/state';

export function createConsentStore(state: StateStore): ConsentStore {
  return {
    granted(): boolean {
      try {
        return state.read().consentGranted === true;
      } catch {
        return false;
      }
    },
    async setGranted(v: boolean): Promise<void> {
      await state.update((s) => {
        s.consentGranted = v;
        s.consentAt = v ? new Date().toISOString() : undefined;
      });
    },
  };
}
