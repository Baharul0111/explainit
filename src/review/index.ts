/**
 * Review module entry (REQ-014). Factories per docs/dev/CONTRACTS.md "Factories".
 */
export { createReviewPresenter } from './panel';
export type { ReviewTestHook } from './panel';
export { createDecisionMemory, hunkHashOf } from './pure/memory';
