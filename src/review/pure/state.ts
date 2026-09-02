/**
 * Host-side state machine for one review (REQ-014). The webview is only a renderer: every decision
 * message it sends — and every call from the test hook — is validated here, so "Accept before the
 * explanation is visible" is refused on the host no matter what the UI does.
 * Pure and unit-tested; no `vscode` import.
 */
import type { AgentKind, ChangeExplanation, Decision, DecisionScope, GateRequest } from '../../core/types';
import { buildCards, trivialExplanationText, type CardModel } from './html';

export type ExplainStatus = 'pending' | 'streaming' | 'done' | 'error';
export type CardVerdict = 'accept' | 'reject';

export interface CardState {
  card: CardModel;
  explain: ExplainStatus;
  /** Partial streamed text, shown while the explanation is on its way. */
  text: string;
  explanation?: ChangeExplanation;
  error?: string;
  verdict?: CardVerdict;
  rejectReason?: string;
}

export interface ReviewState {
  requestId: string;
  agent: AgentKind;
  sessionId: string;
  paths: string[];
  warnings: string[];
  warningAcknowledged: boolean;
  allowSessionAccept: boolean;
  cards: CardState[];
  /** Index of the card being decided; equals cards.length once every card is decided. */
  current: number;
  scope: DecisionScope;
  /** Paths on which "Accept rest of file" was used (drives the final scope conservatively). */
  fileAcceptedPaths: string[];
  /** Set when the panel was closed (or the review cancelled) before every card was decided. */
  closedReason?: string;
}

export type ReviewAction =
  | { type: 'explainStart'; cardId: string }
  | { type: 'explainChunk'; cardId: string; chunk: string }
  | { type: 'explainDone'; cardId: string; explanation: ChangeExplanation }
  | { type: 'explainError'; cardId: string; reason: string }
  | { type: 'retry'; cardId: string }
  | { type: 'ackWarning'; value: boolean }
  | { type: 'accept'; cardId: string }
  | { type: 'reject'; cardId: string; reason: string }
  | { type: 'acceptFile'; cardId: string }
  | { type: 'acceptSession'; cardId: string }
  | { type: 'close'; reason?: string };

export type RefusalCode =
  | 'unknown-card'
  | 'not-current'
  | 'already-decided'
  | 'not-explained'
  | 'warning-not-acknowledged'
  | 'reason-required'
  | 'session-accept-disabled'
  | 'closed';

export interface ReduceResult {
  state: ReviewState;
  ok: boolean;
  /** Machine-readable refusal code when `ok` is false. */
  code?: RefusalCode;
  /** Plain-English refusal for the log and the UI. */
  error?: string;
}

export const CLOSED_WITHOUT_DECISION = 'Review closed without a decision';
/** Fail closed: a request that changes files but produced nothing reviewable is never accepted unseen. */
export const NOTHING_REVIEWABLE =
  'ExplainIT could not split this change into reviewable pieces, so it was not applied. Please make the change again with Write or Edit, in smaller steps.';

export function createInitialState(
  request: GateRequest,
  opts: { batchTrivial: boolean; allowSessionAccept: boolean },
): ReviewState {
  const cards = buildCards(request, { batchTrivial: opts.batchTrivial }).map<CardState>((card) => {
    if (card.selfExplained) {
      const t = trivialExplanationText(card.trivialItems ?? []);
      const explanation: ChangeExplanation = {
        functionName: card.title,
        whatChanged: t.whatChanged,
        whyItMatters: t.whyItMatters,
        modelChannel: 'none',
        createdAt: new Date().toISOString(),
      };
      return { card, explain: 'done', text: '', explanation };
    }
    return { card, explain: 'pending', text: '' };
  });
  const paths = [...new Set([...request.writes.map((w) => w.path), ...Object.keys(request.hunksByPath ?? {})])];
  // No cards but the writes really change something on disk: refuse rather than accept unseen.
  const realChange = request.writes.some((w) => w.kind !== 'modify' || (w.before ?? '') !== (w.after ?? ''));
  const closedReason = cards.length === 0 && realChange ? NOTHING_REVIEWABLE : undefined;
  return {
    requestId: request.id,
    agent: request.agent,
    sessionId: request.sessionId,
    paths,
    warnings: [...(request.warnings ?? [])],
    warningAcknowledged: false,
    allowSessionAccept: opts.allowSessionAccept,
    cards,
    current: 0,
    scope: 'one',
    fileAcceptedPaths: [],
    ...(closedReason ? { closedReason } : {}),
  };
}

const clone = (s: ReviewState): ReviewState => ({ ...s, cards: s.cards.map((c) => ({ ...c })) });

function refuse(state: ReviewState, code: RefusalCode, error: string): ReduceResult {
  return { state, ok: false, code, error };
}

/** Moves `current` forward to the first undecided card. */
function advance(s: ReviewState): void {
  let i = s.current;
  while (i < s.cards.length && s.cards[i].verdict) i++;
  s.current = i;
}

function checkDecidable(state: ReviewState, cardId: string, needExplained: boolean): ReduceResult | { idx: number } {
  if (state.closedReason) return refuse(state, 'closed', 'This review is already closed.');
  const idx = state.cards.findIndex((c) => c.card.id === cardId);
  if (idx < 0) return refuse(state, 'unknown-card', `No change card with id "${cardId}".`);
  const c = state.cards[idx];
  if (c.verdict) return refuse(state, 'already-decided', `"${c.card.title}" was already ${c.verdict}ed.`);
  if (idx !== state.current) return refuse(state, 'not-current', `Decide "${state.cards[state.current]?.card.title}" first; changes are reviewed in order.`);
  if (needExplained) {
    if (c.explain !== 'done') {
      return refuse(state, 'not-explained', 'Accept is not available until the plain-English explanation has finished. Wait for it, or press Retry if it failed.');
    }
    if (state.warnings.length > 0 && !state.warningAcknowledged) {
      return refuse(state, 'warning-not-acknowledged', 'Tick "I understand" under the warning before accepting this change.');
    }
  }
  return { idx };
}

export function reduce(prev: ReviewState, action: ReviewAction): ReduceResult {
  switch (action.type) {
    case 'explainStart': {
      const s = clone(prev);
      const c = s.cards.find((x) => x.card.id === action.cardId);
      if (!c) return refuse(prev, 'unknown-card', `No change card with id "${action.cardId}".`);
      if (c.explain === 'done') return { state: prev, ok: true };
      c.explain = 'streaming';
      c.text = '';
      c.error = undefined;
      return { state: s, ok: true };
    }
    case 'explainChunk': {
      const s = clone(prev);
      const c = s.cards.find((x) => x.card.id === action.cardId);
      if (!c) return refuse(prev, 'unknown-card', `No change card with id "${action.cardId}".`);
      if (c.explain === 'done' || c.explain === 'error') return { state: prev, ok: true };
      c.explain = 'streaming';
      c.text += action.chunk;
      return { state: s, ok: true };
    }
    case 'explainDone': {
      const s = clone(prev);
      const c = s.cards.find((x) => x.card.id === action.cardId);
      if (!c) return refuse(prev, 'unknown-card', `No change card with id "${action.cardId}".`);
      c.explain = 'done';
      c.explanation = action.explanation;
      c.error = undefined;
      return { state: s, ok: true };
    }
    case 'explainError': {
      const s = clone(prev);
      const c = s.cards.find((x) => x.card.id === action.cardId);
      if (!c) return refuse(prev, 'unknown-card', `No change card with id "${action.cardId}".`);
      if (c.explain === 'done') return { state: prev, ok: true };
      c.explain = 'error';
      c.error = action.reason || 'unknown error';
      return { state: s, ok: true };
    }
    case 'retry': {
      const s = clone(prev);
      const c = s.cards.find((x) => x.card.id === action.cardId);
      if (!c) return refuse(prev, 'unknown-card', `No change card with id "${action.cardId}".`);
      // Retry only makes sense after a failure; while pending/streaming a call is already on its way.
      if (c.explain !== 'error') return { state: prev, ok: true };
      c.explain = 'pending';
      c.text = '';
      c.error = undefined;
      return { state: s, ok: true };
    }
    case 'ackWarning': {
      if (prev.warningAcknowledged === !!action.value) return { state: prev, ok: true };
      return { state: { ...prev, warningAcknowledged: !!action.value }, ok: true };
    }
    case 'accept': {
      const r = checkDecidable(prev, action.cardId, true);
      if (!('idx' in r)) return r;
      const s = clone(prev);
      s.cards[r.idx].verdict = 'accept';
      advance(s);
      return { state: s, ok: true };
    }
    case 'reject': {
      const r = checkDecidable(prev, action.cardId, false);
      if (!('idx' in r)) return r;
      const reason = typeof action.reason === 'string' ? action.reason.trim() : '';
      if (!reason) return refuse(prev, 'reason-required', 'Please say why you are rejecting this change; the reason goes back to the assistant so it can revise.');
      const s = clone(prev);
      s.cards[r.idx].verdict = 'reject';
      // Sent back verbatim (only surrounding whitespace trimmed).
      s.cards[r.idx].rejectReason = reason;
      advance(s);
      return { state: s, ok: true };
    }
    case 'acceptFile': {
      const r = checkDecidable(prev, action.cardId, true);
      if (!('idx' in r)) return r;
      const s = clone(prev);
      const path = s.cards[r.idx].card.path;
      for (let i = r.idx; i < s.cards.length; i++) {
        if (!s.cards[i].verdict && s.cards[i].card.path === path) s.cards[i].verdict = 'accept';
      }
      if (!s.fileAcceptedPaths.includes(path)) s.fileAcceptedPaths = [...s.fileAcceptedPaths, path];
      if (s.scope === 'one') s.scope = 'file';
      advance(s);
      return { state: s, ok: true };
    }
    case 'acceptSession': {
      if (!prev.allowSessionAccept) {
        return refuse(prev, 'session-accept-disabled', '"Accept the rest of this session" is turned off in the ExplainIT settings (checkpoint.allowAcceptRestOfSession).');
      }
      const r = checkDecidable(prev, action.cardId, true);
      if (!('idx' in r)) return r;
      const s = clone(prev);
      for (let i = r.idx; i < s.cards.length; i++) if (!s.cards[i].verdict) s.cards[i].verdict = 'accept';
      s.scope = 'session';
      advance(s);
      return { state: s, ok: true };
    }
    case 'close': {
      if (prev.closedReason || isComplete(prev)) return { state: prev, ok: true };
      return { state: { ...prev, closedReason: action.reason || CLOSED_WITHOUT_DECISION }, ok: true };
    }
    default:
      return refuse(prev, 'unknown-card', 'Unknown action.');
  }
}

/** True once every card has a verdict, or the review was closed. */
export function isComplete(state: ReviewState): boolean {
  return !!state.closedReason || state.cards.every((c) => !!c.verdict);
}

export function currentCard(state: ReviewState): CardState | undefined {
  return state.cards[state.current];
}

/** Ids of cards that still need an explanation, in review order starting at the current card. */
export function explainQueue(state: ReviewState): string[] {
  if (state.closedReason) return [];
  const out: string[] = [];
  for (let i = state.current; i < state.cards.length; i++) {
    const c = state.cards[i];
    if (!c.verdict && !c.card.selfExplained && c.explain === 'pending') out.push(c.card.id);
  }
  return out;
}

/**
 * The scope the gate's decision memory may act on. `Decision.scope` cannot say *which* paths were
 * file-accepted, so `file` is only reported when "Accept rest of file" covered every path of the
 * request; otherwise the memory would loosen the checkpoint for files the person never chose.
 */
export function effectiveScope(state: ReviewState): DecisionScope {
  if (state.scope === 'session') return 'session';
  if (state.scope === 'file' && state.paths.length > 0 && state.paths.every((p) => state.fileAcceptedPaths.includes(p))) return 'file';
  return 'one';
}

/** Aggregates per-card verdicts into the gate's Decision. Only meaningful once `isComplete`. */
export function finalize(state: ReviewState, now: () => string = () => new Date().toISOString()): Decision {
  if (state.closedReason) {
    return { requestId: state.requestId, verdict: 'reject', reason: state.closedReason, scope: 'one', decidedAt: now() };
  }
  const scope = effectiveScope(state);
  const hunkVerdicts: Record<string, CardVerdict> = {};
  const rejected: CardState[] = [];
  let accepted = 0;
  for (const c of state.cards) {
    const v = c.verdict ?? 'reject';
    for (const h of c.card.hunkIds) hunkVerdicts[h] = v;
    if (v === 'accept') accepted++;
    else rejected.push(c);
  }
  const reason = rejectReasonText(rejected);
  if (rejected.length === 0) {
    return { requestId: state.requestId, verdict: 'accept', scope, decidedAt: now(), hunkVerdicts };
  }
  if (accepted > 0) {
    return { requestId: state.requestId, verdict: 'partial', reason, scope, decidedAt: now(), hunkVerdicts };
  }
  return { requestId: state.requestId, verdict: 'reject', reason, scope, decidedAt: now(), hunkVerdicts };
}

/** One rejection: the person's words verbatim. Several: one line each, prefixed with the function name. */
export function rejectReasonText(rejected: CardState[]): string | undefined {
  if (rejected.length === 0) return undefined;
  if (rejected.length === 1) return rejected[0].rejectReason ?? CLOSED_WITHOUT_DECISION;
  return rejected
    .map((c) => `${c.card.functionName ?? c.card.title}: ${c.rejectReason ?? CLOSED_WITHOUT_DECISION}`)
    .join('\n');
}

/** Plain, serialisable snapshot for the test hook. */
export function snapshot(state: ReviewState): {
  requestId: string;
  hunkIndex: number;
  explained: boolean;
  cards: { id: string; title: string; explain: ExplainStatus; verdict?: CardVerdict; path: string; hunkIds: string[] }[];
  scope: DecisionScope;
  complete: boolean;
} {
  const cur = currentCard(state);
  return {
    requestId: state.requestId,
    hunkIndex: state.current,
    explained: !!cur && cur.explain === 'done',
    cards: state.cards.map((c) => ({ id: c.card.id, title: c.card.title, explain: c.explain, verdict: c.verdict, path: c.card.path, hunkIds: c.card.hunkIds })),
    scope: effectiveScope(state),
    complete: isComplete(state),
  };
}
