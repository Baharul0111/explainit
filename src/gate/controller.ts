/**
 * The gate flow (REQ-013/014/015 orchestration, goal items 7, 8, 9, 11). Given a validated hook
 * envelope it decides allow / deny / ask / none, driving the structure engine, the review presenter,
 * decision memory, the journal and checkpoints, and the twin engine. No `vscode` import: everything
 * host-specific comes in through the interfaces, so this file is testable with fakes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CancelToken, Disposable, GateDeps, HookEnvelope, Listener, SafetyKit } from '../core/interfaces';
import type { AgentKind, ChangeExplanation, Decision, FunctionHunk, FunctionMap, GateRequest, HookDecision, ProposedWrite } from '../core/types';
import { CancelSource, withTimeout } from '../core/cancel';
import { sha256, normalizeNewlines, randomId } from '../core/hash';
import { explainitHome, canonicalPath, isInside } from '../core/paths';
import { recordLanding } from '../core/landing';
import { validateEnvelope, resolveTarget, commandText, commandForAnalysis, targetPathOf, type IngressOk } from './pure/ingress';
import { buildClaudeWrites, buildPatchWrites, proposalSize, type ProposalIo } from './pure/proposals';
import { extractPatchText, parsePatch } from './pure/applyPatch';
import { checkWritePolicy, protectedPathMentioned, protectedMentionReason, protectedShellReason, shellProtectedTarget, type PolicyContext } from './pure/policy';
import { analyseCommand, shellWriteReason } from './pure/shell';
import { computeHunks, reconstruct } from './pure/differ';
import { detectEol, languageIdForPath, withEol } from './pure/text';

export const REVIEW_SIZE_CAP = 2 * 1024 * 1024;
/** Files larger than this are never read into memory for a proposal (the hook body cap is 8 MB too). */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
/**
 * How many changes from one assistant session may wait for a human at the same time (security
 * review F7). Beyond that the gate answers `ask` (the agent's own prompt) instead of opening yet
 * another review, so a runaway or hostile session cannot pile up work or exhaust memory.
 */
export const MAX_PENDING_PER_SESSION = 20;
const STRUCTURE_TIMEOUT_MS = 20_000;
const TWIN_UPDATE_TIMEOUT_MS = 180_000;
const POST_FALLBACK_MS = 10_000;

export interface ControllerDeps extends GateDeps {
  safetyFor: (path: string) => SafetyKit | undefined;
  disposables: Disposable[];
  /** Test seam: overrides `os.homedir()` for the protected-path policy. */
  userHome?: string;
}

/** Thrown for malformed input; the HTTP layer answers 400 with the message. */
export class IngressValidationError extends Error {
  readonly status = 400;
}

const NONE: HookDecision = { permissionDecision: 'none' };
const allow = (): HookDecision => ({ permissionDecision: 'allow' });
const deny = (reason: string): HookDecision => ({ permissionDecision: 'deny', reason });
const ask = (reason: string): HookDecision => ({ permissionDecision: 'ask', reason });

function readFileOrNull(p: string): string | null {
  try {
    if (!fs.statSync(p).isFile()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Like readFileOrNull, but refuses to load a huge file: the caller answers `ask` with the message. */
function readSourceOrNull(p: string): string | null {
  let size: number;
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  if (size > MAX_SOURCE_BYTES) {
    throw new Error(`the file ${path.basename(p)} is larger than ${MAX_SOURCE_BYTES / 1024 / 1024} MB, too big to review function by function`);
  }
  return readFileOrNull(p);
}

function hashText(t: string | null): string | null {
  return t === null ? null : sha256(normalizeNewlines(t));
}

/**
 * Collapse a Decision into what the gate acts on. A partial decision whose per-hunk verdicts all
 * agree is not partial; with no hunks at all the decision's own verdict stands.
 */
export function normalizeVerdict(decision: Decision, hunks: FunctionHunk[]): 'accept' | 'reject' | 'partial' | 'ask' | 'none' | 'deny' {
  if (decision.verdict === 'paused') return 'none';
  if (decision.verdict === 'deny-protected') return 'deny';
  if (decision.verdict === 'ask') return 'ask';
  if (decision.verdict === 'auto') return 'accept';
  if (hunks.length === 0) return decision.verdict === 'accept' ? 'accept' : 'reject';
  const hv = decision.hunkVerdicts;
  if (decision.verdict === 'partial' || (hv && Object.keys(hv).length)) {
    const verdicts = hunks.map((h) => hv?.[h.id] ?? (decision.verdict === 'accept' ? 'accept' : 'reject'));
    if (verdicts.every((x) => x === 'accept')) return 'accept';
    if (verdicts.every((x) => x === 'reject')) return 'reject';
    return 'partial';
  }
  return decision.verdict === 'accept' ? 'accept' : 'reject';
}

export class GateController {
  private _paused = false;
  private pendingHuman = 0;
  /** Reviews waiting for a human, per assistant session (`<agent> <sessionId>`). */
  private readonly pendingBySession = new Map<string, number>();
  private readonly requestListeners = new Set<Listener<GateRequest>>();
  private readonly log;
  /**
   * Allowed writes awaiting the agent's PostToolUse: path -> expected hash + fallback timer. Only
   * paths in this map are honoured when a PostToolUse arrives (security review F5): the agent can
   * read the session token, so a forged PostToolUse must never make the gate journal an "applied"
   * write, record a landing or regenerate a twin for a path nobody allowed.
   */
  private readonly expected = new Map<string, { hash: string | null; requestId: string; timer: NodeJS.Timeout; twin: boolean }>();
  private disposed = false;

  constructor(private readonly deps: ControllerDeps) {
    this.log = deps.logger.child('gate');
    deps.disposables.push({ dispose: () => this.dispose() });
  }

  get paused(): boolean {
    return this._paused;
  }
  setPaused(v: boolean): void {
    if (this._paused !== v) {
      this.log.info(v ? 'checkpoint paused (kill switch)' : 'checkpoint resumed');
      // Pausing or resuming is a fresh start: no "accept the rest" decision survives it (F3).
      try {
        this.deps.memory.clearAll();
      } catch (e) {
        this.log.warn('could not clear decision memory', e);
      }
    }
    this._paused = v;
  }
  get pending(): number {
    return this.pendingHuman;
  }
  onRequest(listener: Listener<GateRequest>): Disposable {
    this.requestListeners.add(listener);
    return { dispose: () => this.requestListeners.delete(listener) };
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.expected.values()) clearTimeout(e.timer);
    this.expected.clear();
    this.requestListeners.clear();
  }

  private kitFor(p: string): SafetyKit {
    return this.deps.safetyFor(p) ?? this.deps.safety;
  }

  private policyContext(): PolicyContext {
    let hook = '';
    try {
      hook = this.deps.adapters.hookScriptPath();
    } catch {
      /* adapters not ready */
    }
    // Codex keeps hooks.json / config.toml under CODEX_HOME when the person set it (the hook script
    // and the installer follow it too); the policy falls back to <userHome>/.codex.
    const codexHome = (process.env.CODEX_HOME ?? '').trim();
    return {
      explainitHome: explainitHome(),
      userHome: this.deps.userHome ?? os.homedir(),
      folders: this.deps.workspaceFolders(),
      extraProtected: hook ? [hook] : [],
      codexHome: codexHome || undefined,
    };
  }

  /** The whole flow. `requestId` lets the HTTP layer hand out an id before the decision exists. */
  async handle(envelope: HookEnvelope, requestId: string = randomId('req-')): Promise<HookDecision> {
    const v = validateEnvelope(envelope);
    if (!v.ok) throw new IngressValidationError(v.error);
    const tag = `${requestId} ${v.agent} ${v.event} ${v.toolName}`;
    let decision: HookDecision;
    try {
      decision = await this.route(v, requestId);
    } catch (e) {
      // Never auto-allow on failure: a broken step hands the call to the agent's own prompt.
      this.log.error(`${tag} failed`, e);
      decision = ask(`ExplainIT could not review this change (${(e as Error).message}). Falling back to your normal permission prompt.`);
    }
    this.log.info(`${tag} -> ${decision.permissionDecision}${decision.reason ? `: ${decision.reason.slice(0, 200)}` : ''}`);
    return decision;
  }

  private async route(v: IngressOk, requestId: string): Promise<HookDecision> {
    if (this._paused) return NONE;
    if (v.event === 'PostToolUse') return this.handlePost(v, requestId);
    if (v.category === 'irrelevant') return NONE;

    const folders = this.deps.workspaceFolders();
    const ctx = this.policyContext();

    if (v.category === 'shell') return this.handleShell(v, ctx);

    if (v.category === 'notebook') {
      const raw = targetPathOf(v.toolInput);
      if (raw) {
        const t = resolveTarget(raw, v.cwd, folders);
        const pol = checkWritePolicy({ kind: 'modify', path: t.path, before: null, after: null }, ctx);
        if (pol.action === 'deny') return deny(pol.reason);
      }
      return ask('ExplainIT does not review notebook cells function by function; your normal permission prompt decides.');
    }

    // Build the proposed writes.
    const io: ProposalIo = {
      readFile: readSourceOrNull,
      resolve: (raw) => resolveTarget(raw, v.cwd, folders).path,
    };
    const built = v.category === 'patch' ? buildPatchWrites(v.toolInput, io) : buildClaudeWrites(v.toolName, v.toolInput, io);
    if (!built.ok) {
      // e.g. old_string not found: let the tool fail on its own with its usual message.
      this.log.info(`${requestId} proposal not buildable (${built.kind}): ${built.error}`);
      if (built.kind === 'invalid' && v.category === 'patch') {
        return deny(`ExplainIT could not read this apply_patch call (${built.error}). Fix the patch format and try again.`);
      }
      return NONE;
    }
    const writes = built.writes;
    if (writes.length === 0) return NONE;

    // Twin files: written by ExplainIT itself; an agent may only write a valid twin.
    const twinWrites = writes.filter((w) => this.deps.twin.isTwinPath(w.path) || (w.newPath ? this.deps.twin.isTwinPath(w.newPath) : false));
    for (const w of twinWrites) {
      if (w.kind === 'delete' || w.kind === 'move' || w.after === null || !this.twinLooksValid(w.after)) {
        return deny('Twin files are written by ExplainIT; edit the code instead');
      }
    }
    if (twinWrites.length === writes.length) {
      // Fast path the Doctor relies on. Once the write lands, ExplainIT re-renders the twin from its
      // own cache/sidecar (F8), so a planted twin can never be the one the person ends up reading.
      for (const w of twinWrites) this.expectLanding(w.path, hashText(w.after), requestId, true);
      return allow();
    }
    const codeWrites = writes.filter((w) => !twinWrites.includes(w));

    // Protected paths: deny first, .git asks after a warning. Every write carries the FULL before /
    // after content (partial edits were replayed onto the current file above), so the hooks
    // comparison sees exactly what would land on disk.
    const warnings: string[] = [];
    for (const w of codeWrites) {
      // Edit / MultiEdit / an apply_patch update of an existing file are partial edits; hooks.json
      // is nothing but hooks, so any partial edit of it counts as a hooks change.
      const partial = v.category === 'edit' || v.category === 'multiedit' || (v.category === 'patch' && w.before !== null);
      const pol = checkWritePolicy(w, ctx, { partial });
      if (pol.action === 'deny') return deny(pol.reason);
      if (pol.action === 'ask') warnings.push(pol.warning);
    }
    if (warnings.length) return ask(warnings.join(' '));

    // Confinement: outside every workspace folder (and not protected) -> the agent's own flow.
    const inside = codeWrites.filter((w) => resolveTarget(w.path, v.cwd, folders).confinement === 'inside');
    if (inside.length === 0) return NONE;
    if (inside.length < codeWrites.length) {
      this.log.warn(`${requestId} ${codeWrites.length - inside.length} write(s) outside the workspace are not reviewed`);
    }

    if (proposalSize(inside) > REVIEW_SIZE_CAP) {
      return ask('ExplainIT: this change is larger than 2 MB, too big to review function by function. Your normal permission prompt decides.');
    }

    return this.review(v, requestId, inside);
  }

  private twinLooksValid(text: string): boolean {
    try {
      const parsed = this.deps.twin.parseTwin(text) as { sections: unknown[]; noFunctions?: boolean };
      if (!Array.isArray(parsed.sections)) return false;
      // A twin for a file without functions carries the CONTRACTS "no functions" line instead of sections.
      return parsed.sections.length > 0 || parsed.noFunctions === true;
    } catch {
      return false;
    }
  }

  private handleShell(v: IngressOk, ctx: PolicyContext): HookDecision {
    const cmd = commandText(v.toolInput);
    if (!cmd.trim()) return NONE;
    // Protected paths are refused in EVERY shellWrites mode: first by text (any spelling of a
    // protected path), then by following cd / pushd and resolving redirect, tee and heredoc targets
    // against the directory each segment runs in (security review F4).
    const mentioned = protectedPathMentioned(cmd, ctx);
    if (mentioned) return deny(protectedMentionReason(mentioned));
    const analysis = analyseCommand(commandForAnalysis(v.toolInput), { cwd: v.cwd, home: ctx.userHome });
    const hit = shellProtectedTarget(analysis, ctx);
    if (hit) return deny(protectedShellReason(hit));
    const mode = this.deps.settings.get('gateShellWrites');
    if (mode === 'ignore') return NONE;
    if (!analysis.writes) return NONE;
    const reason = shellWriteReason(analysis, v.agent);
    return mode === 'deny' ? deny(reason) : ask(reason);
  }

  /** PostToolUse: the agent has written. Verify what landed, tell the twin, never block. */
  private async handlePost(v: IngressOk, requestId: string): Promise<HookDecision> {
    if (v.category === 'irrelevant' || v.category === 'shell' || v.category === 'notebook') return NONE;
    const folders = this.deps.workspaceFolders();
    const paths: string[] = [];
    if (v.category === 'patch') {
      // The patch has already been applied; only its target paths matter now.
      const text = extractPatchText(v.toolInput);
      const parsed = text ? parsePatch(text) : undefined;
      if (parsed?.ok) {
        for (const h of parsed.hunks) {
          const target = h.kind === 'update' && h.moveTo ? h.moveTo : h.path;
          paths.push(resolveTarget(target, v.cwd, folders).path);
        }
      }
    } else {
      const raw = targetPathOf(v.toolInput);
      if (raw) paths.push(resolveTarget(raw, v.cwd, folders).path);
    }
    for (const p of paths) {
      const exp = this.expected.get(p);
      if (!exp) {
        // Not a write this gate allowed (or its window passed). The agent holds the session token,
        // so this could be forged: note it in the journal and do nothing else (F5). Paths outside
        // every workspace folder have no journal to note it in.
        if (resolveTarget(p, v.cwd, folders).confinement === 'outside') continue;
        this.log.info(`${requestId} PostToolUse for ${p} was not expected; ignored`);
        await this.journal(p, {
          kind: 'system',
          requestId,
          agent: v.agent,
          path: p,
          note: 'PostToolUse for a write ExplainIT had not allowed; ignored (no landing recorded, no twin update)',
        });
        continue;
      }
      clearTimeout(exp.timer);
      this.expected.delete(p);
      await this.landed(p, exp, v.agent, 'agent wrote the file');
    }
    return NONE;
  }

  /** An allowed write has landed (PostToolUse, or the fallback timer saw it). */
  private async landed(p: string, exp: { hash: string | null; requestId: string; twin: boolean }, agent: AgentKind | undefined, how: string): Promise<void> {
    recordLanding(p);
    if (exp.twin) {
      // A twin an assistant wrote is never the final word: re-render it from ExplainIT's own
      // cache / sidecar (zero model cost for unchanged functions) so the person reads our text (F8).
      await this.journal(p, { kind: 'system', requestId: exp.requestId, agent, path: p, note: 'twin written by an assistant; re-rendered by ExplainIT' });
      let source: string | undefined;
      try {
        source = await this.deps.twin.sourcePathForTwin(p);
      } catch (e) {
        this.log.warn(`${exp.requestId} could not find the source file for the twin ${p}`, e);
      }
      if (source) this.updateTwin(source, exp.requestId);
      else this.log.warn(`${exp.requestId} no source file found for the twin ${p}; it was not re-rendered`);
      return;
    }
    const onDisk = hashText(readFileOrNull(p));
    const note = exp.hash === onDisk ? 'match' : 'mismatch';
    await this.journal(p, {
      kind: 'applied',
      requestId: exp.requestId,
      agent,
      path: p,
      afterHash: onDisk,
      note: `${how}; on-disk content ${note}${note === 'mismatch' ? ' (differs from what was reviewed)' : ''}`,
    });
    if (note === 'mismatch') this.log.warn(`${exp.requestId} ${p}: on-disk content differs from the reviewed proposal`);
    this.updateTwin(p, exp.requestId);
  }

  private updateTwin(p: string, requestId: string): void {
    void withTimeout(this.deps.twin.updateAfterChange(p), TWIN_UPDATE_TIMEOUT_MS, 'twin update').catch((e) =>
      this.log.warn(`${requestId} twin update failed for ${p}`, e),
    );
  }

  /** Key for the per-session pending cap; a missing session id shares one bucket per agent. */
  private sessionBucket(v: IngressOk): string {
    return `${v.agent} ${v.sessionId || '-'}`;
  }

  private async functionMap(text: string | null, languageId: string, p: string, requestId: string): Promise<FunctionMap | undefined> {
    if (text === null || text === '') return undefined;
    try {
      return await withTimeout(this.deps.structure.getFunctionMapForText(text, languageId, p), STRUCTURE_TIMEOUT_MS, 'function map');
    } catch (e) {
      // Without a map the whole change is reviewed as "other" hunks; never skip the review.
      this.log.warn(`${requestId} function map failed for ${p}; reviewing as one block`, e);
      return undefined;
    }
  }

  private async review(v: IngressOk, requestId: string, writes: ProposedWrite[]): Promise<HookDecision> {
    const hunksByPath: Record<string, FunctionHunk[]> = {};
    for (const w of writes) {
      const languageId = languageIdForPath(w.path);
      const [bm, am] = await Promise.all([
        this.functionMap(w.before, languageId, w.path, requestId),
        this.functionMap(w.after, languageId, w.newPath ?? w.path, requestId),
      ]);
      const hunks = computeHunks(w.path, w.before, w.after, bm, am, { languageId });
      if (w.kind === 'move' && hunks.length === 0) {
        // A pure rename still deserves a card; it has no ranges so reconstruct ignores it.
        hunks.push({
          id: sha256(w.path + '\0move\0' + (w.newPath ?? '')),
          kind: 'other',
          functionName: `rename to ${path.basename(w.newPath ?? '')}`,
          changeType: 'modified',
          beforeText: '',
          afterText: '',
          trivial: false,
        });
      }
      hunksByPath[w.path] = hunks;
    }
    const request: GateRequest = {
      id: requestId,
      agent: v.agent,
      sessionId: v.sessionId,
      toolName: v.toolName,
      toolUseId: v.toolUseId,
      cwd: v.cwd,
      writes,
      hunksByPath,
      receivedAt: new Date().toISOString(),
    };
    const allHunks = writes.flatMap((w) => hunksByPath[w.path]);
    if (allHunks.length === 0) {
      // Identical content: nothing changes on disk, nothing to review. Creating or deleting an
      // empty file still changes the disk with nothing to show, so that goes to the agent's own prompt.
      const identical = writes.every((w) => w.kind === 'modify' && normalizeNewlines(w.before ?? '') === normalizeNewlines(w.after ?? ''));
      return identical ? allow() : NONE;
    }

    // Decision memory: "accept rest of file/session" or identical accepted hunks cover everything.
    // Only a request that carries a session id may use memory (F3): ExplainIT cannot verify the id
    // the assistant reports, so a request with none gets no memory at all rather than a shared bucket.
    const sessionKnown = v.sessionId !== '';
    const covered = sessionKnown && writes.every((w) => hunksByPath[w.path].every((h) => this.deps.memory.lookup(v.agent, v.sessionId, w.path, h.id) === 'accept'));
    if (covered) {
      const decision: Decision = {
        requestId,
        verdict: 'auto',
        scope: 'session',
        decidedAt: new Date().toISOString(),
        reason: `covered by an earlier "accept the rest" decision in assistant session ${v.sessionId} (ExplainIT trusts the session id the assistant reports; such decisions expire after 30 minutes without use)`,
      };
      await this.commitAccepted(request, decision);
      return allow();
    }

    // Per-session cap on reviews waiting for a human (F7): beyond it the agent's own prompt decides.
    const bucket = this.sessionBucket(v);
    const waiting = this.pendingBySession.get(bucket) ?? 0;
    if (waiting >= MAX_PENDING_PER_SESSION) {
      this.log.warn(`${requestId} ${bucket} already has ${waiting} change(s) waiting for review; answering ask`);
      return ask(
        `ExplainIT already has ${waiting} changes from this assistant session waiting for the person to review. Decide on those first; this change goes to your normal permission prompt.`,
      );
    }

    for (const w of writes) {
      await this.journal(w.path, {
        kind: 'proposed',
        requestId,
        agent: v.agent,
        path: w.path,
        beforeHash: hashText(w.before),
        afterHash: hashText(w.after),
        note: `${v.toolName}: ${w.kind}${w.newPath ? ` -> ${w.newPath}` : ''}, ${hunksByPath[w.path].length} hunk(s)`,
      });
    }

    for (const l of this.requestListeners) {
      try {
        l(request);
      } catch (e) {
        this.log.warn('onRequest listener failed', e);
      }
    }

    const cancel = new CancelSource();
    this.pendingHuman++;
    this.pendingBySession.set(bucket, waiting + 1);
    let decision: Decision;
    try {
      decision = await this.deps.review.review(request, (hunk, onText, token) => this.explain(request, hunk, onText, token), { token: cancel.token });
    } finally {
      this.pendingHuman--;
      const left = (this.pendingBySession.get(bucket) ?? 1) - 1;
      if (left <= 0) this.pendingBySession.delete(bucket);
      else this.pendingBySession.set(bucket, left);
    }
    if (this.disposed) return ask('ExplainIT was shut down during the review. Your normal permission prompt decides.');

    const verdict = normalizeVerdict(decision, allHunks);
    switch (verdict) {
      case 'accept':
        await this.commitAccepted(request, decision);
        return allow();
      case 'reject': {
        const reason = decision.reason?.trim() || 'no reason given';
        for (const w of writes) await this.journal(w.path, { kind: 'decided', requestId, agent: v.agent, path: w.path, decision });
        this.deps.memory.remember(decision, request);
        return deny(`Rejected by the person: ${reason}`);
      }
      case 'partial':
        return this.commitPartial(request, decision);
      case 'ask':
        for (const w of writes) await this.journal(w.path, { kind: 'decided', requestId, agent: v.agent, path: w.path, decision });
        return ask(decision.reason ?? 'ExplainIT handed this change to your normal permission prompt.');
      case 'none':
        return NONE;
      default:
        return deny(decision.reason ?? 'ExplainIT refused this change.');
    }
  }

  private explain(request: GateRequest, hunk: FunctionHunk, onText: (chunk: string) => void, token: CancelToken): Promise<ChangeExplanation> {
    const write = request.writes.find((w) => request.hunksByPath[w.path]?.includes(hunk)) ?? request.writes[0];
    const timeoutMs = Math.max(10, this.deps.settings.get('generationTimeoutSeconds')) * 1000;
    return withTimeout(
      this.deps.router.explainChange(
        {
          fileName: path.basename(write.newPath ?? write.path),
          languageId: languageIdForPath(write.path),
          functionName: hunk.functionName ?? (hunk.kind === 'other' ? 'code outside any function' : 'unnamed'),
          changeType: hunk.changeType,
          beforeText: hunk.beforeText,
          afterText: hunk.afterText,
        },
        { token, timeoutMs, progress: { onText } },
      ),
      timeoutMs + 1000,
      'explanation',
      token,
    );
  }

  private async journal(p: string, entry: Parameters<SafetyKit['journal']['append']>[0]): Promise<void> {
    try {
      await this.kitFor(p).journal.append(entry);
    } catch (e) {
      this.log.warn(`journal append failed for ${p}`, e);
    }
  }

  private async checkpoint(w: ProposedWrite, requestId: string, agent: AgentKind): Promise<string | undefined> {
    if (w.before === null) return undefined;
    try {
      const cp = await this.kitFor(w.path).checkpoints.save(w.path, w.before, { requestId, agent });
      return cp.id;
    } catch (e) {
      this.log.error(`restore point failed for ${w.path}`, e);
      throw new Error(`could not save a restore point for ${w.path}: ${(e as Error).message}`);
    }
  }

  /** Accept (or memory hit): restore point, journal, memory, expect the agent's write. */
  private async commitAccepted(request: GateRequest, decision: Decision): Promise<void> {
    for (const w of request.writes) {
      const checkpointId = await this.checkpoint(w, request.id, request.agent);
      await this.journal(w.path, { kind: 'decided', requestId: request.id, agent: request.agent, path: w.path, decision, checkpointId, beforeHash: hashText(w.before), afterHash: hashText(w.after) });
      this.expectLanding(w.newPath ?? w.path, hashText(w.after), request.id);
    }
    this.deps.memory.remember(decision, request);
  }

  /** If the agent's PostToolUse never arrives, check the disk ourselves after a grace period. */
  private expectLanding(p: string, hash: string | null, requestId: string, twin = false): void {
    const prev = this.expected.get(p);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      this.expected.delete(p);
      const onDisk = hashText(readFileOrNull(p));
      // A twin is re-rendered whatever landed (F8); a code write only counts when it matches the review.
      if (onDisk !== null && (twin || onDisk === hash)) {
        void this.landed(p, { hash, requestId, twin }, undefined, 'no PostToolUse received').catch((e) => this.log.warn(`${requestId} landing handling failed for ${p}`, e));
      } else {
        this.log.info(`${requestId} ${p}: accepted write has not landed after ${POST_FALLBACK_MS / 1000}s`);
      }
    }, POST_FALLBACK_MS);
    timer.unref?.();
    this.expected.set(p, { hash, requestId, timer, twin });
  }

  /**
   * Immediately before the gate writes a partially accepted file itself (F10): the path was
   * canonicalised when the proposal was built, and the review may have taken minutes. If it now
   * resolves elsewhere (a symlink appeared, a parent folder was swapped) or has left every workspace
   * folder, nothing is written. Returns the problem in plain English, or undefined when all is well.
   */
  private pathStillSafe(p: string): string | undefined {
    try {
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) return 'it is now a symbolic link';
    } catch {
      /* unreadable: canonicalPath below decides */
    }
    const now = canonicalPath(p);
    if (now !== p) return `it now resolves to "${now}"`;
    const folders = this.deps.workspaceFolders();
    if (!folders.some((f) => isInside(f, now))) return 'it is no longer inside a workspace folder';
    return undefined;
  }

  /** Partial acceptance: the gate lands the accepted hunks itself and denies the agent's write. */
  private async commitPartial(request: GateRequest, decision: Decision): Promise<HookDecision> {
    const hv = decision.hunkVerdicts ?? {};
    const landed: string[] = [];
    const rejected: string[] = [];
    const label = (h: FunctionHunk): string => h.functionName ?? (h.kind === 'other' ? 'code outside functions' : 'a block');
    for (const w of request.writes) {
      const hunks = request.hunksByPath[w.path] ?? [];
      const verdicts: Record<string, 'accept' | 'reject'> = {};
      for (const h of hunks) verdicts[h.id] = hv[h.id] === 'accept' ? 'accept' : 'reject';
      const acceptedHere = hunks.filter((h) => verdicts[h.id] === 'accept');
      const rejectedHere = hunks.filter((h) => verdicts[h.id] === 'reject');
      landed.push(...acceptedHere.map(label));
      rejected.push(...rejectedHere.map(label));
      if (acceptedHere.length === 0) continue;

      // The proposal was computed against `before`; if the file moved on while the person was
      // reviewing (another tool call, a concurrent agent), landing the reconstruction would clobber it.
      const onDisk = readFileOrNull(w.path);
      if (hashText(onDisk) !== hashText(w.before)) {
        this.log.warn(`${request.id} ${w.path} changed on disk during the review; nothing was written`);
        await this.journal(w.path, { kind: 'decided', requestId: request.id, agent: request.agent, path: w.path, decision, beforeHash: hashText(w.before), afterHash: hashText(onDisk), note: 'partial acceptance not applied: the file changed on disk during the review' });
        return deny(
          `Partly accepted by the person, but ${path.basename(w.path)} changed on disk while the review was open, so ExplainIT did not write anything. Re-read the file and propose the change again.`,
        );
      }

      const checkpointId = await this.checkpoint(w, request.id, request.agent);
      const rel = path.relative(process.cwd(), w.path);
      const eol = detectEol(w.before ?? w.after);
      // Re-validate the real path right before touching the disk (F10).
      const unsafe = this.pathStillSafe(w.path);
      if (unsafe) {
        this.log.warn(`${request.id} ${w.path} is not safe to write any more: ${unsafe}; nothing was written`);
        await this.journal(w.path, { kind: 'decided', requestId: request.id, agent: request.agent, path: w.path, decision, checkpointId, beforeHash: hashText(w.before), note: `partial acceptance not applied: the path changed during the review (${unsafe})` });
        return deny(
          `Partly accepted by the person, but ${path.basename(w.path)} moved while the review was open (${unsafe}), so ExplainIT did not write anything. Re-read the file and propose the change again.`,
        );
      }
      if (w.after === null && rejectedHere.length === 0) {
        fs.rmSync(w.path, { force: true });
        this.log.info(`${request.id} deleted ${rel} (accepted delete)`);
      } else {
        const lf = reconstruct(w.after ?? '', hunks, verdicts);
        const content = withEol(lf, eol);
        fs.mkdirSync(path.dirname(w.path), { recursive: true });
        fs.writeFileSync(w.path, content, 'utf8');
        recordLanding(canonicalPath(w.path));
        await this.journal(w.path, { kind: 'decided', requestId: request.id, agent: request.agent, path: w.path, decision, checkpointId, beforeHash: hashText(w.before), afterHash: hashText(content) });
        await this.journal(w.path, { kind: 'applied', requestId: request.id, agent: request.agent, path: w.path, beforeHash: hashText(w.before), afterHash: hashText(content), note: `ExplainIT wrote the accepted parts (${acceptedHere.length} of ${hunks.length} hunks)` });
        this.updateTwin(w.path, request.id);
      }
    }
    this.deps.memory.remember(decision, request);
    const reason = decision.reason?.trim();
    const moved = request.writes.filter((w) => w.kind === 'move').map((w) => w.newPath);
    const parts = [
      `Partly accepted by the person. ExplainIT already wrote the accepted parts to disk: ${landed.length ? landed.join(', ') : 'none'}.`,
      `Rejected: ${rejected.length ? rejected.join(', ') : 'none'}${reason ? ` (${reason})` : ''}.`,
      moved.length ? `The rename to ${moved.join(', ')} was not performed.` : '',
      'Re-read the file before continuing; do not re-apply the accepted parts.',
    ].filter(Boolean);
    return deny(parts.join(' '));
  }
}
