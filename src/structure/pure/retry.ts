/**
 * Readiness retry for the DocumentSymbol provider (REQ-002). VS Code can answer
 * `executeDocumentSymbolProvider` with nothing while a language extension is still starting
 * (vscode issues #100660 / #169566), so a "no symbols" answer for a document that plausibly has
 * a provider is retried with backoff: 100, 200, 400, 800, 1600 ms, never exceeding 5 s in total.
 * Pure so the schedule and the cap are unit tested with fake clocks.
 */
import type { CancelToken } from '../../core/interfaces';

export const READINESS_DELAYS_MS: readonly number[] = [100, 200, 400, 800, 1600];
export const READINESS_CAP_MS = 5000;

export interface ReadinessRetryOptions<T> {
  /** True when the answer is usable and no further attempt is needed. */
  isReady: (result: T) => boolean;
  /** When false only one attempt is made (language has no provider, trivial document, ...). */
  shouldRetry: boolean;
  delays?: readonly number[];
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  token?: CancelToken;
}

export interface ReadinessRetryResult<T> {
  result: T;
  attempts: number;
  elapsedMs: number;
  /** True when the loop stopped because of the cap, cancellation or exhausted delays without a ready answer. */
  gaveUp: boolean;
}

/**
 * Calls `attempt` until `isReady`, sleeping the backoff schedule between calls. The next sleep is
 * skipped when it would push the total past `capMs`. `attempt` receives the time still available so
 * it can size its own timeout.
 */
export async function withReadinessRetry<T>(
  attempt: (remainingMs: number) => Promise<T>,
  opts: ReadinessRetryOptions<T>,
): Promise<ReadinessRetryResult<T>> {
  const delays = opts.delays ?? READINESS_DELAYS_MS;
  const capMs = opts.capMs ?? READINESS_CAP_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();
  const remaining = (): number => Math.max(0, capMs - (now() - start));

  let attempts = 1;
  let result = await attempt(remaining());
  if (opts.isReady(result) || !opts.shouldRetry) {
    return { result, attempts, elapsedMs: now() - start, gaveUp: !opts.isReady(result) };
  }
  for (const delay of delays) {
    if (opts.token?.isCancellationRequested) break;
    // Leave at least a little time for the attempt itself after sleeping.
    if (now() - start + delay + 50 > capMs) break;
    await sleep(delay);
    if (opts.token?.isCancellationRequested) break;
    attempts++;
    result = await attempt(remaining());
    if (opts.isReady(result)) return { result, attempts, elapsedMs: now() - start, gaveUp: false };
    if (remaining() <= 0) break;
  }
  return { result, attempts, elapsedMs: now() - start, gaveUp: true };
}
