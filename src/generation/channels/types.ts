/**
 * The seam between the router and the three channels. No `vscode` import here.
 */
import type { CancelToken } from '../../core/interfaces';
import type { Channel, ChannelAvailability } from '../../core/types';

export type ChannelFailure =
  | 'unavailable' // binary / model not found
  | 'auth' // not signed in, no permission
  | 'blocked' // the provider refused the request (content policy, org policy)
  | 'quota' // rate limit / credits exhausted
  | 'timeout'
  | 'bad-output' // the process answered with nothing usable
  | 'cancelled'
  | 'failed'; // anything else

/**
 * Thrown by a channel when the request could not be served. The router falls back to the next
 * channel on any ChannelError except `cancelled`. `retryable` is only about the single jittered
 * retry inside a channel (spawn error / timeout), never about cross-channel fallback.
 */
export class ChannelError extends Error {
  readonly channel: Channel;
  readonly reason: ChannelFailure;
  readonly retryable: boolean;
  constructor(channel: Channel, reason: ChannelFailure, message: string, retryable = false) {
    super(message);
    this.name = 'ChannelError';
    this.channel = channel;
    this.reason = reason;
    this.retryable = retryable;
  }
}

export function isChannelError(e: unknown): e is ChannelError {
  return e instanceof ChannelError || (!!e && typeof e === 'object' && (e as { name?: string }).name === 'ChannelError');
}

export interface ChannelRequest {
  /** System-style preamble (Copilot keeps it separate; the CLIs get `combined`). */
  system: string;
  user: string;
  combined: string;
  timeoutMs: number;
  token?: CancelToken;
  /** Streamed text chunks (enables the streaming variants). */
  onText?: (chunk: string) => void;
  onStatus?: (msg: string) => void;
}

export interface ChannelResult {
  text: string;
  /** Free-form detail for logs (model name, duration). Never contains the prompt or tokens. */
  detail?: string;
}

export interface GenerationChannel {
  readonly id: Channel;
  /** Fast (< 3 s) and silent: never a dialog, never a consent prompt. */
  availability(): Promise<ChannelAvailability>;
  send(req: ChannelRequest): Promise<ChannelResult>;
}

/** Order used when no channel is pinned. */
export const CHANNEL_ORDER: readonly Channel[] = ['copilot', 'claude', 'codex'];

export function isCancelled(token: CancelToken | undefined): boolean {
  return !!token && token.isCancellationRequested;
}
