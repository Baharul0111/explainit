/**
 * Copilot channel through `vscode.lm` (REQ-006).
 *
 * `vscode` is required lazily inside try/catch so this module loads in plain Node (unit tests, eval
 * harness) and simply reports "unavailable" there. `selectChatModels` is never called before the
 * person has granted consent; the official consent dialog appears on the first `sendRequest`, which
 * only ever happens from a user-initiated flow. LanguageModelError codes (NoPermissions, Blocked,
 * NotFound) and quota-like messages become a typed ChannelError so the router falls back.
 */
import type * as vscodeTypes from 'vscode';
import type { ConsentStore, Disposable } from '../../core/interfaces';
import type { Logger } from '../../core/log';
import type { Settings } from '../../core/settings';
import type { ChannelAvailability } from '../../core/types';
import { withTimeout } from '../../core/cancel';
import { ChannelError, isCancelled, type ChannelFailure, type ChannelRequest, type ChannelResult, type GenerationChannel } from './types';

type VscodeApi = typeof vscodeTypes;

export interface LmChannelDeps {
  logger: Logger;
  settings: Settings;
  consent: ConsentStore;
  disposables: Disposable[];
  /** Test hook: supply a fake vscode API (or undefined to simulate plain Node). */
  loadVscode?: () => VscodeApi | undefined;
}

export const AVAILABILITY_TIMEOUT_MS = 2500;
export const PREFERRED_FAMILIES: readonly string[] = ['gpt-4.1', 'gpt-4o', 'claude'];

function defaultLoadVscode(): VscodeApi | undefined {
  try {
    return require('vscode') as VscodeApi;
  } catch {
    return undefined;
  }
}

/** Prefer a family containing gpt-4.1, then gpt-4o, then claude; else the first model. */
export function pickModel<T extends { family: string }>(models: T[]): T | undefined {
  if (!models.length) return undefined;
  for (const pref of PREFERRED_FAMILIES) {
    const m = models.find((x) => (x.family ?? '').toLowerCase().includes(pref));
    if (m) return m;
  }
  return models[0];
}

export function classifyLmError(e: unknown, vscode: VscodeApi | undefined): { reason: ChannelFailure; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown })?.code;
  const isLmError = !!vscode?.LanguageModelError && e instanceof vscode.LanguageModelError;
  const codeStr = typeof code === 'string' ? code : '';
  if (isLmError || codeStr) {
    if (codeStr === 'NoPermissions') return { reason: 'auth', message: 'You have not allowed ExplainIT to use Copilot models yet. Run "ExplainIT: Set up assistants" and allow access when VS Code asks.' };
    if (codeStr === 'Blocked') return { reason: 'blocked', message: `Copilot refused this request${msg ? ` (${msg})` : ''}. ExplainIT will use another assistant if one is connected.` };
    if (codeStr === 'NotFound') return { reason: 'unavailable', message: 'The Copilot model is no longer available. Sign in to GitHub Copilot in VS Code, or pick another assistant.' };
  }
  if (/quota|rate.?limit|limit reached|too many requests|exhausted|premium requests|429|out of credits|exceeded/i.test(msg)) {
    return { reason: 'quota', message: `Copilot reported a usage limit (${msg.slice(0, 160)}). Wait for it to reset or pick another assistant in the ExplainIT settings.` };
  }
  if (/cancel/i.test(msg)) return { reason: 'cancelled', message: 'Cancelled.' };
  return { reason: 'failed', message: `Copilot could not answer (${msg.slice(0, 200)}). Run "ExplainIT: Doctor" for details.` };
}

export function createLmChannel(deps: LmChannelDeps): GenerationChannel {
  const log = deps.logger.child('copilot');
  const load = deps.loadVscode ?? defaultLoadVscode;

  const selectModels = async (vscode: VscodeApi, timeoutMs: number): Promise<vscodeTypes.LanguageModelChat[]> => {
    const models = await withTimeout(Promise.resolve(vscode.lm.selectChatModels({ vendor: 'copilot' })), timeoutMs, 'Looking for Copilot models');
    return models ?? [];
  };

  return {
    id: 'copilot',
    async availability(): Promise<ChannelAvailability> {
      const vscode = load();
      if (!vscode) return { channel: 'copilot', available: false, reason: 'Copilot models are only reachable inside VS Code.' };
      if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
        return { channel: 'copilot', available: false, reason: 'This VS Code version has no language model API. Update VS Code to 1.100 or newer.' };
      }
      if (!deps.consent.granted()) {
        return { channel: 'copilot', available: false, reason: 'ExplainIT has not been given permission to use your assistants yet. Run "ExplainIT: Set up assistants".' };
      }
      try {
        const models = await selectModels(vscode, AVAILABILITY_TIMEOUT_MS);
        if (!models.length) return { channel: 'copilot', available: false, reason: 'No Copilot models are available. Sign in to GitHub Copilot in VS Code, then try again.' };
        const pick = pickModel(models);
        return { channel: 'copilot', available: true, detail: `${models.length} model(s); will use ${pick?.family ?? pick?.name ?? 'the first one'}` };
      } catch (e) {
        return { channel: 'copilot', available: false, reason: 'Copilot did not answer in time.', detail: (e as Error).message };
      }
    },
    async send(req: ChannelRequest): Promise<ChannelResult> {
      const vscode = load();
      if (!vscode || !vscode.lm) throw new ChannelError('copilot', 'unavailable', 'Copilot models are only reachable inside VS Code.');
      if (!deps.consent.granted()) throw new ChannelError('copilot', 'auth', 'ExplainIT has not been given permission to use your assistants yet. Run "ExplainIT: Set up assistants".');
      let models: vscodeTypes.LanguageModelChat[];
      try {
        models = await selectModels(vscode, Math.min(req.timeoutMs, 10_000));
      } catch (e) {
        throw new ChannelError('copilot', 'unavailable', `Could not list Copilot models (${(e as Error).message}).`);
      }
      const model = pickModel(models);
      if (!model) throw new ChannelError('copilot', 'unavailable', 'No Copilot models are available. Sign in to GitHub Copilot in VS Code, then try again.');
      req.onStatus?.(`Asking Copilot (${model.family})…`);

      const cts = new vscode.CancellationTokenSource();
      deps.disposables.push(cts);
      const sub = req.token?.onCancellationRequested(() => cts.cancel());
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        cts.cancel();
      }, req.timeoutMs);
      const started = Date.now();
      try {
        const messages = [vscode.LanguageModelChatMessage.User(req.combined)];
        const response = await model.sendRequest(messages, {}, cts.token);
        let text = '';
        for await (const chunk of response.text) {
          text += chunk;
          try {
            req.onText?.(chunk);
          } catch {
            /* progress callbacks must never break the request */
          }
        }
        if (!text.trim()) throw new ChannelError('copilot', 'bad-output', 'Copilot answered with an empty reply. Try again, or pick another assistant in the ExplainIT settings.');
        log.debug('copilot ok', { family: model.family, ms: Date.now() - started, chars: text.length });
        return { text, detail: `copilot ${model.family} ${Date.now() - started}ms` };
      } catch (e) {
        if (e instanceof ChannelError) throw e;
        if (timedOut) throw new ChannelError('copilot', 'timeout', `Copilot did not answer within ${Math.round(req.timeoutMs / 1000)} seconds.`, true);
        if (isCancelled(req.token)) throw new ChannelError('copilot', 'cancelled', 'Cancelled.');
        const c = classifyLmError(e, vscode);
        log.warn('copilot failed', { reason: c.reason, family: model.family });
        throw new ChannelError('copilot', c.reason, c.message);
      } finally {
        clearTimeout(timer);
        sub?.dispose();
        cts.dispose();
        const i = deps.disposables.indexOf(cts);
        if (i >= 0) deps.disposables.splice(i, 1);
      }
    },
  };
}
