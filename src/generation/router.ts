/**
 * Generation router (REQ-005..009). Pure orchestration, no `vscode` import.
 *
 *  explainFunctions  cache-first (cached hashes never reach a model) -> chunks of <= 20 functions ->
 *                    channel order = pin -> availability -> fallback on ChannelError -> parse +
 *                    validate -> one re-ask per file -> fallback explanation that still renders.
 *  explainChange     "what changed / why it matters" for one function, streamed via onText.
 *  segmentWithAi     last-resort function outline for languages nothing else can parse.
 *  availableChannels fast (< 3 s), cached 60 s, never shows a dialog.
 */
import type {
  AiSegment,
  CancelToken,
  ChangeExplainRequest,
  ConsentStore,
  CoreDeps,
  Disposable,
  ExplainFunctionInput,
  ExplainProgress,
  ExplainRequest,
  ExplanationCache,
  GenerationOptions,
  GenerationRouter,
} from '../core/interfaces';
import type { ChangeExplanation, Channel, ChannelAvailability, CostEstimate, Explanation } from '../core/types';
import { withTimeout } from '../core/cancel';
import { CHANNEL_ORDER, isCancelled, isChannelError, type ChannelRequest, type GenerationChannel } from './channels/types';
import { estimateCost as estimateCostPure } from './pure/cost';
import { fallbackExplanation, matchItemsToFunctions, parseChangeReply, parseExplanationsReply, parseSegmentsReply, toExplanation, type MatchedItem } from './pure/parse';
import { MAX_FUNCTIONS_PER_REQUEST, REASK_PREFACE, buildChangePrompt, buildExplainPrompt, buildReaskPrompt, buildSegmentPrompt, promptHash, type PromptParts } from './pure/prompts';
import { normalizeNewlines } from '../core/hash';

export interface RouterDeps extends CoreDeps {
  cache: ExplanationCache;
  consent: ConsentStore;
  disposables: Disposable[];
  /** The channels, in no particular order (tests inject fakes). */
  channels: GenerationChannel[];
  now?: () => Date;
  /** How long an availability answer is trusted (default 60 s). */
  availabilityTtlMs?: number;
  /** Per-channel cap for availability probes (default 2.8 s so the whole call stays under 3 s). */
  availabilityProbeMs?: number;
}

export const AVAILABILITY_TTL_MS = 60_000;
export const AVAILABILITY_PROBE_MS = 2_800;
/** Grace added on top of the channel's own timeout before the router gives up on it. */
const ROUTER_TIMEOUT_GRACE_MS = 5_000;

export const CONSENT_ERROR =
  'ExplainIT does not have permission to use your assistants yet. Run "ExplainIT: Set up assistants" to grant it (code goes only to the assistants you already use, under your existing agreements).';
export const NO_CHANNEL_ERROR =
  'No assistant is connected. Sign in to GitHub Copilot, install Claude Code or Codex (the CLI or the VS Code extension), then run "ExplainIT: Set up assistants".';

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function cancelledError(): Error {
  return new Error('Cancelled.');
}

interface AvailabilityCacheEntry {
  ts: number;
  result: ChannelAvailability;
  inflight?: Promise<ChannelAvailability>;
}

export function createRouter(deps: RouterDeps): GenerationRouter {
  const log = deps.logger.child('generation');
  const now = deps.now ?? (() => new Date());
  const ttl = deps.availabilityTtlMs ?? AVAILABILITY_TTL_MS;
  const probeMs = deps.availabilityProbeMs ?? AVAILABILITY_PROBE_MS;
  const byId = new Map<Channel, GenerationChannel>(deps.channels.map((c) => [c.id, c]));
  const availability = new Map<Channel, AvailabilityCacheEntry>();
  let lastResolved: Channel | 'none' = 'none';

  // Changing a CLI path or the pin invalidates the cached availability (pushed to disposables).
  deps.disposables.push(
    deps.settings.onDidChange((keys) => {
      if (keys.some((k) => k === 'claudeCliPath' || k === 'codexCliPath' || k === 'channelPin')) availability.clear();
    }),
  );

  const timeoutMs = (opts?: GenerationOptions): number => {
    const s = Number(deps.settings.get('generationTimeoutSeconds'));
    const fromSettings = Number.isFinite(s) && s > 0 ? s * 1000 : 90_000;
    return opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : fromSettings;
  };

  const chunkSize = (): number => {
    const v = Number(deps.settings.get('backfillMaxFunctionsPerRequest'));
    if (!Number.isFinite(v) || v < 1) return MAX_FUNCTIONS_PER_REQUEST;
    return Math.min(MAX_FUNCTIONS_PER_REQUEST, Math.floor(v));
  };

  const probe = (ch: GenerationChannel): Promise<ChannelAvailability> => {
    const cached = availability.get(ch.id);
    const fresh = cached && Date.now() - cached.ts < ttl;
    if (cached?.inflight) return raceProbe(ch, cached.inflight);
    if (fresh) return Promise.resolve(cached!.result);
    const inflight = ch
      .availability()
      .catch((e): ChannelAvailability => ({ channel: ch.id, available: false, reason: 'The availability check failed.', detail: (e as Error).message }))
      .then((result) => {
        availability.set(ch.id, { ts: Date.now(), result });
        return result;
      });
    availability.set(ch.id, { ts: Date.now(), result: cached?.result ?? { channel: ch.id, available: false, reason: 'Still checking…' }, inflight });
    return raceProbe(ch, inflight);
  };

  /** Never wait longer than probeMs; a slow probe keeps running and fills the cache for next time. */
  const raceProbe = (ch: GenerationChannel, inflight: Promise<ChannelAvailability>): Promise<ChannelAvailability> =>
    withTimeout(inflight, probeMs, `${ch.id} availability`).catch(
      (): ChannelAvailability => ({ channel: ch.id, available: false, reason: `Still checking whether ${ch.id} is ready (it took longer than ${Math.round(probeMs / 1000)} seconds). Try again in a moment.` }),
    );

  const availableChannels = async (): Promise<ChannelAvailability[]> => {
    const ordered = CHANNEL_ORDER.map((id) => byId.get(id)).filter((c): c is GenerationChannel => !!c);
    const results = await Promise.all(ordered.map(probe));
    const avail = results.filter((r) => r.available).map((r) => r.channel);
    const pin = deps.settings.get('channelPin');
    lastResolved = pin !== 'auto' && avail.includes(pin) ? pin : (avail[0] ?? 'none');
    return results;
  };

  /** Channels to try, in order: forced -> pin first -> availability order. */
  const orderedChannels = async (forced?: Channel): Promise<GenerationChannel[]> => {
    if (forced) {
      const c = byId.get(forced);
      if (!c) throw new Error(`Unknown assistant "${forced}".`);
      return [c];
    }
    const results = await availableChannels();
    const avail = results.filter((r) => r.available).map((r) => r.channel);
    const pin = deps.settings.get('channelPin');
    const order: Channel[] = [];
    if (pin !== 'auto') order.push(pin);
    for (const id of CHANNEL_ORDER) if (!order.includes(id) && avail.includes(id)) order.push(id);
    const chans = order.map((id) => byId.get(id)).filter((c): c is GenerationChannel => !!c);
    if (!chans.length) {
      const why = results.map((r) => `${r.channel}: ${r.reason ?? 'not available'}`).join('; ');
      throw new Error(`${NO_CHANNEL_ERROR} (${why})`);
    }
    return chans;
  };

  const requireConsent = (): void => {
    if (!deps.consent.granted()) throw new Error(CONSENT_ERROR);
  };

  const send = async (ch: GenerationChannel, parts: PromptParts, opts: GenerationOptions | undefined, progress: ExplainProgress | undefined, stream: boolean): Promise<string> => {
    const ms = timeoutMs(opts);
    const req: ChannelRequest = {
      system: parts.system,
      user: parts.user,
      combined: parts.combined,
      timeoutMs: ms,
      token: opts?.token,
      onText: stream && progress?.onText ? (c) => progress.onText?.(c) : undefined,
      onStatus: progress?.onStatus ? (m) => progress.onStatus?.(m) : undefined,
    };
    const res = await withTimeout(ch.send(req), ms + ROUTER_TIMEOUT_GRACE_MS, `${ch.id} request`, opts?.token);
    log.debug('reply received', { channel: ch.id, chars: res.text.length, detail: res.detail });
    return res.text;
  };

  /**
   * Try the channels in order for one operation. ChannelErrors fall through to the next channel;
   * cancellation and non-channel errors propagate.
   */
  const withChannels = async <T>(channels: GenerationChannel[], what: string, token: CancelToken | undefined, fn: (ch: GenerationChannel) => Promise<T>): Promise<T> => {
    let last: Error | undefined;
    for (const ch of channels) {
      if (isCancelled(token)) throw cancelledError();
      try {
        log.info(`using ${ch.id} for ${what}`);
        return await fn(ch);
      } catch (e) {
        if (isCancelled(token)) throw cancelledError();
        if (isChannelError(e)) {
          if (e.reason === 'cancelled') throw cancelledError();
          last = e;
          log.warn(`${ch.id} could not answer (${e.reason}); trying the next assistant`, { message: e.message });
          continue;
        }
        throw e;
      }
    }
    throw new Error(`No assistant could ${what}. ${last?.message ?? NO_CHANNEL_ERROR}`);
  };

  // -------------------------------------------------------------------------------------------
  // explainFunctions
  // -------------------------------------------------------------------------------------------

  const explainFunctions = async (req: ExplainRequest, opts?: GenerationOptions): Promise<Explanation[]> => {
    const progress = opts?.progress;
    const results = new Map<string, Explanation>();
    const misses: ExplainFunctionInput[] = [];
    for (const fn of req.functions) {
      const hit = deps.cache.get(fn.contentHash);
      if (hit) {
        // The cached copy may come from another file or an older id: re-label, keep the words.
        const e: Explanation = { ...hit, functionId: fn.functionId, name: fn.name, contentHash: fn.contentHash };
        results.set(fn.functionId, e);
        progress?.onExplanation?.(e);
      } else {
        misses.push(fn);
      }
    }
    if (misses.length) {
      log.debug('cache', { file: req.fileName, hits: req.functions.length - misses.length, misses: misses.length });
      requireConsent();
      if (isCancelled(opts?.token)) throw cancelledError();
      const channels = await orderedChannels(opts?.channel);
      const thrift = deps.settings.get('tokenThrift') !== false;
      let reaskBudget = 1; // one re-ask per file
      for (const group of chunk(misses, chunkSize())) {
        if (isCancelled(opts?.token)) throw cancelledError();
        const subReq: ExplainRequest = { ...req, functions: group };
        const explained = await withChannels(channels, `explain ${req.fileName}`, opts?.token, async (ch) => {
          progress?.onStatus?.(`Explaining ${group.length} function${group.length === 1 ? '' : 's'} of ${req.fileName} with ${ch.id}…`);
          const text = await send(ch, buildExplainPrompt(subReq, { channel: ch.id, thrift }), opts, progress, true);
          let matched = matchItemsToFunctions(parseExplanationsReply(text).items, group);
          const bad = matched.filter((m) => m.errors.length);
          if (bad.length && reaskBudget > 0) {
            reaskBudget--;
            log.warn(`reply for ${req.fileName} had ${bad.length} unusable item(s); re-asking once`, { errors: bad.map((m) => `${m.fn.name}: ${m.errors.join(', ')}`) });
            progress?.onStatus?.('The answer was not clear enough; asking once more…');
            const badFns = bad.map((m) => m.fn);
            const text2 = await send(ch, buildReaskPrompt({ ...subReq, functions: badFns }, { channel: ch.id, thrift }), opts, progress, true);
            const again = matchItemsToFunctions(parseExplanationsReply(text2).items, badFns);
            const byId2 = new Map(again.map((m) => [m.fn.functionId, m]));
            matched = matched.map((m): MatchedItem => (m.errors.length && byId2.has(m.fn.functionId) ? byId2.get(m.fn.functionId)! : m));
          }
          return matched.map((m) => {
            if (m.errors.length || !m.item) {
              log.warn(`no clear explanation for ${m.fn.name} in ${req.fileName}; using the fallback text`, { errors: m.errors });
              return { explanation: fallbackExplanation(m.fn, ch.id, now()), valid: false };
            }
            return { explanation: toExplanation(m.fn, m.item, ch.id, now()), valid: true };
          });
        });
        for (const { explanation, valid } of explained) {
          results.set(explanation.functionId, explanation);
          if (valid) deps.cache.set(explanation.contentHash, explanation);
          progress?.onExplanation?.(explanation);
        }
      }
    }
    return req.functions.map((fn) => results.get(fn.functionId)!).filter(Boolean);
  };

  // -------------------------------------------------------------------------------------------
  // explainChange
  // -------------------------------------------------------------------------------------------

  const explainChange = async (req: ChangeExplainRequest, opts?: GenerationOptions): Promise<ChangeExplanation> => {
    requireConsent();
    const channels = await orderedChannels(opts?.channel);
    const progress = opts?.progress;
    return withChannels(channels, `explain the change to ${req.functionName}`, opts?.token, async (ch) => {
      const parts = buildChangePrompt(req, { channel: ch.id });
      let parsed = parseChangeReply(await send(ch, parts, opts, progress, true));
      if (!parsed.value) {
        log.warn(`change explanation for ${req.functionName} was unusable; re-asking once`, { errors: parsed.errors });
        const reask: PromptParts = { ...parts, user: `${REASK_PREFACE}\n\n${parts.user}`, combined: `${parts.system}\n\n${REASK_PREFACE}\n\n${parts.user}` };
        parsed = parseChangeReply(await send(ch, reask, opts, progress, true));
      }
      if (!parsed.value) {
        log.warn(`change explanation for ${req.functionName} still unusable; using the fallback text`, { errors: parsed.errors });
        return {
          functionName: req.functionName,
          whatChanged: `The function ${req.functionName} is being ${req.changeType === 'added' ? 'added' : req.changeType === 'removed' ? 'removed' : 'changed'}, but the assistant could not describe the change clearly.`,
          whyItMatters: ['Read the before and after text carefully before you accept.', 'You can reject with a reason and ask the assistant to explain what it is doing.'],
          risk: 'This note was not written by an assistant.',
          modelChannel: ch.id,
          createdAt: now().toISOString(),
        };
      }
      const v = parsed.value;
      const out: ChangeExplanation = { functionName: req.functionName, whatChanged: v.whatChanged, whyItMatters: v.whyItMatters, modelChannel: ch.id, createdAt: now().toISOString() };
      if (v.risk) out.risk = v.risk;
      return out;
    });
  };

  // -------------------------------------------------------------------------------------------
  // segmentWithAi
  // -------------------------------------------------------------------------------------------

  const segmentWithAi = async (req: { fileName: string; languageId: string; text: string }, opts?: GenerationOptions): Promise<AiSegment[]> => {
    requireConsent();
    const channels = await orderedChannels(opts?.channel);
    const lineCount = normalizeNewlines(req.text).split('\n').length;
    return withChannels(channels, `outline ${req.fileName}`, opts?.token, async (ch) => {
      const parts = buildSegmentPrompt(req, { channel: ch.id });
      let parsed = parseSegmentsReply(await send(ch, parts, opts, opts?.progress, false), lineCount);
      if (parsed.errors.length) {
        log.warn(`outline for ${req.fileName} was unusable; re-asking once`, { errors: parsed.errors });
        const reask: PromptParts = { ...parts, user: `${REASK_PREFACE}\n\n${parts.user}`, combined: `${parts.system}\n\n${REASK_PREFACE}\n\n${parts.user}` };
        parsed = parseSegmentsReply(await send(ch, reask, opts, opts?.progress, false), lineCount);
      }
      if (parsed.errors.length) throw new Error(`The assistant could not outline ${req.fileName} (${parsed.errors.join('; ')}). Run "ExplainIT: Regenerate the whole twin for this file" to try again.`);
      return parsed.segments;
    });
  };

  // -------------------------------------------------------------------------------------------
  // small pure bits
  // -------------------------------------------------------------------------------------------

  const estimateCost = (reqs: ExplainRequest[]): CostEstimate => {
    const pin = deps.settings.get('channelPin');
    const channel: Channel | 'none' = pin !== 'auto' ? pin : lastResolved;
    return estimateCostPure(reqs, channel, chunkSize(), deps.settings.get('tokenThrift') !== false);
  };

  const resolveChannel = async (): Promise<Channel | 'none'> => {
    await availableChannels();
    return lastResolved;
  };

  return { explainFunctions, explainChange, segmentWithAi, availableChannels, estimateCost, resolveChannel, promptHash };
}
