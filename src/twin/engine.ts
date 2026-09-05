/**
 * Twin engine core (REQ-003, REQ-005, REQ-008, REQ-010). All vscode glue for reading documents,
 * writing/opening twins and talking to the structure engine and the generation router lives here;
 * every decision about WHAT to (re)generate is delegated to the pure planner in pure/stale.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withTimeout } from '../core/cancel';
import { normalizeNewlines, sha256 } from '../core/hash';
import type { CancelToken, CoreDeps, Disposable, ExplainRequest, GenerationRouter, StructureEngine, TextDocumentLike, TwinEngine, BackfillController } from '../core/interfaces';
import { canonicalPath, isInside } from '../core/paths';
import type { Explanation, FunctionMap, TwinFile } from '../core/types';
import { chunk } from './pure/backfillState';
import { addToGitignore, ensureExcludePattern, hasIgnoreLine, sharedGitignorePath, TWIN_IGNORE_PATTERN } from './pure/gitExclude';
import { isCodeLanguage, languageIdForPath, MAX_TWIN_SOURCE_BYTES } from './pure/languages';
import { PROJECT_OFF_MESSAGE, type ProjectGate } from './projectPermission';
import { isTwinPath, sourceNameForTwin, twinPathFrom } from './pure/naming';
import { isFullyExplained, parseTwin, type ParsedTwin } from './pure/parse';
import { renderTwin, type SectionContent } from './pure/render';
import { deleteSidecar, readSidecar, sidecarPathFor, writeSidecar } from './pure/sidecar';
import { fileSummaryOf, functionText, outlineUnavailable, planSections, planWithoutOutline, previousSections, snapshotDocument, toRenderSections, toSidecarSections, type GenerateMode, type PlanEntry, type TwinPlan, type TwinSidecar } from './pure/stale';
import { minimalLineReplace } from './pure/textEdit';
import { askInfo, errorMessage, isTestMode, notice } from './prompt';

export interface TwinEngineDeps extends CoreDeps {
  structure: StructureEngine;
  router: GenerationRouter;
  workspaceFolders: () => string[];
  disposables: Disposable[];
  /** Per-project permission: nothing is explained in a project the person has not allowed. */
  projectGate: ProjectGate;
}

/** What the engine remembers per source file (canonical path) for scroll sync and staleness. */
export interface TwinState {
  source: string;
  twinPath: string;
  sidecar?: TwinSidecar;
  map?: FunctionMap;
  /** `${uri}@${version}` of the document the map was computed from (open documents only). */
  mapKey?: string;
}

export interface RefreshOptions {
  mode: GenerateMode | ((map: FunctionMap) => GenerateMode);
  open: boolean;
  silent: boolean;
  token?: CancelToken;
  /** Skip the "sidecar textHash matches" shortcut (staleness / updates always recompute). */
  skipFastPath?: boolean;
  /** Do nothing unless a twin already exists (markStale must never create twins). */
  requireExisting?: boolean;
  /** Backfill: functions per model request (hard cap 20). */
  maxPerRequest?: number;
  /** Backfill pause: checked between requests; true = stop after the current one. */
  shouldStop?: () => boolean;
  /** Regenerate even when the cache would answer (fresh wording on request). */
  bypassCache?: boolean;
  /** Same, decided once the function map is known (regenerateSection on unchanged code). */
  bypassCacheWhen?: (map: FunctionMap) => boolean;
}

export interface RefreshResult {
  twin?: TwinFile;
  /** Functions that were sent to the assistant in this run. */
  sent: number;
  /** Set when the assistant could not explain some functions. */
  error?: string;
  /** True when a backfill pause stopped the run before every function was explained. */
  stopped?: boolean;
  /** Why nothing was done. */
  skipped?: 'fast-path' | 'not-eligible' | 'no-twin' | 'no-assistant';
}

export interface FileAnalysis {
  sourcePath: string;
  twinPath: string;
  map: FunctionMap;
  plan: TwinPlan;
  request: ExplainRequest;
  fresh: boolean;
}

const STRUCTURE_TIMEOUT_MS = 60_000;
const STREAM_REWRITE_MS = 150;
const HARD_MAX_PER_REQUEST = 20;
const NO_SIDECAR_TTL_MS = 5_000;

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

/** TextDocumentLike view of a vscode document (the structure engine and router never see vscode). */
export function toDocLike(doc: vscode.TextDocument): TextDocumentLike {
  return {
    uri: doc.uri.toString(),
    fsPath: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
    languageId: doc.languageId,
    getText: () => doc.getText(),
    version: doc.version,
  };
}

function textHashOf(text: string): string {
  return sha256(normalizeNewlines(text));
}

function toContent(exp: Explanation): SectionContent {
  return { summary: exp.summary, steps: [...(exp.steps ?? [])], ...(exp.warnings?.length ? { warnings: [...exp.warnings] } : {}) };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export class TwinEngineImpl implements TwinEngine {
  private readonly log;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly states = new Map<string, TwinState>();
  private readonly twinToSource = new Map<string, string>();
  /** Sources known to have no sidecar (checked recently) so scroll events do not hit the disk. */
  private readonly noSidecarUntil = new Map<string, number>();
  private lastTwinColumn: vscode.ViewColumn | undefined;
  private hintedNoAssistant = false;
  private disposed = false;
  backfill!: BackfillController;

  constructor(private readonly deps: TwinEngineDeps) {
    this.log = deps.logger.child('twin');
  }

  /** The per-project permission gate (auto-open and backfill ask through it before generating). */
  get projectGate(): ProjectGate {
    return this.deps.projectGate;
  }

  // ------------------------------------------------------------------ paths

  isTwinPath(p: string): boolean {
    return isTwinPath(p);
  }

  /** Names of the FILES in a folder (a sub-folder called `app` beside `app.py` is not a stem collision). */
  private async siblings(dir: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => !e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async twinPathFor(sourcePath: string): Promise<string> {
    const abs = path.resolve(sourcePath);
    return twinPathFrom(abs, await this.siblings(path.dirname(abs)));
  }

  async sourcePathForTwin(twinPath: string): Promise<string | undefined> {
    const abs = path.resolve(twinPath);
    if (!isTwinPath(abs)) return undefined;
    const dir = path.dirname(abs);
    const name = sourceNameForTwin(path.basename(abs), await this.siblings(dir));
    return name ? path.join(dir, name) : undefined;
  }

  /** Workspace folder that holds the file (sidecars are per workspace), else the file's own folder. */
  private folderFor(sourcePath: string): string {
    return this.deps.workspaceFolders().find((f) => isInside(f, sourcePath)) ?? path.dirname(sourcePath);
  }

  private sidecarFile(sourcePath: string): string {
    return sidecarPathFor(this.folderFor(sourcePath), sourcePath);
  }

  // ------------------------------------------------------------------ state for glue (scroll sync, staleness)

  async stateFor(source: string): Promise<TwinState | undefined> {
    const key = canonicalPath(source);
    const cached = this.states.get(key);
    if (cached?.sidecar) return cached;
    const until = this.noSidecarUntil.get(key);
    if (until !== undefined && until > Date.now()) return cached;
    const sidecar = await readSidecar(this.sidecarFile(key));
    if (!sidecar) {
      this.noSidecarUntil.set(key, Date.now() + NO_SIDECAR_TTL_MS);
      return cached;
    }
    const st: TwinState = { ...(cached ?? { source: key, twinPath: sidecar.twinPath }), sidecar, twinPath: sidecar.twinPath };
    this.remember(st);
    return st;
  }

  private remember(st: TwinState): void {
    if (st.sidecar) this.noSidecarUntil.delete(st.source);
    this.states.set(st.source, st);
    this.twinToSource.set(canonicalPath(st.twinPath), st.source);
  }

  async sourceForTwin(twinPath: string): Promise<string | undefined> {
    const key = canonicalPath(twinPath);
    const known = this.twinToSource.get(key);
    if (known) return known;
    const src = await this.sourcePathForTwin(twinPath);
    return src ? canonicalPath(src) : undefined;
  }

  async hasTwin(sourcePath: string): Promise<boolean> {
    const key = canonicalPath(sourcePath);
    if (this.states.get(key)?.sidecar) return true;
    return exists(this.sidecarFile(key));
  }

  /** Function map for an open document, cached per document version (scroll sync calls this a lot). */
  async mapForDocument(doc: vscode.TextDocument): Promise<FunctionMap | undefined> {
    if (doc.uri.scheme !== 'file') return undefined;
    const key = canonicalPath(doc.uri.fsPath);
    const mapKey = `${doc.uri.toString()}@${doc.version}`;
    const st = this.states.get(key);
    if (st?.map && st.mapKey === mapKey) return st.map;
    try {
      const map = await withTimeout(this.deps.structure.getFunctionMap(toDocLike(doc)), STRUCTURE_TIMEOUT_MS, `Finding functions in ${path.basename(doc.uri.fsPath)}`);
      const next: TwinState = { ...(st ?? { source: key, twinPath: await this.twinPathFor(doc.uri.fsPath) }), map, mapKey };
      this.remember(next);
      return map;
    } catch (e) {
      this.log.warn('function map failed', e);
      return undefined;
    }
  }

  isTwinColumn(col: vscode.ViewColumn | undefined): boolean {
    return col !== undefined && col === this.lastTwinColumn;
  }

  // ------------------------------------------------------------------ documents

  private openDocument(sourcePath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && !d.isClosed && samePath(d.uri.fsPath, sourcePath));
  }

  /**
   * The open editor document when it has unsaved edits, else the file on disk (VS Code reloads a clean
   * document from disk lazily, so after an external write the open copy can be behind for a moment).
   */
  private async docFor(sourcePath: string): Promise<TextDocumentLike | undefined> {
    const open = this.openDocument(sourcePath);
    if (open?.isDirty) return toDocLike(open);
    try {
      const st = await fs.promises.stat(sourcePath);
      if (!st.isFile() || st.size > MAX_TWIN_SOURCE_BYTES) return undefined;
      const text = await fs.promises.readFile(sourcePath, 'utf8');
      if (open && open.getText() === text) return toDocLike(open);
      const abs = path.resolve(sourcePath);
      return { uri: vscode.Uri.file(abs).toString(), fsPath: abs, languageId: open?.languageId ?? languageIdForPath(abs) ?? 'plaintext', getText: () => text };
    } catch {
      return open ? toDocLike(open) : undefined;
    }
  }

  /** Why a document cannot have a twin, in plain English; undefined when it can. */
  ineligibleReason(doc: TextDocumentLike): string | undefined {
    if (!doc.fsPath || !doc.uri.startsWith('file:')) return 'ExplainIT only explains files saved on disk.';
    if (isTwinPath(doc.fsPath)) return 'This is already a plain-English twin.';
    if (!isCodeLanguage(doc.languageId)) return `ExplainIT does not explain ${doc.languageId} files, only code.`;
    if (Buffer.byteLength(doc.getText(), 'utf8') > MAX_TWIN_SOURCE_BYTES) return `${path.basename(doc.fsPath)} is larger than 2 MB, which is too big to explain.`;
    return undefined;
  }

  // ------------------------------------------------------------------ public API

  async ensureTwin(doc: TextDocumentLike, opts: { open?: boolean; force?: boolean; token?: CancelToken; silent?: boolean } = {}): Promise<TwinFile | undefined> {
    const reason = this.ineligibleReason(doc);
    if (reason) {
      if (!opts.silent) notice('info', reason);
      return undefined;
    }
    // Per-project permission: an explicit request may ask the person; a silent one never nags.
    if (!(await this.deps.projectGate.ensureAllowed(doc.fsPath!, { ask: !opts.silent }))) {
      if (!opts.silent && this.deps.projectGate.status(doc.fsPath!) === 'denied') notice('info', PROJECT_OFF_MESSAGE);
      return undefined;
    }
    const res = await this.serialize(doc.fsPath!, () =>
      this.refresh(doc, { mode: opts.force ? { kind: 'all' } : { kind: 'changed' }, open: opts.open ?? true, silent: opts.silent ?? false, token: opts.token, bypassCache: opts.force }),
    );
    return res.twin;
  }

  async updateAfterChange(sourcePath: string, opts: { token?: CancelToken } = {}): Promise<TwinFile | undefined> {
    if (this.deps.projectGate.status(sourcePath) !== 'allowed') return undefined;
    const doc = await this.docFor(sourcePath);
    if (!doc || this.ineligibleReason(doc)) return undefined;
    const res = await this.serialize(sourcePath, () => this.refresh(doc, { mode: { kind: 'changed' }, open: false, silent: true, token: opts.token, skipFastPath: true }));
    return res.twin;
  }

  async markStale(sourcePath: string): Promise<void> {
    if (this.deps.projectGate.status(sourcePath) !== 'allowed') return;
    const doc = await this.docFor(sourcePath);
    if (!doc || this.ineligibleReason(doc)) return;
    await this.markStaleDoc(doc);
  }

  async markStaleDoc(doc: TextDocumentLike): Promise<void> {
    await this.serialize(doc.fsPath!, () => this.refresh(doc, { mode: { kind: 'none' }, open: false, silent: true, skipFastPath: true, requireExisting: true }));
  }

  async regenerateSection(twinPath: string, sectionIndex: number): Promise<void> {
    const source = await this.sourcePathForTwin(twinPath);
    if (!source) throw new Error(`ExplainIT could not find the code file this twin belongs to (${path.basename(twinPath)}). Open the code file and run "ExplainIT: Open plain-English twin" instead.`);
    const doc = await this.docFor(source);
    const reason = doc ? this.ineligibleReason(doc) : 'The code file could not be read.';
    if (!doc || reason) throw new Error(`ExplainIT cannot regenerate this section: ${reason}`);
    const sidecar = await readSidecar(this.sidecarFile(source));
    let twinText: string | undefined;
    try {
      twinText = this.openDocument(twinPath)?.getText() ?? (await fs.promises.readFile(twinPath, 'utf8'));
    } catch {
      twinText = undefined;
    }
    const parsedName = twinText ? parseTwin(twinText).sections.find((s) => s.index === sectionIndex)?.name : undefined;
    const previous = sidecar?.sections.find((s) => s.index === sectionIndex);
    const mode = (map: FunctionMap): GenerateMode => {
      const fn =
        (previous && map.functions.find((f) => f.id === previous.functionId)) ??
        (previous && map.functions.find((f) => f.name === previous.name)) ??
        (parsedName ? map.functions.find((f) => f.name === parsedName) : undefined) ??
        map.functions[sectionIndex - 1];
      if (!fn) throw new Error(`Section ${sectionIndex} does not match a function in ${path.basename(source)} any more. Run "ExplainIT: Regenerate the whole twin for this file".`);
      return { kind: 'only', functionId: fn.id };
    };
    // If the code did not change the cache would hand back the same words; the person asked for a fresh take.
    const unchanged = (map: FunctionMap): boolean => {
      const target = mode(map);
      const fn = map.functions.find((f) => f.id === (target as { functionId: string }).functionId);
      return !!fn && !!previous && previous.contentHash === fn.contentHash;
    };
    const res = await this.serialize(source, () => this.refresh(doc, { mode, open: false, silent: false, skipFastPath: true, bypassCacheWhen: unchanged }));
    if (res.error) throw new Error(res.error);
  }

  parseTwin(text: string): ParsedTwin {
    return parseTwin(text);
  }

  async ensureGitExclude(folder: string): Promise<'added' | 'present' | 'no-git' | 'error'> {
    const r = await ensureExcludePattern(folder);
    if (r.result === 'added') this.log.info(`added ${TWIN_IGNORE_PATTERN} to ${r.file}`);
    else if (r.result === 'error') this.log.warn(`could not update git exclude for ${folder}: ${r.error ?? 'unknown error'}`);
    else this.log.debug(`git exclude ${r.result} for ${folder}`);
    return r.result;
  }

  async offerSharedGitignore(folder: string): Promise<void> {
    const file = await sharedGitignorePath(folder);
    if (!file) {
      notice('info', `${path.basename(folder)} is not inside a git repository, so there is no .gitignore to update.`);
      return;
    }
    let text = '';
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      text = '';
    }
    if (hasIgnoreLine(text, TWIN_IGNORE_PATTERN)) {
      notice('info', `${TWIN_IGNORE_PATTERN} is already in ${path.relative(folder, file) || '.gitignore'}.`);
      return;
    }
    const ADD = 'Add to .gitignore';
    const picked = await askInfo(
      'twin.sharedGitignore',
      `ExplainIT already keeps twins out of git on this machine. Teams that want everyone covered can add "${TWIN_IGNORE_PATTERN}" to the shared .gitignore. Add it?`,
      [ADD, 'Not now'],
      'Not now',
    );
    if (picked !== ADD) return;
    try {
      const r = await addToGitignore(file);
      notice('info', r === 'added' ? `Added ${TWIN_IGNORE_PATTERN} to .gitignore.` : `${TWIN_IGNORE_PATTERN} was already in .gitignore.`);
    } catch (e) {
      notice('error', `ExplainIT could not write ${file}: ${errorMessage(e)}. Add the line "${TWIN_IGNORE_PATTERN}" by hand if you want it shared.`);
    }
  }

  async setAutoOpen(enabled: boolean): Promise<void> {
    await this.deps.settings.set('autoOpenTwin', enabled, 'global');
    this.log.info(`auto-open ${enabled ? 'on' : 'off'}`);
  }

  dispose(): void {
    this.disposed = true;
    this.states.clear();
    this.twinToSource.clear();
  }

  // ------------------------------------------------------------------ backfill helpers

  /** Plan a file from disk (or its open document) without generating anything. */
  async analyze(sourcePath: string): Promise<FileAnalysis | undefined> {
    const doc = await this.docFor(sourcePath);
    if (!doc || this.ineligibleReason(doc)) return undefined;
    const abs = path.resolve(sourcePath);
    const twinPath = await this.twinPathFor(abs);
    const sidecar = await readSidecar(this.sidecarFile(abs));
    const text = doc.getText();
    const twinExists = await exists(twinPath);
    const parsed = twinExists ? await this.readParsedTwin(twinPath) : undefined;
    if (sidecar && twinExists && parsed && sidecar.textHash === textHashOf(text) && samePath(sidecar.twinPath, twinPath)) {
      const allExplained = sidecar.sections.every((s) => !s.stale) && parsed.sections.every((s) => s.state === 'explained');
      if (allExplained) {
        const map: FunctionMap = { fileUri: doc.uri, languageId: doc.languageId, functions: [], source: 'none', textHash: sidecar.textHash };
        return { sourcePath: abs, twinPath, map, plan: { entries: [], toGenerate: [] }, request: { fileName: path.basename(abs), languageId: doc.languageId, functions: [] }, fresh: true };
      }
    }
    // The estimate runs BEFORE the person confirms the backfill, so it never spends credits on AI
    // segmentation; a file only an assistant can outline is counted with 0 functions here and
    // outlined for real when its turn comes in the run.
    const map = await this.functionMap(doc);
    const { plan } = this.planFor(map, sidecar, parsed, { kind: 'changed' }, text);
    return { sourcePath: abs, twinPath, map, plan, request: this.requestFor(doc, map, plan.toGenerate), fresh: false };
  }

  /** Generate for a file on disk (backfill). */
  async refreshFromDisk(sourcePath: string, opts: { token?: CancelToken; maxPerRequest?: number; shouldStop?: () => boolean }): Promise<RefreshResult> {
    const doc = await this.docFor(sourcePath);
    if (!doc || this.ineligibleReason(doc)) return { sent: 0, skipped: 'not-eligible' };
    return this.serialize(sourcePath, () => this.refresh(doc, { mode: { kind: 'changed' }, open: false, silent: true, token: opts.token, maxPerRequest: opts.maxPerRequest, shouldStop: opts.shouldStop }));
  }

  // ------------------------------------------------------------------ the refresh pipeline

  /** One generation at a time per file; later calls queue behind the running one. */
  private serialize<T>(sourcePath: string, fn: () => Promise<T>): Promise<T> {
    const key = canonicalPath(sourcePath);
    const prev = this.inflight.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.inflight.set(key, run);
    void run.catch(() => undefined).finally(() => {
      if (this.inflight.get(key) === run) this.inflight.delete(key);
    });
    return run;
  }

  /**
   * Function map for the text being explained. `allowAi` unlocks the structure engine's AI-segmentation
   * last resort (REQ-012), which spends assistant credits: only a run that is about to generate
   * explanations anyway may ask for it. Staleness marks, scroll sync and the backfill estimate never do.
   */
  private async functionMap(doc: TextDocumentLike, token?: CancelToken, allowAi = false): Promise<FunctionMap> {
    const open = this.openDocument(doc.fsPath!);
    const what = `Finding functions in ${path.basename(doc.fsPath!)}`;
    const structureOpts = { token, ...(allowAi ? { allowAi: true } : {}) };
    // Symbols from the live document only when it holds the same text we are explaining.
    const useOpen = open !== undefined && open.getText() === doc.getText();
    const p = useOpen ? this.deps.structure.getFunctionMap(toDocLike(open), structureOpts) : this.deps.structure.getFunctionMapForText(doc.getText(), doc.languageId, doc.uri, structureOpts);
    return withTimeout(p, STRUCTURE_TIMEOUT_MS, what, token);
  }

  /**
   * The plan for a run. When nothing could outline the file this time but a twin with sections exists
   * (a staleness pass without AI segmentation, a disconnected assistant, an AI outline that timed out),
   * the old sections are kept and marked out of date instead of being replaced by "no functions".
   */
  private planFor(map: FunctionMap, sidecar: TwinSidecar | undefined, parsed: ParsedTwin | undefined, mode: GenerateMode, text: string): { plan: TwinPlan; outlined: boolean } {
    const textHash = textHashOf(text);
    if (outlineUnavailable(map, previousSections(sidecar, parsed), text)) {
      return { plan: planWithoutOutline(map, sidecar, parsed, !sidecar || sidecar.textHash !== textHash), outlined: false };
    }
    return { plan: planSections(map, sidecar, parsed, mode), outlined: true };
  }

  /**
   * The request for a batch of functions. The content hash is always the function's REAL hash so the
   * router's cache stays keyed by code; a forced regeneration asks the router to skip the cache through
   * `GenerationOptions.bypassCache` instead of salting the key (a salted key would store the fresh
   * explanation under a hash nothing can ever look up again).
   */
  private requestFor(doc: TextDocumentLike, map: FunctionMap, entries: readonly PlanEntry[]): ExplainRequest {
    const text = doc.getText();
    const thrift = this.deps.settings.get('tokenThrift');
    const summary = thrift ? fileSummaryOf(text, map.functions) : fileSummaryOf(text, map.functions, 40, 4000);
    return {
      fileName: path.basename(doc.fsPath!),
      languageId: map.languageId || doc.languageId,
      ...(summary ? { fileSummary: summary } : {}),
      functions: entries.map((e) => ({
        functionId: e.fn.id,
        name: e.fn.name,
        text: functionText(text, e.fn),
        contentHash: e.fn.contentHash,
      })),
    };
  }

  private async readParsedTwin(twinPath: string): Promise<ParsedTwin | undefined> {
    try {
      const open = this.openDocument(twinPath);
      return parseTwin(open ? open.getText() : await fs.promises.readFile(twinPath, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private async refresh(live: TextDocumentLike, opts: RefreshOptions): Promise<RefreshResult> {
    if (this.disposed) return { sent: 0, skipped: 'not-eligible' };
    // One run plans, slices and hashes against ONE version of the source, even while the person types.
    const doc = snapshotDocument(live);
    const sourcePath = path.resolve(doc.fsPath!);
    const key = canonicalPath(sourcePath);
    const base = path.basename(sourcePath);
    const text = doc.getText();
    const textHash = textHashOf(text);
    const twinPath = await this.twinPathFor(sourcePath);
    const sidecarFile = this.sidecarFile(sourcePath);
    const sidecar = await readSidecar(sidecarFile);
    const twinExists = await exists(twinPath);
    const started = Date.now();
    // Version of the open document this text came from (scroll sync keys its cached map by it).
    const openDoc = this.openDocument(sourcePath);
    const mapKey = openDoc && openDoc.getText() === text ? `${openDoc.uri.toString()}@${openDoc.version}` : undefined;

    // A twin the person deleted must not come back as a page of placeholders.
    if (opts.requireExisting && !twinExists) return { sent: 0, skipped: 'no-twin' };

    // When the naming rule switched form (a sibling with the same stem appeared or went away) the old
    // twin still holds every explanation: reuse it, then remove it once the new one is written.
    let previousTwinPath = sidecar && isTwinPath(sidecar.twinPath) && !samePath(sidecar.twinPath, twinPath) && (await exists(sidecar.twinPath)) ? sidecar.twinPath : undefined;
    const parsed = twinExists ? await this.readParsedTwin(twinPath) : previousTwinPath ? await this.readParsedTwin(previousTwinPath) : undefined;

    // FAST PATH (goal item 14): unchanged source + complete existing twin -> just open it, no structure call.
    // A twin still showing placeholders (failed assistant, paused backfill, crash) is not complete: try again.
    if (!opts.skipFastPath && sidecar && twinExists && parsed && sidecar.textHash === textHash && samePath(sidecar.twinPath, twinPath) && isFullyExplained(parsed)) {
      this.remember({ ...(this.states.get(key) ?? { source: key }), source: key, twinPath, sidecar });
      if (opts.open) await this.showTwin(twinPath, sourcePath);
      this.log.debug(`fast path for ${base} in ${Date.now() - started}ms`);
      return { twin: this.toTwinFile(doc.uri, twinPath, sidecar), sent: 0, skipped: 'fast-path' };
    }

    // Runs that may generate (ensureTwin, updateAfterChange, regenerateSection, backfill) may also pay for
    // the AI-segmentation last resort; a staleness pass (mode `none`) never spends credits.
    const mayGenerate = typeof opts.mode === 'function' || opts.mode.kind !== 'none';
    const map = await this.functionMap(doc, opts.token, mayGenerate);
    const mode = typeof opts.mode === 'function' ? opts.mode(map) : opts.mode;
    const bypassCache = opts.bypassCache || (opts.bypassCacheWhen ? opts.bypassCacheWhen(map) : false);
    const { plan, outlined } = this.planFor(map, sidecar, parsed, mode, text);
    if (!outlined) {
      const msg = `ExplainIT could not find the functions in ${base} this time, so the existing twin is kept and marked out of date.`;
      this.log.warn(`${msg} (mode ${mode.kind}, ${plan.entries.length} sections kept)`);
      if (!opts.silent && mayGenerate) notice('warn', `${msg} Check the assistant connection with "ExplainIT: Doctor" and try again.`);
    }
    const produced = new Map<string, SectionContent>();
    const pending = new Set(plan.toGenerate.map((e) => e.fn.id));

    /** What the sidecar file holds right now (so a failed twin write can put it back). */
    let committed: TwinSidecar | undefined = sidecar;
    const commit = async (final: boolean): Promise<TwinFile> => {
      const rendered = renderTwin(base, toRenderSections(plan, produced, final ? new Set() : pending));
      const next: TwinSidecar = {
        sourcePath: key,
        twinPath,
        textHash,
        sections: toSidecarSections(plan, produced, rendered.sections),
        generatedAt: new Date().toISOString(),
      };
      // Sidecar first, twin second: the moment the new twin shows up on disk (an editor save is visible
      // to everyone at once) its metadata - stale flags, hashes, line ranges - already describes it.
      await writeSidecar(sidecarFile, next);
      try {
        await this.writeTwin(twinPath, rendered.text);
      } catch (e) {
        if (committed) await writeSidecar(sidecarFile, committed).catch(() => undefined);
        else await deleteSidecar(sidecarFile);
        throw e;
      }
      committed = next;
      this.remember({ source: key, twinPath, sidecar: next, map, mapKey });
      if (previousTwinPath) {
        // Once, after the first successful write of the new twin (commit runs again while streaming).
        const old = previousTwinPath;
        previousTwinPath = undefined;
        await this.removeOldTwin(old, twinPath);
      }
      return this.toTwinFile(doc.uri, twinPath, next);
    };

    if (plan.toGenerate.length === 0) {
      const twin = await commit(true);
      if (opts.open) await this.showTwin(twinPath, sourcePath);
      this.log.debug(`re-rendered ${base} without generation (${map.functions.length} functions) in ${Date.now() - started}ms`);
      return { twin, sent: 0 };
    }

    // Silent runs (auto-open, backfill) never make a doomed assistant call. Without an assistant: no new
    // empty twins litter the workspace (hint once instead); an existing twin is re-rendered against the
    // current code with old sections kept (stale) and new ones marked "not explained yet".
    if (opts.silent && mode.kind !== 'none') {
      let channel: string = 'unknown';
      try {
        channel = await withTimeout(this.deps.router.resolveChannel(), 15_000, 'Checking assistants');
      } catch (e) {
        this.log.debug('resolveChannel failed', e);
      }
      if (channel === 'none') {
        if (!twinExists && !previousTwinPath) {
          this.hintNoAssistant();
          return { sent: 0, skipped: 'no-assistant' };
        }
        const twin = await commit(true);
        if (opts.open) await this.showTwin(twinPath, sourcePath);
        return { twin, sent: 0, skipped: 'no-assistant' };
      }
    }

    // Provisional twin: reused sections plus "(explaining...)" placeholders, written immediately.
    let twin = await commit(false);
    if (opts.open) await this.showTwin(twinPath, sourcePath);
    this.log.info(`explaining ${plan.toGenerate.length} of ${map.functions.length} functions in ${base} (provisional twin in ${Date.now() - started}ms)`);

    // Stream: rewrite the twin (throttled, coalesced) as each explanation arrives.
    let rewriteTimer: NodeJS.Timeout | undefined;
    let rewriteChain: Promise<unknown> = Promise.resolve();
    const scheduleRewrite = (): void => {
      if (rewriteTimer) return;
      rewriteTimer = setTimeout(() => {
        rewriteTimer = undefined;
        rewriteChain = rewriteChain.then(() => commit(false)).catch((e) => this.log.warn('streaming rewrite failed', e));
      }, STREAM_REWRITE_MS);
    };
    const onEach = (id: string, content: SectionContent): void => {
      if (!pending.has(id)) return;
      produced.set(id, content);
      pending.delete(id);
      scheduleRewrite();
    };

    const outcome = await this.explain(doc, map, plan.toGenerate, { ...opts, bypassCache }, onEach);
    if (rewriteTimer) {
      clearTimeout(rewriteTimer);
      rewriteTimer = undefined;
    }
    await rewriteChain;
    twin = await commit(true);

    const sent = plan.toGenerate.length;
    if (outcome.error && !outcome.stopped) {
      const missing = plan.toGenerate.filter((e) => !produced.has(e.fn.id)).length;
      const msg = `ExplainIT could not explain ${missing} function${missing === 1 ? '' : 's'} in ${base}: ${outcome.error} Check the assistant connection with "ExplainIT: Doctor", then right-click a section and choose "ExplainIT: Regenerate this section".`;
      this.log.warn(msg);
      if (!opts.silent) notice('warn', msg);
      return { twin, sent, error: msg };
    }
    this.log.info(`twin for ${base} ready (${produced.size} explained, ${sent} sent) in ${Date.now() - started}ms`);
    return { twin, sent, stopped: outcome.stopped };
  }

  private async explain(
    doc: TextDocumentLike,
    map: FunctionMap,
    entries: PlanEntry[],
    opts: RefreshOptions,
    onEach: (id: string, content: SectionContent) => void,
  ): Promise<{ error?: string; stopped?: boolean }> {
    const perRequest = Math.max(1, Math.min(HARD_MAX_PER_REQUEST, opts.maxPerRequest ?? HARD_MAX_PER_REQUEST));
    const timeoutMs = Math.max(10, this.deps.settings.get('generationTimeoutSeconds')) * 1000;
    const batches = chunk(entries, perRequest);
    for (let i = 0; i < batches.length; i++) {
      if (opts.token?.isCancellationRequested) return { error: 'The request was cancelled.', stopped: true };
      if (i > 0 && opts.shouldStop?.()) return { stopped: true };
      const batch = batches[i];
      const byId = new Map(batch.map((e) => [e.fn.id, e]));
      const byName = new Map(batch.map((e) => [e.fn.name, e]));
      const resolve = (exp: Explanation): string | undefined => byId.get(exp.functionId)?.fn.id ?? byName.get(exp.name)?.fn.id;
      const req = this.requestFor(doc, map, batch);
      try {
        const results = await withTimeout(
          this.deps.router.explainFunctions(req, {
            token: opts.token,
            timeoutMs,
            ...(opts.bypassCache ? { bypassCache: true } : {}),
            progress: {
              onExplanation: (exp) => {
                const id = resolve(exp);
                if (id) onEach(id, toContent(exp));
              },
            },
          }),
          // The router owns the real timeout and its single retry; this is only a safety net.
          timeoutMs * 2 + 10_000,
          `Explaining ${req.fileName}`,
          opts.token,
        );
        for (const exp of results ?? []) {
          const id = resolve(exp);
          if (id) onEach(id, toContent(exp));
        }
      } catch (e) {
        const msg = errorMessage(e).trim();
        return { error: msg.endsWith('.') ? msg : msg + '.' };
      }
    }
    return {};
  }

  private hintNoAssistant(): void {
    if (this.hintedNoAssistant || isTestMode()) return;
    this.hintedNoAssistant = true;
    const SETUP = 'Set up assistants';
    void vscode.window
      .showInformationMessage('ExplainIT cannot write plain-English twins yet because no assistant is connected.', SETUP)
      .then((pick) => pick === SETUP && vscode.commands.executeCommand('explainit.setupAssistants'));
  }

  private toTwinFile(fileUri: string, twinPath: string, sidecar: TwinSidecar): TwinFile {
    return { fileUri, twinUri: vscode.Uri.file(twinPath).toString(), sections: sidecar.sections.map((s) => ({ ...s })), generatedAt: sidecar.generatedAt };
  }

  // ------------------------------------------------------------------ writing and showing

  /**
   * Write the twin: when it is open in VS Code, apply the smallest line edit and save (instant, no flicker);
   * otherwise write the file directly. Always UTF-8 with LF.
   */
  private async writeTwin(twinPath: string, text: string): Promise<void> {
    const open = this.openDocument(twinPath);
    if (open) {
      try {
        const edit = new vscode.WorkspaceEdit();
        const edits: vscode.TextEdit[] = [];
        if (open.eol !== vscode.EndOfLine.LF) edits.push(vscode.TextEdit.setEndOfLine(vscode.EndOfLine.LF));
        const r = minimalLineReplace(open.getText(), text);
        if (r) {
          const last = open.lineCount - 1;
          const range = r.toLineExclusive <= last ? new vscode.Range(r.fromLine, 0, r.toLineExclusive, 0) : new vscode.Range(r.fromLine, 0, last, open.lineAt(last).text.length);
          const replacement = r.toLineExclusive <= last ? r.lines.map((l) => l + '\n').join('') : r.lines.join('\n');
          edits.push(vscode.TextEdit.replace(range, replacement));
        }
        if (edits.length) {
          edit.set(open.uri, edits);
          const ok = await vscode.workspace.applyEdit(edit);
          if (!ok) throw new Error('applyEdit returned false');
        }
        if (open.isDirty && !(await open.save())) throw new Error('save returned false');
        if (open.getText() === text) return;
        this.log.debug('editor text differs after edit; falling back to a direct write');
      } catch (e) {
        this.log.debug('editor write failed; writing the file directly', e);
      }
    }
    const tmp = `${twinPath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(twinPath), { recursive: true });
      await fs.promises.writeFile(tmp, text, 'utf8');
      try {
        await fs.promises.rename(tmp, twinPath);
      } catch {
        // Windows can refuse to rename over a file another program holds open: write in place instead.
        await fs.promises.writeFile(twinPath, text, 'utf8');
      }
    } catch (e) {
      throw new Error(`ExplainIT could not write ${path.basename(twinPath)} next to the code (${errorMessage(e)}). Check that the folder is writable and that nothing else uses that file name.`);
    } finally {
      await fs.promises.unlink(tmp).catch(() => undefined);
    }
  }

  /**
   * The naming rule switched form for this source (`app_explain.txt` <-> `app.py_explain.txt`) and the
   * new twin has been written: drop the old file so two twins never sit beside one source. Best effort;
   * a tab still showing the old twin is closed so it does not linger as a "deleted" editor.
   */
  private async removeOldTwin(oldTwinPath: string, newTwinPath: string): Promise<void> {
    if (samePath(oldTwinPath, newTwinPath)) return;
    this.twinToSource.delete(canonicalPath(oldTwinPath));
    try {
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && samePath(t.input.uri.fsPath, oldTwinPath));
      if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    } catch (e) {
      this.log.debug('could not close the old twin tab', e);
    }
    try {
      await fs.promises.unlink(oldTwinPath);
      this.log.info(`renamed twin: removed ${path.basename(oldTwinPath)} in favour of ${path.basename(newTwinPath)}`);
    } catch (e) {
      this.log.debug(`old twin ${oldTwinPath} could not be removed`, e);
    }
  }

  /** Open the twin beside the source unless it is already visible; keep focus on the code. */
  private async showTwin(twinPath: string, sourcePath: string): Promise<void> {
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file' && samePath(e.document.uri.fsPath, twinPath));
    if (visible) {
      this.lastTwinColumn = visible.viewColumn ?? this.lastTwinColumn;
      return;
    }
    const sourceEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file' && samePath(e.document.uri.fsPath, sourcePath));
    // Reuse the column where twins already live so several twins stack in one place.
    const twinColumn = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file' && isTwinPath(e.document.uri.fsPath) && e.viewColumn !== sourceEditor?.viewColumn)?.viewColumn;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(twinPath));
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: twinColumn ?? vscode.ViewColumn.Beside, preserveFocus: true, preview: false });
      this.lastTwinColumn = editor.viewColumn ?? this.lastTwinColumn;
    } catch (e) {
      this.log.warn(`could not open ${twinPath}`, e);
    }
  }
}
