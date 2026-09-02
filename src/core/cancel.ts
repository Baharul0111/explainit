import type { CancelToken, Disposable } from './interfaces';

/** A tiny cancellation source usable without vscode. */
export class CancelSource {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();
  readonly token: CancelToken = {
    get isCancellationRequested() {
      return (this as any)._src.cancelled;
    },
    onCancellationRequested: (cb: () => void): Disposable => {
      this.listeners.add(cb);
      return { dispose: () => this.listeners.delete(cb) };
    },
  } as CancelToken;
  constructor() {
    (this.token as any)._src = this;
  }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const l of this.listeners) l();
  }
}

export const NEVER_CANCEL: CancelToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
};

/** Race a promise against a timeout and a cancel token. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string, token?: CancelToken): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    const d = token?.onCancellationRequested(() => {
      clearTimeout(t);
      reject(new Error(`${what} cancelled`));
    });
    p.then(
      (v) => {
        clearTimeout(t);
        d?.dispose();
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        d?.dispose();
        reject(e);
      },
    );
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Jittered delay for the single retry policy: base * (0.5..1.5). */
export function jitter(baseMs: number): number {
  return Math.round(baseMs * (0.5 + Math.random()));
}
