/**
 * Registers every command declared in package.json (27). Each handler is wrapped so a failure shows a
 * plain-English message and is logged, never an unhandled rejection. All disposables go to deps.disposables.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DoctorReport, SafetyKit, TextDocumentLike } from '../core/interfaces';
import type { AgentKind, Checkpoint } from '../core/types';
import { withTimeout } from '../core/cancel';
import { defaultLogFile } from '../core/log';
import type { Logger } from '../core/log';
import { canonicalPath, isInside } from '../core/paths';
import type { PausedBanner } from './banner';
import type { UxDeps } from './deps';
import { MESSAGES, msg, describeError, withSignInHint } from './pure/messages';
import { renderJournalMarkdown } from './pure/render';
import { channelLabel } from './pure/statusModel';
import type { Prompter } from './prompts';
import { openRunbookIndex } from './runbooks';
import type { StatusBar } from './statusBar';
import type { StatusTreeProvider } from './statusView';
import type { VirtualDocs } from './virtualDocs';

/** Every command id contributed in package.json. Tests assert all of them are registered. */
export const COMMAND_IDS = [
  'explainit.openTwin',
  'explainit.regenerateSection',
  'explainit.regenerateFile',
  'explainit.toggleAutoOpen',
  'explainit.backfill',
  'explainit.backfillPause',
  'explainit.backfillResume',
  'explainit.backfillCancel',
  'explainit.pauseCheckpoint',
  'explainit.resumeCheckpoint',
  'explainit.doctor',
  'explainit.setupAssistants',
  'explainit.installClaudeHook',
  'explainit.installCodexHook',
  'explainit.installCopilotSteering',
  'explainit.uninstallHooks',
  'explainit.restoreFile',
  'explainit.restoreCheckpoint',
  'explainit.showJournal',
  'explainit.verifyJournal',
  'explainit.offerSharedGitignore',
  'explainit.updateInstructions',
  'explainit.selectChannel',
  'explainit.showLogs',
  'explainit.openRunbooks',
  'explainit.showStatus',
  'explainit.refreshJournalView',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

export interface CommandContext {
  ux: UxDeps;
  prompter: Prompter;
  statusBar: StatusBar;
  banner: PausedBanner;
  statusView: StatusTreeProvider;
  virtualDocs: VirtualDocs;
  logger: Logger;
  folders: () => string[];
  runOnboarding: (opts?: { force?: boolean }) => Promise<void>;
  runDoctor: () => Promise<DoctorReport>;
  setPaused: (paused: boolean) => Promise<void>;
}

export const JOURNAL_DOC_NAME = 'ExplainIT change journal.md';
/** Installing a hook touches the assistant's config files and may probe its CLI; never hang the command. */
export const INSTALL_TIMEOUT_MS = 20_000;

export function toDocLike(doc: vscode.TextDocument): TextDocumentLike {
  return {
    uri: doc.uri.toString(),
    fsPath: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
    languageId: doc.languageId,
    getText: () => doc.getText(),
    version: doc.version,
  };
}

function titleOf(id: string): string {
  return `ExplainIT: ${id.replace(/^explainit\./, '')}`;
}

export function registerCommands(ctx: CommandContext): void {
  const { ux, prompter, logger } = ctx;
  const handlers: Record<CommandId, (...args: unknown[]) => Promise<unknown> | unknown> = {
    'explainit.openTwin': (arg) => openTwin(ctx, arg, false),
    'explainit.regenerateSection': (arg, idx) => regenerateSection(ctx, arg, idx),
    'explainit.regenerateFile': (arg) => openTwin(ctx, arg, true),
    'explainit.toggleAutoOpen': () => toggleAutoOpen(ctx),
    'explainit.backfill': () => backfill(ctx),
    'explainit.backfillPause': () => backfillPause(ctx),
    'explainit.backfillResume': () => backfillResume(ctx),
    'explainit.backfillCancel': () => backfillCancel(ctx),
    'explainit.pauseCheckpoint': () => ctx.setPaused(true),
    'explainit.resumeCheckpoint': () => ctx.setPaused(false),
    'explainit.doctor': () => ctx.runDoctor(),
    'explainit.setupAssistants': () => ctx.runOnboarding({ force: true }),
    'explainit.installClaudeHook': () => installHook(ctx, 'claude'),
    'explainit.installCodexHook': () => installHook(ctx, 'codex'),
    'explainit.installCopilotSteering': () => installCopilotSteering(ctx),
    'explainit.uninstallHooks': () => uninstallHooks(ctx),
    'explainit.restoreFile': (arg) => restoreFile(ctx, arg),
    'explainit.restoreCheckpoint': (arg) => restoreCheckpoint(ctx, arg),
    'explainit.showJournal': () => showJournal(ctx),
    'explainit.verifyJournal': () => verifyJournal(ctx),
    'explainit.offerSharedGitignore': () => offerSharedGitignore(ctx),
    'explainit.updateInstructions': () => updateInstructions(ctx),
    'explainit.selectChannel': () => selectChannel(ctx),
    'explainit.showLogs': () => showLogs(ctx),
    'explainit.openRunbooks': () => openRunbookIndex(prompter, ux.extensionPath, logger),
    'explainit.showStatus': () => showStatus(ctx),
    'explainit.refreshJournalView': () => refreshJournalView(ctx),
  };
  for (const id of COMMAND_IDS) {
    const handler = handlers[id];
    ux.disposables.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (e) {
          logger.error(`command ${id} failed`, e);
          void prompter.notify(msg('commandFailed', { command: titleOf(id), detail: withSignInHint(describeError(e)) }), 'error');
          return undefined;
        }
      }),
    );
  }
  logger.info(`registered ${COMMAND_IDS.length} commands`);
}

// --- helpers ---------------------------------------------------------------------------------

function uriFromArg(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (arg && typeof arg === 'object' && 'resourceUri' in arg && (arg as { resourceUri?: vscode.Uri }).resourceUri instanceof vscode.Uri) return (arg as { resourceUri: vscode.Uri }).resourceUri;
  if (arg && typeof arg === 'object' && 'fsPath' in arg && typeof (arg as { fsPath: unknown }).fsPath === 'string') return vscode.Uri.file((arg as { fsPath: string }).fsPath);
  return undefined;
}

async function documentFor(arg: unknown): Promise<vscode.TextDocument | undefined> {
  const uri = uriFromArg(arg);
  if (uri) return vscode.workspace.openTextDocument(uri);
  return vscode.window.activeTextEditor?.document;
}

async function pickFolder(ctx: CommandContext, key = 'folder'): Promise<string | undefined> {
  const folders = ctx.folders();
  if (!folders.length) {
    void ctx.prompter.notify(MESSAGES.noWorkspaceFolder, 'warning');
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    const f = folders.find((x) => isInside(x, active.fsPath));
    if (f) return f;
  }
  const picked = await ctx.prompter.pick(key, folders.map((f) => ({ label: path.basename(f), description: f, folder: f })), { placeHolder: 'Which folder?', testDefault: (items) => items[0] });
  return picked?.folder;
}

// --- twin commands -----------------------------------------------------------------------------

async function openTwin(ctx: CommandContext, arg: unknown, force: boolean): Promise<void> {
  const { ux, prompter } = ctx;
  let doc = await documentFor(arg);
  if (!doc) {
    void prompter.notify(MESSAGES.twinNoEditor, 'info');
    return;
  }
  if (doc.uri.scheme !== 'file') {
    void prompter.notify(MESSAGES.twinUnsupportedFile, 'warning');
    return;
  }
  if (ux.twin.isTwinPath(doc.uri.fsPath)) {
    // Asked for a twin of a twin: go to the source instead (and regenerate it when forced).
    const source = await ux.twin.sourcePathForTwin(doc.uri.fsPath);
    if (!source || !fs.existsSync(source)) {
      void prompter.notify(MESSAGES.twinSourceMissing, 'warning');
      return;
    }
    if (!force) void prompter.notify(MESSAGES.twinIsTwin, 'info');
    doc = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
    if (!force) {
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }
  }
  try {
    const result = await ux.twin.ensureTwin(toDocLike(doc), { open: true, force });
    if (!result) void prompter.notify(MESSAGES.twinUnsupportedFile, 'warning');
    else if (result.sections.length === 0) void prompter.notify(MESSAGES.twinNoFunctions, 'info');
  } catch (e) {
    void prompter.notify(msg('twinCreateFailed', { file: path.basename(doc.uri.fsPath), detail: withSignInHint(describeError(e)) }), 'error');
  }
}

async function regenerateSection(ctx: CommandContext, arg: unknown, indexArg: unknown): Promise<void> {
  const { ux, prompter } = ctx;
  const editor = vscode.window.activeTextEditor;
  const doc = (await documentFor(arg)) ?? editor?.document;
  if (!doc || doc.uri.scheme !== 'file' || !ux.twin.isTwinPath(doc.uri.fsPath)) {
    void prompter.notify(MESSAGES.regenerateNotTwin, 'warning');
    return;
  }
  let index = typeof indexArg === 'number' && indexArg > 0 ? indexArg : undefined;
  if (index === undefined) {
    const line = editor && editor.document.uri.toString() === doc.uri.toString() ? editor.selection.active.line : 0;
    const parsed = ux.twin.parseTwin(doc.getText());
    const section = parsed.sections.find((s) => line >= s.startLine && line <= s.endLine);
    index = section?.index;
  }
  if (index === undefined) {
    void prompter.notify(MESSAGES.regenerateNoSection, 'info');
    return;
  }
  await ux.twin.regenerateSection(doc.uri.fsPath, index);
  void prompter.notify(msg('regenerateDone', { index }), 'info');
}

async function toggleAutoOpen(ctx: CommandContext): Promise<boolean> {
  const next = !ctx.ux.settings.get('autoOpenTwin');
  await ctx.ux.twin.setAutoOpen(next);
  // The twin engine persists the setting; make sure it is on disk even if it only flipped memory.
  if (ctx.ux.settings.get('autoOpenTwin') !== next) await ctx.ux.settings.set('autoOpenTwin', next);
  void ctx.prompter.notify(next ? MESSAGES.autoOpenOn : MESSAGES.autoOpenOff, 'info');
  return next;
}

// --- backfill ---------------------------------------------------------------------------------

async function backfill(ctx: CommandContext): Promise<void> {
  const { ux, prompter } = ctx;
  if (!ctx.folders().length) {
    void prompter.notify(MESSAGES.backfillNoFolder, 'warning');
    return;
  }
  if (!ux.consent.granted()) {
    void prompter.notify(MESSAGES.consentNotGranted, 'warning');
    return;
  }
  if ((await ux.router.resolveChannel()) === 'none') {
    void prompter.notify(MESSAGES.noAssistantConnected, 'warning');
    return;
  }
  const status = ux.twin.backfill.status();
  if (status.state === 'running') {
    void prompter.notify(msg('backfillAlreadyRunning', { done: status.doneFiles, total: status.totalFiles }), 'info');
    return;
  }
  try {
    await ux.twin.backfill.start();
  } catch (e) {
    void prompter.notify(msg('backfillFailed', { detail: withSignInHint(describeError(e)) }), 'error');
    return;
  }
  const after = ux.twin.backfill.status();
  if (after.state === 'done') void prompter.notify(after.totalFiles === 0 ? MESSAGES.backfillNothingToDo : msg('backfillDone', { done: after.doneFiles }), 'info');
  else if (after.state === 'error') void prompter.notify(msg('backfillFailed', { detail: withSignInHint(after.error ?? 'unknown error.') }), 'error');
  else if (after.state === 'cancelled') void prompter.notify(MESSAGES.backfillCancelled, 'info');
  else if (after.state === 'paused') void prompter.notify(msg('backfillPaused', { done: after.doneFiles, total: after.totalFiles }), 'info');
}

function backfillPause(ctx: CommandContext): void {
  const b = ctx.ux.twin.backfill;
  const s = b.status();
  if (s.state !== 'running' && s.state !== 'estimating') {
    void ctx.prompter.notify(MESSAGES.backfillNotRunning, 'info');
    return;
  }
  b.pause();
  const after = b.status();
  void ctx.prompter.notify(msg('backfillPaused', { done: after.doneFiles, total: after.totalFiles }), 'info');
}

async function backfillResume(ctx: CommandContext): Promise<void> {
  const b = ctx.ux.twin.backfill;
  if (b.status().state !== 'paused') {
    void ctx.prompter.notify(MESSAGES.backfillNotPaused, 'info');
    return;
  }
  void ctx.prompter.notify(MESSAGES.backfillResumed, 'info');
  await b.resume();
}

function backfillCancel(ctx: CommandContext): void {
  const b = ctx.ux.twin.backfill;
  const s = b.status().state;
  if (s !== 'running' && s !== 'paused' && s !== 'estimating') {
    void ctx.prompter.notify(MESSAGES.backfillNotRunning, 'info');
    return;
  }
  b.cancel();
  void ctx.prompter.notify(MESSAGES.backfillCancelled, 'info');
}

// --- assistants -------------------------------------------------------------------------------

async function installHook(ctx: CommandContext, agent: 'claude' | 'codex'): Promise<void> {
  const { ux, prompter } = ctx;
  const label = agent === 'claude' ? 'Claude Code' : 'Codex';
  if (!ux.consent.granted()) {
    const ok = await prompter.ask('consent', { message: MESSAGES.onboardingTitle, detail: MESSAGES.onboardingBody, items: ['Allow', 'Not now'], modal: true, testDefault: 'Allow' });
    if (ok !== 'Allow') return;
    await ux.consent.setGranted(true);
  }
  const r = await withTimeout(ux.adapters.install(agent), INSTALL_TIMEOUT_MS, `${label} hook install`);
  if (!r.ok) {
    void prompter.notify(msg('onboardingConnectFailed', { agent: label, detail: r.detail ? describeError(r.detail) : 'the installer reported a problem.' }), 'error');
    return;
  }
  const steps = [...r.nextSteps];
  if (agent === 'codex' && !steps.some((s) => /trust/i.test(s))) steps.push(MESSAGES.codexTrustStep);
  if (!steps.some((s) => /restart/i.test(s))) steps.push(msg('restartAgentStep', { agent: label }));
  for (const f of ctx.folders()) await ux.instructions.ensure(f, { agents: [agent] }).catch((e) => ctx.logger.warn('instructions ensure failed', e));
  void prompter.notify(msg('onboardingConnected', { agent: label, steps: steps.map((s, i) => `${i + 1}. ${s}`).join(' ') }), 'info');
  void ctx.statusBar.refreshFacts();
}

async function installCopilotSteering(ctx: CommandContext): Promise<void> {
  const { ux, prompter } = ctx;
  const folders = ctx.folders();
  if (!folders.length) {
    void prompter.notify(MESSAGES.noWorkspaceFolder, 'warning');
    return;
  }
  for (const f of folders) await ux.instructions.ensure(f, { agents: ['copilot'] });
  if (!ux.copilot.running) ux.copilot.start();
  if (!ux.settings.get('copilotWatcher')) await ux.settings.set('copilotWatcher', true);
  void prompter.notify(MESSAGES.copilotSteeringDone, 'info');
}

async function uninstallHooks(ctx: CommandContext): Promise<void> {
  const { ux, prompter } = ctx;
  const answer = await prompter.ask('uninstall', {
    message: 'Remove the ExplainIT checkpoint hooks from Claude Code and Codex?',
    detail: 'Their changes will no longer stop for your review. Twins, the journal and restore points are kept.',
    items: ['Remove hooks', 'Keep them'],
    modal: true,
    testDefault: 'Remove hooks',
  });
  if (answer !== 'Remove hooks') return;
  const problems: string[] = [];
  for (const agent of ['claude', 'codex'] as AgentKind[]) {
    try {
      const r = await ux.adapters.uninstall(agent);
      if (!r.ok) problems.push(`${agent}: ${r.detail ?? 'not removed'}`);
    } catch (e) {
      problems.push(`${agent}: ${describeError(e)}`);
    }
  }
  if (problems.length) void prompter.notify(msg('hooksRemoveFailed', { detail: problems.join('; ') }), 'error');
  else void prompter.notify(MESSAGES.hooksRemoved, 'info');
  void ctx.statusBar.refreshFacts();
}

// --- restore / journal ------------------------------------------------------------------------

interface CheckpointItem extends vscode.QuickPickItem {
  checkpoint: Checkpoint;
  kit: SafetyKit;
}

async function restoreFile(ctx: CommandContext, arg: unknown): Promise<void> {
  const { ux, prompter } = ctx;
  const uri = uriFromArg(arg) ?? vscode.window.activeTextEditor?.document.uri;
  const filePath = uri?.scheme === 'file' ? canonicalPath(uri.fsPath) : undefined;
  let kit: SafetyKit | undefined = filePath ? ux.safetyFor(filePath) : undefined;
  let scopePath = filePath;
  if (!kit) {
    const folder = await pickFolder(ctx);
    if (!folder) return;
    kit = ux.safetyFor(folder);
    scopePath = undefined;
  }
  if (!kit) {
    void prompter.notify(MESSAGES.restoreNoWorkspace, 'warning');
    return;
  }
  let list = await kit.checkpoints.list(scopePath);
  if (!list.length && scopePath) {
    // Nothing for this file: offer everything in the workspace instead of a dead end.
    list = await kit.checkpoints.list();
    if (list.length) void prompter.notify(MESSAGES.restoreNoPoints, 'info');
  }
  if (!list.length) {
    void prompter.notify(scopePath ? MESSAGES.restoreNoPoints : MESSAGES.restoreNoPointsAnywhere, 'info');
    return;
  }
  const items: CheckpointItem[] = [...list]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .map((c) => ({
      label: `$(history) ${vscode.workspace.asRelativePath(c.path)}`,
      description: new Date(c.ts).toLocaleString(),
      detail: `${c.size} bytes${c.agent ? `, before a ${c.agent} change` : ''}${c.requestId ? ` (request ${c.requestId})` : ''}`,
      checkpoint: c,
      kit,
    }));
  const picked = await prompter.pick('restore', items, { placeHolder: 'Which restore point?', title: 'ExplainIT: restore a file', testDefault: (all) => all[0] });
  if (!picked) return;
  await doRestore(ctx, picked.kit, picked.checkpoint.id, picked.checkpoint.path);
}

async function restoreCheckpoint(ctx: CommandContext, arg: unknown): Promise<void> {
  const id = extractCheckpointId(arg);
  if (!id) {
    void ctx.prompter.notify(MESSAGES.restoreUnknown, 'warning');
    return;
  }
  for (const kit of ctx.ux.kits()) {
    const found = await kit.checkpoints.read(id).catch(() => undefined);
    if (found) {
      await doRestore(ctx, kit, id, found.checkpoint.path);
      return;
    }
  }
  void ctx.prompter.notify(MESSAGES.restoreUnknown, 'warning');
}

export function extractCheckpointId(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (!arg || typeof arg !== 'object') return undefined;
  const o = arg as Record<string, unknown>;
  for (const key of ['id', 'checkpointId']) if (typeof o[key] === 'string') return o[key] as string;
  const cp = o.checkpoint as Record<string, unknown> | undefined;
  if (cp && typeof cp.id === 'string') return cp.id;
  // Journal tree items carry their node: { node: { type: 'checkpoint', checkpoint: { id } } }.
  const node = o.node as { checkpoint?: { id?: unknown } } | undefined;
  if (node && typeof node.checkpoint?.id === 'string') return node.checkpoint.id;
  return undefined;
}

async function doRestore(ctx: CommandContext, kit: SafetyKit, id: string, filePath: string): Promise<void> {
  const name = path.basename(filePath);
  const confirm = await ctx.prompter.ask('restoreConfirm', {
    message: `Restore ${name} from this restore point?`,
    detail: 'The current content is saved as a new restore point first, so nothing is lost.',
    items: ['Restore', 'Cancel'],
    modal: true,
    testDefault: 'Restore',
  });
  if (confirm !== 'Restore') return;
  try {
    const r = await kit.checkpoints.restore(id);
    void ctx.prompter.notify(msg('restoreSucceeded', { file: vscode.workspace.asRelativePath(r.restoredPath) }), 'info');
    void refreshJournalView(ctx, false);
  } catch (e) {
    void ctx.prompter.notify(msg('restoreFailed', { file: name, detail: describeError(e) }), 'error');
  }
}

async function showJournal(ctx: CommandContext): Promise<void> {
  const folders = ctx.folders();
  const kits = ctx.ux.kits();
  const blocks = await Promise.all(
    kits.map(async (kit) => ({
      folder: folders.find((f) => ctx.ux.safetyFor(f) === kit) ?? path.dirname(kit.journal.file),
      file: kit.journal.file,
      entries: await kit.journal.list({ limit: 200 }).catch(() => []),
    })),
  );
  if (!blocks.some((b) => b.entries.length)) void ctx.prompter.notify(MESSAGES.journalEmpty, 'info');
  await ctx.virtualDocs.show(JOURNAL_DOC_NAME, renderJournalMarkdown(blocks), { preview: true });
}

async function verifyJournal(ctx: CommandContext): Promise<{ ok: boolean; entries: number }[]> {
  const results: { ok: boolean; entries: number }[] = [];
  for (const kit of ctx.ux.kits()) {
    try {
      const r = await kit.journal.verifyChain();
      results.push({ ok: r.ok, entries: r.entries });
      if (r.ok) void ctx.prompter.notify(r.entries === 0 ? MESSAGES.journalEmpty : msg('journalOk', { entries: r.entries }), 'info');
      else void ctx.prompter.notify(msg('journalTamper', { at: r.brokenAt ?? '?', detail: r.detail ?? 'hash mismatch.' }), 'error');
    } catch (e) {
      results.push({ ok: false, entries: 0 });
      void ctx.prompter.notify(msg('journalVerifyFailed', { detail: describeError(e) }), 'error');
    }
  }
  if (!results.length) void ctx.prompter.notify(MESSAGES.noWorkspaceFolder, 'warning');
  return results;
}

async function refreshJournalView(ctx: CommandContext, focus = true): Promise<void> {
  // The journal module owns the tree view; it publishes its refresh function on this global so the
  // ux module can trigger it without importing journal internals (see integrator request).
  const g = globalThis as { __explainitJournalRefresh?: () => void };
  try {
    g.__explainitJournalRefresh?.();
  } catch (e) {
    ctx.logger.warn('journal refresh failed', e);
  }
  if (focus) {
    try {
      await vscode.commands.executeCommand('explainit.journalView.focus');
    } catch (e) {
      ctx.logger.debug('journal view focus failed', e);
    }
  }
}

// --- misc ---------------------------------------------------------------------------------------

async function offerSharedGitignore(ctx: CommandContext): Promise<void> {
  const folder = await pickFolder(ctx);
  if (!folder) return;
  await ctx.ux.twin.offerSharedGitignore(folder);
}

async function updateInstructions(ctx: CommandContext): Promise<void> {
  const folders = ctx.folders();
  if (!folders.length) {
    void ctx.prompter.notify(MESSAGES.noWorkspaceFolder, 'warning');
    return;
  }
  const written: string[] = [];
  for (const f of folders) {
    const r = await ctx.ux.instructions.ensure(f);
    written.push(...r.written.map((w) => vscode.workspace.asRelativePath(w)));
  }
  void ctx.prompter.notify(written.length ? msg('instructionsUpdated', { written: written.join(', ') }) : MESSAGES.instructionsUnchanged, 'info');
}

async function selectChannel(ctx: CommandContext): Promise<void> {
  const { ux, prompter } = ctx;
  const channels = await ux.router.availableChannels().catch(() => []);
  const current = ux.settings.get('channelPin');
  const options: { value: 'auto' | 'copilot' | 'claude' | 'codex'; detail: string }[] = [
    { value: 'auto', detail: 'Use whichever connected assistant is available (Copilot, then Claude Code, then Codex).' },
    { value: 'copilot', detail: 'GitHub Copilot models through VS Code (uses your Copilot plan).' },
    { value: 'claude', detail: 'Claude Code terminal tool or VS Code extension (uses your Claude plan).' },
    { value: 'codex', detail: 'Codex terminal tool or VS Code extension (uses your ChatGPT plan).' },
  ];
  const items = options.map((o) => {
    const avail = o.value === 'auto' ? undefined : channels.find((c) => c.channel === o.value);
    const state = o.value === 'auto' ? '' : avail?.available ? 'ready' : `not ready${avail?.reason ? ` (${avail.reason})` : ''}`;
    return { label: `${current === o.value ? '$(check) ' : ''}${channelLabel(o.value)}`, description: state, detail: o.detail, value: o.value };
  });
  const picked = await prompter.pick('channel', items, { placeHolder: 'Which assistant should write explanations?', testDefault: (all) => all[0] });
  if (!picked) return;
  await ux.settings.set('channelPin', picked.value);
  void prompter.notify(msg('channelChanged', { channel: channelLabel(picked.value) }), 'info');
  void ctx.statusBar.refreshFacts();
}

async function showLogs(ctx: CommandContext): Promise<void> {
  const file = defaultLogFile();
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { flag: 'a' });
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (e) {
    ctx.logger.warn('could not open log file', e);
  }
  // Best effort: also bring the Output panel forward (the channel is named ExplainIT).
  try {
    await vscode.commands.executeCommand('workbench.action.output.toggleOutput');
  } catch {
    /* panel may be unavailable in tests */
  }
}

async function showStatus(ctx: CommandContext): Promise<void> {
  const { statusBar, prompter, ux } = ctx;
  await statusBar.refreshFacts();
  const view = statusBar.current;
  const facts = statusBar.facts;
  const info = ux.gate.info;
  type Item = vscode.QuickPickItem & { command?: string };
  const items: Item[] = [
    { label: view.headline, kind: vscode.QuickPickItemKind.Separator },
    { label: `$(shield) Checkpoint: ${view.state.replace('-', ' ')}`, description: info ? `127.0.0.1:${info.port}` : 'not running' },
    { label: `$(comment-discussion) ${facts.channel === 'none' ? MESSAGES.statusNoChannel : msg('statusChannel', { channel: channelLabel(facts.channel) })}` },
    { label: `$(hubot) Assistants found: ${facts.assistants.length ? facts.assistants.join(', ') : 'none'}`, description: facts.armedAgents.length ? `hooks armed: ${facts.armedAgents.join(', ')}` : 'no hooks armed' },
    { label: `$(bell) ${facts.pending > 0 ? msg('pendingReviews', { count: facts.pending }) : MESSAGES.noPendingReviews}` },
    { label: 'Actions', kind: vscode.QuickPickItemKind.Separator },
    view.state === 'paused'
      ? { label: '$(debug-start) Resume the checkpoint', command: 'explainit.resumeCheckpoint' }
      : { label: '$(debug-pause) Pause the checkpoint', command: 'explainit.pauseCheckpoint' },
    { label: '$(heart) Run the Doctor', command: 'explainit.doctor' },
    { label: '$(plug) Set up assistants', command: 'explainit.setupAssistants' },
    { label: '$(history) Show the change journal', command: 'explainit.showJournal' },
    { label: '$(question) Help: the five most likely problems', command: 'explainit.openRunbooks' },
    { label: '$(output) Show logs', command: 'explainit.showLogs' },
  ];
  const picked = await prompter.pick('status', items, { placeHolder: view.headline, title: 'ExplainIT status', testDefault: () => undefined });
  if (picked?.command) await vscode.commands.executeCommand(picked.command);
}
