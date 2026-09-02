/**
 * Cross-module contracts. Each module under src/<name>/ exports a factory that returns one of these
 * interfaces from its index.ts. Modules may import ONLY: their own directory, src/core/*, and the
 * interfaces of other modules from this file (never other modules' internals).
 *
 * Pure logic (no `vscode` import) lives in src/<module>/pure/ so it can be unit-tested in plain Node.
 */
import type {
  AdapterState,
  AgentKind,
  ChangeExplanation,
  Channel,
  ChannelAvailability,
  Checkpoint,
  CostEstimate,
  Decision,
  Explanation,
  FunctionHunk,
  FunctionMap,
  GateRequest,
  HookDecision,
  JournalEntry,
  TwinFile,
} from './types';
import type { Logger } from './log';
import type { Settings } from './settings';

// ---------------------------------------------------------------------------------------------
// Minimal host abstractions so pure code never touches `vscode` directly.
// ---------------------------------------------------------------------------------------------

export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(cb: () => void): { dispose(): void };
}

export interface Disposable {
  dispose(): void;
}

export interface TextDocumentLike {
  /** vscode Uri string, e.g. file:///abs/path.py */
  uri: string;
  /** Absolute filesystem path when the document is a file, else undefined. */
  fsPath?: string;
  languageId: string;
  getText(): string;
  version?: number;
}

/** Simple event emitter shape (vscode.Event compatible). */
export type Listener<T> = (e: T) => void;
export type EventLike<T> = (listener: Listener<T>) => Disposable;

// ---------------------------------------------------------------------------------------------
// Structure engine (src/structure) — REQ-002, REQ-012
// ---------------------------------------------------------------------------------------------

export interface StructureOptions {
  /** Permit the AI-segmentation last resort (costs assistant credits). Default false. */
  allowAi?: boolean;
  token?: CancelToken;
}

export interface StructureEngine {
  /** Function map for an open document. Tries DocumentSymbol (with readiness retry/backoff <=5s), then tree-sitter, then heuristics, then AI. */
  getFunctionMap(doc: TextDocumentLike, opts?: StructureOptions): Promise<FunctionMap>;
  /** Function map for arbitrary text (proposed content). May open a virtual document for symbols; falls back like above. */
  getFunctionMapForText(text: string, languageId: string, uriHint: string, opts?: StructureOptions): Promise<FunctionMap>;
  /** Language ids the tree-sitter fallback can parse (loaded lazily). */
  treeSitterLanguages(): string[];
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Generation router (src/generation) — REQ-005..009, REQ-020 inputs
// ---------------------------------------------------------------------------------------------

export interface ExplainFunctionInput {
  functionId: string;
  name: string;
  /** Full-line text of the function. Treated as UNTRUSTED DATA by every prompt. */
  text: string;
  contentHash: string;
}

export interface ExplainRequest {
  fileName: string;
  languageId: string;
  /** Optional minimal file summary (imports / top comment), capped by thrift mode. */
  fileSummary?: string;
  functions: ExplainFunctionInput[];
}

export interface ExplainProgress {
  /** Called as soon as a complete explanation for one function is available (streaming order). */
  onExplanation?(exp: Explanation): void;
  /** Raw text chunks as they stream (used to show that the first explanation is on its way). */
  onText?(chunk: string): void;
  onStatus?(msg: string): void;
}

export interface GenerationOptions {
  token?: CancelToken;
  progress?: ExplainProgress;
  /** Force a channel (otherwise: user pin -> availability -> fallback on error/quota). */
  channel?: Channel;
  timeoutMs?: number;
}

export interface ChangeExplainRequest {
  fileName: string;
  languageId: string;
  functionName: string;
  changeType: 'added' | 'removed' | 'modified';
  beforeText: string;
  afterText: string;
}

export interface AiSegment {
  name: string;
  startLine: number;
  endLine: number;
}

export interface ExplanationCache {
  get(contentHash: string): Explanation | undefined;
  set(contentHash: string, explanation: Explanation): void;
  has(contentHash: string): boolean;
  size(): number;
  flush(): Promise<void>;
}

export interface ConsentStore {
  /** Has the person granted permission to use their connected assistants? */
  granted(): boolean;
  setGranted(v: boolean): Promise<void>;
}

export interface GenerationRouter {
  /** Explain functions (cache hits never reach a model). Results are schema-validated. <=20 functions per model request. */
  explainFunctions(req: ExplainRequest, opts?: GenerationOptions): Promise<Explanation[]>;
  /** "What changed and why it matters" for one function; streams text via progress.onText. */
  explainChange(req: ChangeExplainRequest, opts?: GenerationOptions): Promise<ChangeExplanation>;
  /** AI segmentation last resort for languages nothing else can outline. */
  segmentWithAi(req: { fileName: string; languageId: string; text: string }, opts?: GenerationOptions): Promise<AiSegment[]>;
  /** Detect which channels can be used right now (never triggers a consent dialog by itself). */
  availableChannels(): Promise<ChannelAvailability[]>;
  /** Pure heuristic: chars/4 input tokens, ~120 output tokens per function, ceil(functions/20) requests per file. */
  estimateCost(req: ExplainRequest[]): CostEstimate;
  /** The channel that would be chosen right now, or 'none'. */
  resolveChannel(): Promise<Channel | 'none'>;
  /** Hash of all prompt templates (used by the eval baseline lock). */
  promptHash(): string;
}

// ---------------------------------------------------------------------------------------------
// Twin engine (src/twin) — REQ-003, REQ-004, REQ-010, REQ-011
// ---------------------------------------------------------------------------------------------

export interface BackfillStatus {
  state: 'idle' | 'estimating' | 'running' | 'paused' | 'done' | 'cancelled' | 'error';
  totalFiles: number;
  doneFiles: number;
  totalFunctions: number;
  doneFunctions: number;
  currentFile?: string;
  error?: string;
  estimate?: CostEstimate;
}

export interface BackfillController {
  /** Scans the workspace, shows the estimate, asks for confirmation, then runs with progress. Resumes a paused run if one exists. */
  start(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  cancel(): void;
  status(): BackfillStatus;
  onStatus: EventLike<BackfillStatus>;
}

export interface TwinEngine {
  /** `<stem>_explain.txt`, or `<filename>_explain.txt` when a sibling shares the stem. */
  twinPathFor(sourcePath: string): Promise<string>;
  /** Inverse lookup when possible. */
  sourcePathForTwin(twinPath: string): Promise<string | undefined>;
  isTwinPath(p: string): boolean;
  /** Create/refresh the twin (only new or changed functions hit the model), optionally open it beside the source. */
  ensureTwin(doc: TextDocumentLike, opts?: { open?: boolean; force?: boolean; token?: CancelToken; silent?: boolean }): Promise<TwinFile | undefined>;
  /** After an accepted change: regenerate only the changed functions' sections. */
  updateAfterChange(sourcePath: string, opts?: { token?: CancelToken }): Promise<TwinFile | undefined>;
  /** Mark sections whose function hash no longer matches as outdated (no model call). */
  markStale(sourcePath: string): Promise<void>;
  /** Regenerate exactly one section (by 1-based index) on request. */
  regenerateSection(twinPath: string, sectionIndex: number): Promise<void>;
  /** Parse an existing twin into sections (pure). */
  parseTwin(text: string): { sections: { index: number; name: string; startLine: number; endLine: number; stale: boolean }[] };
  /** Ensure `*_explain.txt` is in .git/info/exclude of the repo containing `folder`. */
  ensureGitExclude(folder: string): Promise<'added' | 'present' | 'no-git' | 'error'>;
  /** Offer (never force) a shared .gitignore entry. */
  offerSharedGitignore(folder: string): Promise<void>;
  backfill: BackfillController;
  /** Toggle auto-open (persists the setting). */
  setAutoOpen(enabled: boolean): Promise<void>;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Gate (src/gate) + Review (src/review) — REQ-013, REQ-014
// ---------------------------------------------------------------------------------------------

/** What a hook script sends: the agent's raw hook stdin JSON wrapped with the agent id. */
export interface HookEnvelope {
  agent: AgentKind;
  event: 'PreToolUse' | 'PostToolUse';
  payload: Record<string, unknown>;
  hookVersion?: string;
}

export interface GateSessionInfo {
  pid: number;
  port: number;
  token: string;
  folders: string[];
  startedAt: string;
  version: string;
}

export interface GateServer {
  start(): Promise<GateSessionInfo>;
  stop(): Promise<void>;
  readonly info: GateSessionInfo | undefined;
  /** Kill switch. When paused every PreToolUse gets `none` (agent's own prompt) and a banner is shown by ux. */
  setPaused(paused: boolean): void;
  readonly paused: boolean;
  /** Fired when the gate has a fully prepared request that needs a human. */
  onRequest: EventLike<GateRequest>;
  /** Heartbeat for the status bar. */
  onHeartbeat: EventLike<{ ts: string; pending: number }>;
  /** For tests and the doctor: handle an envelope directly without HTTP. */
  handle(envelope: HookEnvelope): Promise<HookDecision>;
}

export interface ReviewPresenter {
  /**
   * Show the change per function beside its plain-English meaning and wait for the person.
   * Accept must stay disabled until the explanation for the current hunk has rendered.
   * `explain` streams a ChangeExplanation for a hunk (progress.onText for partial text).
   */
  review(
    request: GateRequest,
    explain: (hunk: FunctionHunk, onText: (chunk: string) => void, token: CancelToken) => Promise<ChangeExplanation>,
    opts?: { token?: CancelToken },
  ): Promise<Decision>;
  dispose(): void;
}

export interface DecisionMemory {
  /** Returns 'accept' when a previous "accept rest of file/session" or an identical accepted hunk covers this one. */
  lookup(agent: AgentKind, sessionId: string, path: string, hunkHash: string): 'accept' | undefined;
  remember(decision: Decision, request: GateRequest): void;
  clearSession(agent: AgentKind, sessionId: string): void;
  clearAll(): void;
}

// ---------------------------------------------------------------------------------------------
// Journal & safety (src/journal) — REQ-015
// ---------------------------------------------------------------------------------------------

export interface Journal {
  append(entry: Omit<JournalEntry, 'version' | 'seq' | 'ts' | 'prevHash' | 'hash'>): Promise<JournalEntry>;
  list(opts?: { path?: string; limit?: number }): Promise<JournalEntry[]>;
  verifyChain(): Promise<{ ok: boolean; entries: number; brokenAt?: number; detail?: string }>;
  readonly file: string;
}

export interface CheckpointStore {
  save(path: string, content: string, meta?: { requestId?: string; agent?: AgentKind }): Promise<Checkpoint>;
  list(path?: string): Promise<Checkpoint[]>;
  read(id: string): Promise<{ checkpoint: Checkpoint; content: string } | undefined>;
  /** Writes the snapshot back to its original path (after saving a fresh checkpoint of the current content). */
  restore(id: string): Promise<{ restoredPath: string; safetyCheckpointId: string }>;
  /** Checkpoint -> restore round trip on a temp file inside the store; used by the doctor. */
  selfTest(): Promise<{ ok: boolean; detail: string }>;
  /** Apply rotation caps (per file / total size). */
  rotate(): Promise<void>;
}

export interface SafetyKit {
  journal: Journal;
  checkpoints: CheckpointStore;
}

// ---------------------------------------------------------------------------------------------
// Agent adapters (src/adapters) — REQ-016..018
// ---------------------------------------------------------------------------------------------

export interface DetectResult {
  agent: AgentKind;
  /** The CLI / extension is present on this machine. */
  present: boolean;
  version?: string;
  /** Signed in / usable (best effort). */
  ready?: boolean;
  detail?: string;
  /** Where the executable or extension was found. */
  location?: string;
}

export interface InstallResult {
  agent: AgentKind;
  ok: boolean;
  changed: boolean;
  /** Plain-English steps the person still has to do (e.g. "start codex once and trust the ExplainIT hook"). */
  nextSteps: string[];
  detail?: string;
}

export interface IntegrityReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string; fixable?: boolean }[];
}

export interface AdapterManager {
  detect(): Promise<DetectResult[]>;
  install(agent: AgentKind): Promise<InstallResult>;
  uninstall(agent: AgentKind): Promise<InstallResult>;
  /** Verify hook script + wrapper + config hashes; called every session by the doctor/heartbeat. */
  verifyIntegrity(): Promise<IntegrityReport>;
  /** Re-write tampered scripts/config entries. */
  rearm(): Promise<IntegrityReport>;
  states(): Promise<AdapterState[]>;
  /** Absolute path of the installed hook script (for protected-path policy). */
  hookScriptPath(): string;
}

export interface CopilotWatcher extends Disposable {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export interface InstructionsGenerator {
  /** Writes/updates the ExplainIT sections in CLAUDE.md, AGENTS.md and .github/copilot-instructions.md (idempotent, marker-delimited). */
  ensure(folder: string, opts?: { agents?: AgentKind[] }): Promise<{ written: string[]; unchanged: string[] }>;
  /** The exact section text (pure). */
  sectionText(agent: AgentKind): string;
}

// ---------------------------------------------------------------------------------------------
// UX (src/ux) — REQ-019, goal items 1, 12
// ---------------------------------------------------------------------------------------------

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: { label: string; run: () => Promise<void> };
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  ranAt: string;
}

export interface Ux {
  /** First-use flow: permission -> detection -> one-click connect -> guidance when none is connected. */
  runOnboarding(opts?: { force?: boolean }): Promise<void>;
  runDoctor(): Promise<DoctorReport>;
  showPausedBanner(paused: boolean): void;
  setHeartbeat(alive: boolean, pending: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Shared dependency bag
// ---------------------------------------------------------------------------------------------

export interface CoreDeps {
  logger: Logger;
  settings: Settings;
  /** Absolute path to the extension install directory (for dist/wasm, hooks/, docs/). */
  extensionPath: string;
  /** Extension version from package.json. */
  version: string;
}

export interface GateDeps extends CoreDeps {
  structure: StructureEngine;
  router: GenerationRouter;
  twin: TwinEngine;
  review: ReviewPresenter;
  memory: DecisionMemory;
  safety: SafetyKit;
  adapters: AdapterManager;
  workspaceFolders: () => string[];
}
