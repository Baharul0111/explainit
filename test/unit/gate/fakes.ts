/**
 * Fakes for gate unit tests: a regex structure engine, in-memory journal/checkpoints, review and
 * memory stubs. No `vscode` import.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AdapterManager,
  CheckpointStore,
  DecisionMemory,
  GenerationRouter,
  Journal,
  ReviewPresenter,
  SafetyKit,
  StructureEngine,
  TwinEngine,
} from '../../../src/core/interfaces';
import type { Checkpoint, Decision, FunctionMap, FunctionRecord, GateRequest, JournalEntry } from '../../../src/core/types';
import { createLogger, type Logger } from '../../../src/core/log';
import { inMemorySettings, type SettingsValues } from '../../../src/core/settings';
import { contentHashOf, sha256 } from '../../../src/core/hash';
import type { ControllerDeps } from '../../../src/gate/controller';

/** Functions = lines matching `def name(` / `function name(` / `name(...) {` until the next one (trailing blank lines excluded). */
export function regexFunctionMap(text: string, languageId: string, uri: string): FunctionMap {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const starts: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?(?:async\s+)?(?:def|function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(lines[i]);
    if (m) starts.push({ name: m[1], line: i });
  }
  const functions: FunctionRecord[] = starts.map((s, idx) => {
    let end = idx + 1 < starts.length ? starts[idx + 1].line - 1 : lines.length - 1;
    while (end > s.line && lines[end].trim() === '') end--;
    const body = lines.slice(s.line, end + 1).join('\n') + '\n';
    return {
      id: `${s.name}#${starts.slice(0, idx).filter((x) => x.name === s.name).length}`,
      name: s.name,
      kind: 'function',
      range: { startLine: s.line, endLine: end },
      contentHash: contentHashOf(body),
      languageId,
      source: 'heuristic',
    };
  });
  return { fileUri: uri, languageId, functions, source: 'heuristic', textHash: sha256(text) };
}

export function fakeStructure(): StructureEngine & { calls: number; fail?: boolean; delayMs?: number } {
  const s = {
    calls: 0,
    fail: false,
    delayMs: 0,
    async getFunctionMap() {
      throw new Error('not used');
    },
    async getFunctionMapForText(text: string, languageId: string, uriHint: string) {
      s.calls++;
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      if (s.fail) throw new Error('structure unavailable');
      return regexFunctionMap(text, languageId, uriHint);
    },
    treeSitterLanguages: () => [],
    dispose() {},
  };
  return s as unknown as StructureEngine & { calls: number; fail?: boolean; delayMs?: number };
}

export function fakeRouter(opts: { fail?: boolean; delayMs?: number } = {}): GenerationRouter & { calls: number } {
  const r = {
    calls: 0,
    async explainChange(req: { functionName: string }, o?: { progress?: { onText?(c: string): void } }) {
      r.calls++;
      if (opts.delayMs) await new Promise((res) => setTimeout(res, opts.delayMs));
      if (opts.fail) throw new Error('assistant unavailable');
      o?.progress?.onText?.('streaming...');
      return { functionName: req.functionName, whatChanged: 'It changed.', whyItMatters: ['It matters.'], modelChannel: 'none' as const, createdAt: new Date().toISOString() };
    },
    async explainFunctions() {
      return [];
    },
    async segmentWithAi() {
      return [];
    },
    async availableChannels() {
      return [];
    },
    estimateCost: () => ({ functions: 0, files: 0, requests: 0, inputTokens: 0, outputTokens: 0, channel: 'none' as const }),
    async resolveChannel() {
      return 'none' as const;
    },
    promptHash: () => 'x',
  };
  return r as unknown as GenerationRouter & { calls: number };
}

export function fakeTwin(): TwinEngine & { updated: string[] } {
  const t = {
    updated: [] as string[],
    async twinPathFor(p: string) {
      return p.replace(/\.[^.]+$/, '') + '_explain.txt';
    },
    async sourcePathForTwin(p: string) {
      // Inverse of twinPathFor: the sibling whose stem matches `<stem>_explain.txt`.
      const base = path.basename(p);
      if (!base.endsWith('_explain.txt')) return undefined;
      const stem = base.slice(0, -'_explain.txt'.length);
      try {
        const hit = fs.readdirSync(path.dirname(p)).find((n) => n !== base && n.replace(/\.[^.]+$/, '') === stem);
        return hit ? path.join(path.dirname(p), hit) : undefined;
      } catch {
        return undefined;
      }
    },
    isTwinPath: (p: string) => path.basename(p).endsWith('_explain.txt'),
    async ensureTwin() {
      return undefined;
    },
    async updateAfterChange(p: string) {
      t.updated.push(p);
      return undefined;
    },
    async markStale() {},
    async regenerateSection() {},
    parseTwin(text: string) {
      const sections: { index: number; name: string; startLine: number; endLine: number; stale: boolean }[] = [];
      const lines = text.split('\n');
      lines.forEach((l, i) => {
        const m = /^(\d+)\. (\S+)/.exec(l);
        if (m) sections.push({ index: Number(m[1]), name: m[2], startLine: i, endLine: i, stale: false });
      });
      return { sections };
    },
    async ensureGitExclude() {
      return 'present' as const;
    },
    async offerSharedGitignore() {},
    backfill: {} as TwinEngine['backfill'],
    async setAutoOpen() {},
    dispose() {},
  };
  return t as unknown as TwinEngine & { updated: string[] };
}

export function fakeSafety(): SafetyKit & { entries: JournalEntry[]; checkpoints: CheckpointStore & { saved: Checkpoint[]; contents: Map<string, string> } } {
  const entries: JournalEntry[] = [];
  const saved: Checkpoint[] = [];
  const contents = new Map<string, string>();
  const journal: Journal = {
    file: 'memory',
    async append(e) {
      const prev = entries[entries.length - 1]?.hash ?? '0'.repeat(64);
      const full = { version: 1 as const, seq: entries.length, ts: new Date().toISOString(), prevHash: prev, hash: '', ...e };
      full.hash = sha256(prev + JSON.stringify(full));
      entries.push(full);
      return full;
    },
    async list() {
      return entries;
    },
    async verifyChain() {
      return { ok: true, entries: entries.length };
    },
  };
  const checkpoints = {
    saved,
    contents,
    async save(p: string, content: string, meta?: { requestId?: string; agent?: 'claude' | 'codex' | 'copilot' }) {
      const cp: Checkpoint = { id: `cp-${saved.length + 1}`, path: p, ts: new Date().toISOString(), contentHash: sha256(content), size: content.length, ...meta };
      saved.push(cp);
      contents.set(cp.id, content);
      return cp;
    },
    async list() {
      return saved;
    },
    async read(id: string) {
      const c = saved.find((x) => x.id === id);
      return c ? { checkpoint: c, content: contents.get(id) ?? '' } : undefined;
    },
    async restore() {
      return { restoredPath: '', safetyCheckpointId: '' };
    },
    async selfTest() {
      return { ok: true, detail: '' };
    },
    async rotate() {},
  };
  return { journal, checkpoints, entries } as unknown as SafetyKit & { entries: JournalEntry[]; checkpoints: typeof checkpoints };
}

export type ReviewScript = (request: GateRequest) => Decision | Promise<Decision>;

export function fakeReview(script: ReviewScript): ReviewPresenter & { requests: GateRequest[]; explainErrors: Error[] } {
  const r = {
    requests: [] as GateRequest[],
    explainErrors: [] as Error[],
    async review(request: GateRequest, explain: (hunk: any, onText: (c: string) => void, token: any) => Promise<unknown>) {
      r.requests.push(request);
      // Like the real presenter: explanations are requested for every hunk before a decision.
      for (const w of request.writes) {
        for (const h of request.hunksByPath[w.path] ?? []) {
          try {
            await explain(h, () => undefined, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
          } catch (e) {
            r.explainErrors.push(e as Error);
          }
        }
      }
      return script(request);
    },
    dispose() {},
  };
  return r as unknown as ReviewPresenter & { requests: GateRequest[]; explainErrors: Error[] };
}

export function fakeMemory(): DecisionMemory & { remembered: Decision[]; accepted: Set<string>; cleared: number } {
  const accepted = new Set<string>();
  const m = {
    remembered: [] as Decision[],
    accepted,
    cleared: 0,
    lookup: (_a: string, _s: string, _p: string, hash: string) => (accepted.has(hash) ? ('accept' as const) : undefined),
    remember(decision: Decision) {
      m.remembered.push(decision);
    },
    clearSession() {},
    clearAll() {
      m.cleared++;
      accepted.clear();
    },
  };
  return m as unknown as DecisionMemory & { remembered: Decision[]; accepted: Set<string>; cleared: number };
}

export function fakeAdapters(hookScript: string): AdapterManager {
  return {
    async detect() {
      return [];
    },
    async install(agent) {
      return { agent, ok: true, changed: false, nextSteps: [] };
    },
    async uninstall(agent) {
      return { agent, ok: true, changed: false, nextSteps: [] };
    },
    async verifyIntegrity() {
      return { ok: true, checks: [] };
    },
    async rearm() {
      return { ok: true, checks: [] };
    },
    async ensureArmed() {
      return { armed: [], alreadyArmed: [], failed: [], skipped: [], nextSteps: [] };
    },
    async states() {
      return [];
    },
    hookScriptPath: () => hookScript,
  };
}

export function quietLogger(): Logger {
  return createLogger([{ write: () => undefined }], 'test', 'error');
}

export interface Harness {
  deps: ControllerDeps;
  root: string;
  workspace: string;
  home: string;
  userHome: string;
  structure: ReturnType<typeof fakeStructure>;
  router: ReturnType<typeof fakeRouter>;
  twin: ReturnType<typeof fakeTwin>;
  safety: ReturnType<typeof fakeSafety>;
  review: ReturnType<typeof fakeReview>;
  memory: ReturnType<typeof fakeMemory>;
  setReview(script: ReviewScript): void;
  cleanup(): void;
}

/** A temp workspace + temp ExplainIT home + temp user home, all wired into ControllerDeps. */
export function makeHarness(opts: { settings?: Partial<SettingsValues>; review?: ReviewScript; routerFail?: boolean } = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explainit-gate-'));
  const workspace = path.join(root, 'ws');
  const home = path.join(root, 'home');
  const userHome = path.join(root, 'user');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  const prevHome = process.env.EXPLAINIT_HOME;
  process.env.EXPLAINIT_HOME = home;

  let script: ReviewScript = opts.review ?? (() => ({ requestId: '', verdict: 'reject', scope: 'one', decidedAt: '', reason: 'no script' }));
  const structure = fakeStructure();
  const router = fakeRouter({ fail: opts.routerFail });
  const twin = fakeTwin();
  const safety = fakeSafety();
  const review = fakeReview((r) => script(r));
  const memory = fakeMemory();
  const deps: ControllerDeps = {
    logger: quietLogger(),
    settings: inMemorySettings(opts.settings),
    extensionPath: root,
    version: '0.0.0-test',
    structure,
    router,
    twin,
    review,
    memory,
    safety,
    safetyFor: () => safety,
    adapters: fakeAdapters(path.join(home, 'hooks', 'explainit-hook.js')),
    workspaceFolders: () => [workspace],
    disposables: [],
    userHome,
  };
  return {
    deps,
    root,
    workspace,
    home,
    userHome,
    structure,
    router,
    twin,
    safety,
    review,
    memory,
    setReview: (s) => {
      script = s;
    },
    cleanup() {
      for (const d of deps.disposables) d.dispose();
      if (prevHome === undefined) delete process.env.EXPLAINIT_HOME;
      else process.env.EXPLAINIT_HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function claudeEnvelope(toolName: string, toolInput: Record<string, unknown>, cwd: string, event: 'PreToolUse' | 'PostToolUse' = 'PreToolUse') {
  return {
    agent: 'claude' as const,
    event,
    payload: { session_id: 'sess-1', cwd, hook_event_name: event, tool_name: toolName, tool_input: toolInput, tool_use_id: 'toolu_1' },
  };
}

export function codexEnvelope(toolName: string, toolInput: Record<string, unknown>, cwd: string, event: 'PreToolUse' | 'PostToolUse' = 'PreToolUse') {
  return {
    agent: 'codex' as const,
    event,
    payload: { session_id: 'sess-2', turn_id: 'turn-1', cwd, hook_event_name: event, tool_name: toolName, tool_input: toolInput, tool_use_id: 'call_1' },
  };
}
