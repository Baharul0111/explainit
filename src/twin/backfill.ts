/**
 * Backfill the whole project (REQ-011, goal item 5): scan -> estimate -> explicit confirm -> run with
 * progress; pause after the current request, persist the done list, resume later, cancel clears.
 * Files whose twin is already fresh are skipped; at most 20 functions travel per request.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CancelSource } from '../core/cancel';
import type { BackfillController, BackfillStatus, CoreDeps, Disposable, ExplainRequest, GenerationRouter } from '../core/interfaces';
import { ensureDir, HOME_LAYOUT, isInside } from '../core/paths';
import type { CostEstimate } from '../core/types';
import { createBackfillRecord, describeEstimate, isComplete, markFileDone, parseBackfillRecord, remainingFiles, serializeBackfillRecord, statusFromRecords, type BackfillFileEntry, type BackfillRecord } from './pure/backfillState';
import { isCodeFilePath, MAX_TWIN_SOURCE_BYTES } from './pure/languages';
import { isTwinPath } from './pure/naming';
import { askModal, errorMessage, notice } from './prompt';
import type { TwinEngineImpl } from './engine';

export interface BackfillDeps extends CoreDeps {
  router: GenerationRouter;
  workspaceFolders: () => string[];
  disposables: Disposable[];
}

export const CONFIRM_START = 'Start backfill';

export function createBackfillController(engine: TwinEngineImpl, deps: BackfillDeps): BackfillController {
  const log = deps.logger.child('twin:backfill');
  const emitter = new vscode.EventEmitter<BackfillStatus>();
  deps.disposables.push(emitter);

  let state: BackfillStatus['state'] = 'idle';
  let records: BackfillRecord[] = [];
  let currentFile: string | undefined;
  let error: string | undefined;
  let estimate: CostEstimate | undefined;
  let pauseRequested = false;
  let cancelSource: CancelSource | undefined;
  let running: Promise<void> | undefined;

  const status = (): BackfillStatus => statusFromRecords(state, records, { currentFile, error, estimate });
  const emit = (): void => emitter.fire(status());
  const setState = (s: BackfillStatus['state']): void => {
    state = s;
    emit();
  };

  // ---------------------------------------------------------------- persistence

  const recordFile = (folder: string): string => HOME_LAYOUT.backfill(folder);
  const persist = async (r: BackfillRecord): Promise<void> => {
    ensureDir(path.dirname(recordFile(r.folder)));
    await fs.promises.writeFile(recordFile(r.folder), serializeBackfillRecord(r), 'utf8');
  };
  const clearPersisted = async (): Promise<void> => {
    for (const f of deps.workspaceFolders()) await fs.promises.unlink(recordFile(f)).catch(() => undefined);
    records = [];
  };
  const loadPersisted = async (): Promise<BackfillRecord[]> => {
    const out: BackfillRecord[] = [];
    for (const f of deps.workspaceFolders()) {
      try {
        const r = parseBackfillRecord(await fs.promises.readFile(recordFile(f), 'utf8'));
        if (r && !isComplete(r)) out.push(r);
      } catch {
        /* none */
      }
    }
    return out;
  };

  // ---------------------------------------------------------------- scanning

  const excludeGlob = (): string | undefined => {
    const globs = deps.settings.get('backfillExcludeGlobs').filter((g) => g && g.trim());
    return globs.length ? `{${globs.join(',')}}` : undefined;
  };

  interface Scan {
    entriesByFolder: Map<string, BackfillFileEntry[]>;
    requests: ExplainRequest[];
    scanned: number;
    skippedFresh: number;
  }

  const scan = async (folders: string[], token: vscode.CancellationToken, report: (msg: string) => void): Promise<Scan> => {
    const uris = await vscode.workspace.findFiles('**/*', excludeGlob(), undefined, token);
    const candidates = uris.map((u) => u.fsPath).filter((p) => isCodeFilePath(p) && !isTwinPath(p)).sort();
    const entriesByFolder = new Map<string, BackfillFileEntry[]>();
    const requests: ExplainRequest[] = [];
    let skippedFresh = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (token.isCancellationRequested) break;
      const p = candidates[i];
      report(`scanning file ${i + 1} of ${candidates.length}`);
      try {
        const st = await fs.promises.stat(p);
        if (!st.isFile() || st.size > MAX_TWIN_SOURCE_BYTES) continue;
        const analysis = await engine.analyze(p);
        if (!analysis) continue;
        if (analysis.fresh) {
          skippedFresh++;
          continue;
        }
        const folder = folders.find((f) => isInside(f, p)) ?? folders[0];
        const list = entriesByFolder.get(folder) ?? [];
        list.push({ path: analysis.sourcePath, functions: analysis.plan.toGenerate.length });
        entriesByFolder.set(folder, list);
        if (analysis.request.functions.length) requests.push(analysis.request);
      } catch (e) {
        log.warn(`skipping ${p}: ${errorMessage(e)}`);
      }
    }
    return { entriesByFolder, requests, scanned: candidates.length, skippedFresh };
  };

  // ---------------------------------------------------------------- running

  const run = async (): Promise<void> => {
    pauseRequested = false;
    error = undefined;
    cancelSource = new CancelSource();
    const token = cancelSource.token;
    const total = records.reduce((n, r) => n + r.files.length, 0);
    const maxPerRequest = deps.settings.get('backfillMaxFunctionsPerRequest');
    setState('running');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'ExplainIT: backfilling plain-English twins', cancellable: true }, async (progress, vsToken) => {
      const sub = vsToken.onCancellationRequested(() => cancel());
      try {
        let done = records.reduce((n, r) => n + r.done.length, 0);
        for (let ri = 0; ri < records.length; ri++) {
          for (const entry of remainingFiles(records[ri])) {
            if (token.isCancellationRequested) return;
            if (pauseRequested) return;
            currentFile = entry.path;
            progress.report({ message: `file ${done + 1} of ${total} (${entry.functions} function${entry.functions === 1 ? '' : 's'})` });
            emit();
            let res;
            try {
              res = await engine.refreshFromDisk(entry.path, { token, maxPerRequest, shouldStop: () => pauseRequested || token.isCancellationRequested });
            } catch (e) {
              if (token.isCancellationRequested) return;
              error = `Backfill stopped at ${path.basename(entry.path)}: ${errorMessage(e)}`;
              return;
            }
            if (token.isCancellationRequested) return;
            if (res.stopped) return; // paused mid-file: the file stays pending and continues on resume
            if (res.error) {
              error = `Backfill stopped at ${path.basename(entry.path)}: ${res.error}`;
              return;
            }
            records[ri] = markFileDone(records[ri], entry.path);
            await persist(records[ri]);
            done++;
            progress.report({ increment: (1 / Math.max(1, total)) * 100 });
            emit();
          }
        }
      } finally {
        sub.dispose();
      }
    });
    currentFile = undefined;
    if (token.isCancellationRequested) {
      await clearPersisted();
      setState('cancelled');
      notice('info', 'Backfill cancelled. Files already explained keep their twins.');
    } else if (error) {
      setState('error');
      notice('error', `${error} Fix the assistant connection (ExplainIT: Doctor) and run "ExplainIT: Resume backfill" to continue.`);
    } else if (pauseRequested) {
      setState('paused');
      notice('info', 'Backfill paused. Run "ExplainIT: Resume backfill" to continue where it stopped.');
    } else {
      await clearPersisted();
      setState('done');
      notice('info', 'Backfill finished: every code file now has a plain-English twin.');
    }
  };

  const guardRun = (fn: () => Promise<void>): Promise<void> => {
    running = fn().finally(() => {
      running = undefined;
    });
    return running;
  };

  // ---------------------------------------------------------------- controller

  const start = async (): Promise<void> => {
    if (running) {
      notice('info', 'Backfill is already running.');
      return;
    }
    if (state === 'paused' || (await loadPersisted()).length) return resume();
    const folders = deps.workspaceFolders();
    if (!folders.length) {
      notice('warn', 'Open a folder first: backfill explains the code files inside your workspace.');
      return;
    }
    await guardRun(async () => {
      error = undefined;
      estimate = undefined;
      records = [];
      setState('estimating');
      try {
        let result: Scan | undefined;
        let cancelledScan = false;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'ExplainIT: looking for code to explain', cancellable: true }, async (progress, vsToken) => {
          result = await scan(folders, vsToken, (m) => progress.report({ message: m }));
          cancelledScan = vsToken.isCancellationRequested;
        });
        if (!result || cancelledScan) {
          setState('cancelled');
          return;
        }
        const functions = result.requests.reduce((n, r) => n + r.functions.length, 0);
        if (functions === 0) {
          setState('done');
          notice('info', result.scanned === 0 ? 'No code files found to explain (check explainit.backfill.excludeGlobs).' : 'Every code file already has a fresh plain-English twin. Nothing to do.');
          return;
        }
        const est = deps.router.estimateCost(result.requests);
        const channel = await deps.router.resolveChannel();
        estimate = { ...est, channel };
        if (channel === 'none') {
          error = 'No assistant is connected, so nothing can be explained yet.';
          setState('error');
          notice('warn', `${error} Run "ExplainIT: Set up assistants" and try again.`);
          return;
        }
        const picked = await askModal(
          'twin.backfillConfirm',
          'Backfill plain-English twins for the whole project?',
          `${describeEstimate(estimate)}\n${result.skippedFresh} file${result.skippedFresh === 1 ? '' : 's'} already up to date will be skipped. Code goes only to the assistant you already use, under your existing agreement. You can pause at any time.`,
          [CONFIRM_START],
          CONFIRM_START,
        );
        if (picked !== CONFIRM_START) {
          setState('cancelled');
          return;
        }
        for (const [folder, entries] of result.entriesByFolder) {
          const r = createBackfillRecord(folder, entries, estimate);
          records.push(r);
          await persist(r);
        }
        await run();
      } catch (e) {
        error = errorMessage(e);
        setState('error');
        log.error('backfill failed', e);
        notice('error', `Backfill stopped: ${error}. Run "ExplainIT: Doctor" for details.`);
      }
    });
  };

  const pause = (): void => {
    if (state !== 'running') return;
    pauseRequested = true;
    log.info('pause requested; stopping after the current request');
    emit();
  };

  const resume = async (): Promise<void> => {
    if (running) {
      if (pauseRequested) {
        pauseRequested = false; // paused and resumed before the current request finished
        emit();
      }
      return;
    }
    if (!records.length) records = await loadPersisted();
    if (!records.length || records.every(isComplete)) {
      notice('info', 'There is no paused backfill to resume. Run "ExplainIT: Backfill the whole project" to start one.');
      setState('idle');
      return;
    }
    estimate = records.find((r) => r.estimate)?.estimate;
    await guardRun(run);
  };

  const cancel = (): void => {
    pauseRequested = false;
    if (cancelSource) cancelSource.cancel();
    if (!running) {
      void clearPersisted().then(() => setState('cancelled'));
    }
  };

  return { start, pause, resume, cancel, status, onStatus: (l) => emitter.event(l) };
}
