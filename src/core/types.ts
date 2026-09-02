/**
 * Shared data model for ExplainIT. Every module imports from here; nothing here imports `vscode`.
 * Mirrors the "Data model" table in architecture.md.
 */

export type Channel = 'copilot' | 'claude' | 'codex';
export type AgentKind = 'claude' | 'codex' | 'copilot';

/** 0-based, inclusive, always expanded to full lines. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

export type FunctionKind = 'function' | 'method' | 'constructor' | 'class' | 'other';
export type StructureSource = 'symbols' | 'tree-sitter' | 'ai' | 'heuristic' | 'none';

export interface FunctionRecord {
  /** Stable within a file: `${qualifiedName}#${ordinal}` (ordinal disambiguates duplicates). */
  id: string;
  /** Display name, qualified when nested ("Class.method"). */
  name: string;
  kind: FunctionKind;
  range: LineRange;
  /** sha256 hex of the function's full-line text after line-ending normalisation. */
  contentHash: string;
  languageId: string;
  source: StructureSource;
}

export interface FunctionMap {
  /** vscode Uri string (file://...) or an absolute path for virtual content. */
  fileUri: string;
  languageId: string;
  functions: FunctionRecord[];
  source: StructureSource;
  /** sha256 of the whole normalised text the map was built from. */
  textHash: string;
}

export interface Explanation {
  functionId: string;
  name: string;
  /** Exactly one plain-English sentence: what the function does. */
  summary: string;
  /** Two to five very short, simple sentences: how it does it. */
  steps: string[];
  warnings?: string[];
  uncertainty?: string;
  modelChannel: Channel | 'none';
  createdAt: string;
  contentHash: string;
}

export interface ChangeExplanation {
  functionName: string;
  /** One sentence: what changed. */
  whatChanged: string;
  /** One to three short sentences: why it matters. */
  whyItMatters: string[];
  risk?: string;
  modelChannel: Channel | 'none';
  createdAt: string;
}

export interface TwinSection {
  /** 1-based number shown in the twin. */
  index: number;
  functionId: string;
  name: string;
  contentHash: string;
  /** Line range of the section inside the twin file (0-based inclusive). */
  startLine: number;
  endLine: number;
  stale: boolean;
}

export interface TwinFile {
  fileUri: string;
  twinUri: string;
  sections: TwinSection[];
  generatedAt: string;
}

export interface CacheEntry {
  contentHash: string;
  explanation: Explanation;
}

export type ProposedOpKind = 'create' | 'modify' | 'delete' | 'move';

export interface ProposedWrite {
  kind: ProposedOpKind;
  /** Canonical absolute path (realpath of the nearest existing ancestor + remainder). */
  path: string;
  /** For moves: canonical destination path. */
  newPath?: string;
  /** Current on-disk content; null when the file does not exist yet. */
  before: string | null;
  /** Proposed content; null for deletes. */
  after: string | null;
}

export type HunkKind = 'function' | 'trivial' | 'other';
export type HunkChangeType = 'added' | 'removed' | 'modified';

export interface FunctionHunk {
  id: string;
  kind: HunkKind;
  functionName?: string;
  functionId?: string;
  changeType: HunkChangeType;
  beforeRange?: LineRange;
  afterRange?: LineRange;
  beforeText: string;
  afterText: string;
  /** Whitespace-only or comment-only change. Trivial hunks are batched in the review. */
  trivial: boolean;
  explanation?: ChangeExplanation;
}

export interface GateRequest {
  id: string;
  agent: AgentKind;
  sessionId: string;
  toolName: string;
  toolUseId?: string;
  cwd: string;
  writes: ProposedWrite[];
  /** Keyed by ProposedWrite.path. */
  hunksByPath: Record<string, FunctionHunk[]>;
  receivedAt: string;
  /** Free-form flags set by ingress (e.g. touches .git). */
  warnings?: string[];
}

export type Verdict = 'accept' | 'reject' | 'ask' | 'auto' | 'deny-protected' | 'paused' | 'partial';
export type DecisionScope = 'one' | 'file' | 'session';

export interface Decision {
  requestId: string;
  verdict: Verdict;
  reason?: string;
  scope: DecisionScope;
  decidedAt: string;
  /** Per-hunk verdicts when the user decided function by function. */
  hunkVerdicts?: Record<string, 'accept' | 'reject'>;
}

/** What the gate tells the hook script. `none` means "no opinion, use the agent's normal flow". */
export interface HookDecision {
  permissionDecision: 'allow' | 'deny' | 'ask' | 'none';
  reason?: string;
  updatedInput?: unknown;
}

export type JournalKind = 'proposed' | 'decided' | 'applied' | 'restored' | 'system';

export interface JournalEntry {
  version: 1;
  seq: number;
  ts: string;
  kind: JournalKind;
  requestId?: string;
  agent?: AgentKind;
  path?: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  decision?: Decision;
  checkpointId?: string;
  note?: string;
  /** Hash chain: sha256 of (prevHash + canonical JSON of the entry without `hash`). */
  prevHash: string;
  hash: string;
}

export interface Checkpoint {
  id: string;
  path: string;
  ts: string;
  contentHash: string;
  size: number;
  requestId?: string;
  agent?: AgentKind;
}

export interface AdapterState {
  agent: AgentKind;
  installed: boolean;
  armed: boolean;
  configHash?: string;
  scriptHash?: string;
  lastHeartbeat?: string;
  notes?: string[];
}

export interface ChannelAvailability {
  channel: Channel;
  available: boolean;
  /** Human-readable reason when unavailable (e.g. "claude CLI not found on PATH"). */
  reason?: string;
  detail?: string;
}

export interface CostEstimate {
  functions: number;
  files: number;
  requests: number;
  /** Rough input tokens (chars / 4). */
  inputTokens: number;
  /** Rough output tokens (functions * ~120). */
  outputTokens: number;
  channel: Channel | 'none';
}
