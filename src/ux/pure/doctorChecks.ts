/**
 * Doctor check composition. Pure: every outside effect (file reads, HTTP, child processes, module
 * calls) is injected through `DoctorDeps`, so the composition can be unit-tested with stubs.
 *
 * Every check has a timeout so the whole report finishes in well under 15 s even when a
 * dependency hangs; checks run concurrently and the report keeps a fixed order.
 */
import type { GateSessionInfo, DetectResult, IntegrityReport, DoctorCheck, DoctorReport } from '../../core/interfaces';
import type { AdapterState, AgentKind, ChannelAvailability } from '../../core/types';
import { withTimeout } from '../../core/cancel';
import { codexHookTrust, hasTwinExclude, instructionSectionPresent, formatBytes, type HookOutcome } from './parsers';

export interface HealthProbeResult {
  ok: boolean;
  version?: string;
  paused?: boolean;
  pid?: number;
  error?: string;
}

export interface KitProbe {
  folder: string;
  verifyChain: () => Promise<{ ok: boolean; entries: number; brokenAt?: number; detail?: string }>;
  selfTest: () => Promise<{ ok: boolean; detail: string }>;
}

export interface InstructionFileProbe {
  agent: AgentKind;
  file: string;
  text: string | undefined;
}

export interface DoctorFixes {
  runOnboarding: () => Promise<void>;
  installHook: (agent: AgentKind) => Promise<void>;
  rearm: () => Promise<void>;
  addGitExclude: (folder: string) => Promise<void>;
  updateInstructions: (folder: string) => Promise<void>;
  resumeCheckpoint: () => Promise<void>;
  resetWatchdog: () => Promise<void>;
}

export interface DoctorDeps {
  consentGranted: () => boolean;
  detect: () => Promise<DetectResult[]>;
  channels: () => Promise<ChannelAvailability[]>;
  gateInfo: () => GateSessionInfo | undefined;
  gatePaused: () => boolean;
  healthProbe: (port: number) => Promise<HealthProbeResult>;
  /** Parsed `<home>/sessions/<pid>.json`, or undefined when missing/unreadable. */
  readSessionFile: (pid: number) => Promise<GateSessionInfo | undefined>;
  verifyIntegrity: () => Promise<IntegrityReport>;
  adapterStates: () => Promise<AdapterState[]>;
  /** `~/.codex/config.toml` text, undefined when the file does not exist. */
  codexConfigText: () => Promise<string | undefined>;
  hookLiveTest: (folder: string) => Promise<HookOutcome>;
  folders: string[];
  kits: KitProbe[];
  /** 'no-git' when the folder is not a git repository. */
  gitExcludeText: (folder: string) => Promise<string | undefined | 'no-git'>;
  instructionFiles: (folder: string) => Promise<InstructionFileProbe[]>;
  sectionText: (agent: AgentKind) => string;
  watchdogSeconds: number;
  /** Free bytes on the volume that holds the ExplainIT home folder. */
  freeBytes: () => Promise<number>;
  checkpointsMaxTotalMB: number;
  fixes: DoctorFixes;
  checkTimeoutMs?: number;
  liveTestTimeoutMs?: number;
  now?: () => Date;
}

export const WATCHDOG_MIN_SECONDS = 30;
export const WATCHDOG_MAX_SECONDS = 600;
export const DEFAULT_CHECK_TIMEOUT_MS = 6_000;
export const DEFAULT_LIVE_TEST_TIMEOUT_MS = 8_000;

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot' };

function check(name: string, ok: boolean, detail: string, fix?: DoctorCheck['fix']): DoctorCheck {
  return fix ? { name, ok, detail, fix } : { name, ok, detail };
}

function describe(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.trim() || 'unknown error';
}

// --- individual checks (exported for unit tests) ---------------------------------------------

export function checkConsent(d: DoctorDeps): DoctorCheck {
  const ok = d.consentGranted();
  return check(
    'Permission to use your assistants',
    ok,
    ok
      ? 'You allowed ExplainIT to use the assistants you already have.'
      : 'You have not allowed ExplainIT to use your assistants yet, so no explanations can be written.',
    ok ? undefined : { label: 'Run setup', run: d.fixes.runOnboarding },
  );
}

export async function checkAssistants(d: DoctorDeps): Promise<DoctorCheck> {
  const results = await d.detect();
  const present = results.filter((r) => r.present);
  const lines = results.map((r) => {
    const where = r.location ? ` at ${r.location}` : '';
    const state = r.present ? (r.ready === false ? 'found, not signed in' : 'found') : 'not found';
    const version = r.version ? ` (${r.version})` : '';
    return `${AGENT_LABEL[r.agent]}: ${state}${version}${where}${r.detail ? ` — ${r.detail}` : ''}`;
  });
  const ok = present.length > 0;
  return check(
    'Assistants detected (terminal tools and VS Code extensions)',
    ok,
    ok ? lines.join('; ') : `No assistant was found. ${lines.join('; ') || 'Nothing to list.'} Install Claude Code, Codex or Copilot and sign in.`,
    ok ? undefined : { label: 'Run setup', run: d.fixes.runOnboarding },
  );
}

export async function checkChannels(d: DoctorDeps): Promise<DoctorCheck> {
  const channels = await d.channels();
  const available = channels.filter((c) => c.available);
  const lines = channels.map((c) => `${c.channel}: ${c.available ? 'ready' : `not ready${c.reason ? ` (${c.reason})` : ''}`}`);
  const ok = available.length > 0;
  return check(
    'An assistant can write explanations',
    ok,
    ok ? `Ready: ${available.map((c) => c.channel).join(', ')}. ${lines.join('; ')}` : `No assistant can write explanations right now. ${lines.join('; ')}`,
    ok ? undefined : { label: 'Run setup', run: d.fixes.runOnboarding },
  );
}

export function checkGateListening(d: DoctorDeps): DoctorCheck {
  const info = d.gateInfo();
  if (!info) {
    return check('Checkpoint is listening', false, 'The local checkpoint is not running in this window. Reload the window; if it keeps failing, look at "ExplainIT: Show logs".');
  }
  if (d.gatePaused()) {
    return check('Checkpoint is listening', false, `The checkpoint is listening on 127.0.0.1:${info.port} but it is paused, so assistants use their own prompts.`, {
      label: 'Resume the checkpoint',
      run: d.fixes.resumeCheckpoint,
    });
  }
  return check('Checkpoint is listening', true, `Listening on 127.0.0.1:${info.port} for this window (process ${info.pid}), armed.`);
}

export async function checkGateHealth(d: DoctorDeps): Promise<DoctorCheck> {
  const info = d.gateInfo();
  if (!info) return check('Checkpoint answers over HTTP', false, 'Skipped: the checkpoint is not running.');
  const r = await d.healthProbe(info.port);
  if (!r.ok) return check('Checkpoint answers over HTTP', false, `GET http://127.0.0.1:${info.port}/v1/health did not answer: ${r.error ?? 'no response'}. Reload the window.`);
  const pidNote = r.pid !== undefined && r.pid !== info.pid ? ` Warning: the answering process is ${r.pid}, not this window's ${info.pid}.` : '';
  return check('Checkpoint answers over HTTP', pidNote === '', `Health probe answered${r.version ? ` (version ${r.version})` : ''}${r.paused ? ', paused' : ''}.${pidNote}`);
}

export async function checkSessionFile(d: DoctorDeps): Promise<DoctorCheck> {
  const info = d.gateInfo();
  if (!info) return check('Session file for hook scripts', false, 'Skipped: the checkpoint is not running.');
  const file = await d.readSessionFile(info.pid);
  if (!file) return check('Session file for hook scripts', false, `The session file for process ${info.pid} is missing or unreadable, so hook scripts cannot find this window. Reload the window.`);
  if (file.port !== info.port) return check('Session file for hook scripts', false, `The session file says port ${file.port} but the checkpoint listens on ${info.port}. Reload the window.`);
  const folders = file.folders?.length ? file.folders.join(', ') : 'no folders';
  return check('Session file for hook scripts', true, `Present for process ${info.pid}, port ${info.port}, covering ${folders}.`);
}

/** Integrity of hook script + wrapper + config for one agent, based on the adapter integrity report. */
export function hookIntegrityCheck(agent: 'claude' | 'codex', detect: DetectResult[], states: AdapterState[], integrity: IntegrityReport, d: DoctorDeps): DoctorCheck {
  const label = AGENT_LABEL[agent];
  const name = `${label} checkpoint hook`;
  const present = detect.some((r) => r.agent === agent && r.present);
  const state = states.find((s) => s.agent === agent);
  const own = integrity.checks.filter((c) => c.name.toLowerCase().includes(agent));
  const shared = integrity.checks.filter((c) => !/claude|codex|copilot/i.test(c.name));
  const relevant = [...own, ...shared];
  const failed = relevant.filter((c) => !c.ok);

  if (!present && !state?.installed) {
    return check(name, true, `${label} is not installed on this computer, so there is no hook to check.`);
  }
  if (!state?.installed) {
    // Present but never connected. The adapter may still report an informational "not connected" line
    // for this agent; whatever it says, the fix is to install, not to re-arm.
    return check(name, false, `${label} was found but the ExplainIT hook is not installed, so its changes are not stopped for review.`, {
      label: `Install the ${label} hook`,
      run: () => d.fixes.installHook(agent),
    });
  }
  if (failed.length) {
    return check(name, false, `Problems: ${failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}. The hook, its wrapper or its config entry was changed.`, {
      label: 'Re-arm the hooks',
      run: d.fixes.rearm,
    });
  }
  const armed = state?.armed !== false;
  const notes = state?.notes?.length ? ` ${state.notes.join(' ')}` : '';
  return check(name, armed, armed ? `Installed and armed (script, wrapper and user-level config verified by hash).${notes}` : `Installed but not armed.${notes}`, armed ? undefined : { label: 'Re-arm the hooks', run: d.fixes.rearm });
}

export async function checkHookIntegrity(d: DoctorDeps): Promise<DoctorCheck[]> {
  const [detect, states, integrity] = await Promise.all([d.detect(), d.adapterStates(), d.verifyIntegrity()]);
  return [hookIntegrityCheck('claude', detect, states, integrity, d), hookIntegrityCheck('codex', detect, states, integrity, d)];
}

export async function checkCodexTrust(d: DoctorDeps): Promise<DoctorCheck> {
  const name = 'Codex trusts the ExplainIT hook';
  const [detect, states] = await Promise.all([d.detect(), d.adapterStates()]);
  const present = detect.some((r) => r.agent === 'codex' && r.present);
  const installed = states.find((s) => s.agent === 'codex')?.installed === true;
  if (!present && !installed) return check(name, true, 'Codex is not installed on this computer, so there is nothing to trust.');
  if (!installed) return check(name, false, 'The Codex hook is not installed yet, so Codex has nothing to trust.', { label: 'Install the Codex hook', run: () => d.fixes.installHook('codex') });
  const trust = codexHookTrust(await d.codexConfigText());
  switch (trust) {
    case 'trusted':
      return check(name, true, 'Codex recorded the ExplainIT hook as trusted in ~/.codex/config.toml (shared by the terminal tool and the VS Code extension).');
    case 'untrusted':
      return check(name, false, 'Codex recorded the ExplainIT hook as NOT trusted, so it will not run. Start Codex once and choose "trust" when it asks about the ExplainIT hook.');
    case 'no-config':
      return check(name, false, 'Codex has no ~/.codex/config.toml yet, so it has not trusted the hook. Start Codex once (terminal or extension) and choose "trust" when asked.');
    default:
      return check(name, false, 'Codex has not recorded a trust decision for the ExplainIT hook. Start Codex once (terminal or extension) and choose "trust" when it asks. Until then Codex changes are not stopped for review.');
  }
}

export async function checkHookWiring(d: DoctorDeps): Promise<DoctorCheck> {
  const name = 'Hook wiring live test';
  const folder = d.folders[0];
  if (!folder) return check(name, false, 'Skipped: open a folder so the hook can target a file inside it.');
  if (!d.gateInfo()) return check(name, false, 'Skipped: the checkpoint is not running.');
  if (d.gatePaused()) return check(name, false, 'Skipped: the checkpoint is paused, so hooks get no answer by design.', { label: 'Resume the checkpoint', run: d.fixes.resumeCheckpoint });
  const outcome = await d.hookLiveTest(folder);
  if (outcome.answered) {
    return check(name, true, `The hook script reached the checkpoint and got an answer (${outcome.decision}) for a synthetic twin-file write. Nothing was written.`);
  }
  return check(name, false, `The hook script did not get an answer from the checkpoint: ${outcome.problem ?? 'unknown problem'}. Reload the window and run the Doctor again.`, {
    label: 'Re-arm the hooks',
    run: d.fixes.rearm,
  });
}

export async function checkJournal(kit: KitProbe): Promise<DoctorCheck> {
  const name = `Change journal intact (${shortFolder(kit.folder)})`;
  const r = await kit.verifyChain();
  if (r.ok) return check(name, true, r.entries === 0 ? 'The journal is empty; nothing to verify yet.' : `${r.entries} entries verified; the hash chain is intact.`);
  return check(name, false, `The journal hash chain is broken at entry ${r.brokenAt ?? '?'}${r.detail ? ` (${r.detail})` : ''}. Entries after that point cannot be trusted. Keep the file for inspection.`);
}

export async function checkRestore(kit: KitProbe): Promise<DoctorCheck> {
  const name = `Restore point self-test (${shortFolder(kit.folder)})`;
  const r = await kit.selfTest();
  return check(name, r.ok, r.ok ? `A restore point was saved and restored on a scratch file. ${r.detail}` : `Restore points cannot be trusted right now: ${r.detail}. Check free disk space and folder permissions.`);
}

export async function checkGitExclude(folder: string, d: DoctorDeps): Promise<DoctorCheck> {
  const name = `Twins kept out of git (${shortFolder(folder)})`;
  const text = await d.gitExcludeText(folder);
  if (text === 'no-git') return check(name, true, 'This folder is not a git repository, so there is nothing to exclude.');
  if (hasTwinExclude(text)) return check(name, true, '.git/info/exclude ignores *_explain.txt, so twins never reach GitHub.');
  return check(name, false, '.git/info/exclude does not ignore *_explain.txt yet, so twins could be committed by mistake.', { label: 'Add the exclude entry', run: () => d.fixes.addGitExclude(folder) });
}

export async function checkInstructions(folder: string, d: DoctorDeps): Promise<DoctorCheck> {
  const name = `Assistant instruction sections (${shortFolder(folder)})`;
  const files = await d.instructionFiles(folder);
  const missing = files.filter((f) => !instructionSectionPresent(f.text, d.sectionText(f.agent)));
  if (!files.length) return check(name, true, 'No instruction files are expected for this folder.');
  if (!missing.length) return check(name, true, `Present in ${files.map((f) => f.file).join(', ')}.`);
  return check(name, false, `Missing the ExplainIT section in ${missing.map((f) => f.file).join(', ')}. Assistants are still stopped by the checkpoint, but they are not steered to work one function at a time.`, {
    label: 'Update instruction files',
    run: () => d.fixes.updateInstructions(folder),
  });
}

export function checkWatchdog(d: DoctorDeps): DoctorCheck {
  const s = d.watchdogSeconds;
  const sane = Number.isFinite(s) && s >= WATCHDOG_MIN_SECONDS && s <= WATCHDOG_MAX_SECONDS;
  return check(
    'Fallback timer (watchdog) is sensible',
    sane,
    sane
      ? `If ExplainIT stops responding, assistants fall back to their own prompt after ${s} seconds.`
      : `The watchdog is set to ${String(s)} seconds; it must be between ${WATCHDOG_MIN_SECONDS} and ${WATCHDOG_MAX_SECONDS}. Too low and reviews get cut off; too high and a stuck window hangs the assistant.`,
    sane ? undefined : { label: 'Reset to 120 seconds', run: d.fixes.resetWatchdog },
  );
}

export async function checkDiskSpace(d: DoctorDeps): Promise<DoctorCheck> {
  const free = await d.freeBytes();
  const needed = Math.max(50, d.checkpointsMaxTotalMB) * 1024 * 1024;
  const ok = free >= needed;
  return check(
    'Free disk space for restore points',
    ok,
    ok
      ? `${formatBytes(free)} free; restore points may use up to ${d.checkpointsMaxTotalMB} MB.`
      : `Only ${formatBytes(free)} free, but restore points may need up to ${d.checkpointsMaxTotalMB} MB. Free some space or lower "explainit.restorePoints.maxTotalMB".`,
  );
}

// --- composition -----------------------------------------------------------------------------

type Producer = () => Promise<DoctorCheck | DoctorCheck[]> | DoctorCheck | DoctorCheck[];

async function guarded(name: string, produce: Producer, timeoutMs: number): Promise<DoctorCheck[]> {
  try {
    const out = await withTimeout(Promise.resolve().then(produce), timeoutMs, name);
    return Array.isArray(out) ? out : [out];
  } catch (e) {
    const m = describe(e);
    const timedOut = /timed out/i.test(m);
    return [check(name, false, timedOut ? `This check did not finish within ${Math.round(timeoutMs / 1000)} seconds. Something it depends on is stuck; reload the window and try again.` : `This check failed: ${m}`)];
  }
}

export async function runDoctorChecks(d: DoctorDeps): Promise<DoctorReport> {
  const t = d.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const tl = d.liveTestTimeoutMs ?? DEFAULT_LIVE_TEST_TIMEOUT_MS;
  const groups: Promise<DoctorCheck[]>[] = [
    guarded('Permission to use your assistants', () => checkConsent(d), t),
    guarded('Assistants detected (terminal tools and VS Code extensions)', () => checkAssistants(d), t),
    guarded('An assistant can write explanations', () => checkChannels(d), t),
    guarded('Checkpoint is listening', () => checkGateListening(d), t),
    guarded('Checkpoint answers over HTTP', () => checkGateHealth(d), t),
    guarded('Session file for hook scripts', () => checkSessionFile(d), t),
    guarded('Checkpoint hooks', () => checkHookIntegrity(d), t),
    guarded('Codex trusts the ExplainIT hook', () => checkCodexTrust(d), t),
    guarded('Hook wiring live test', () => checkHookWiring(d), tl),
    ...d.kits.map((k) => guarded(`Change journal intact (${shortFolder(k.folder)})`, () => checkJournal(k), t)),
    ...d.kits.map((k) => guarded(`Restore point self-test (${shortFolder(k.folder)})`, () => checkRestore(k), t)),
    ...d.folders.map((f) => guarded(`Twins kept out of git (${shortFolder(f)})`, () => checkGitExclude(f, d), t)),
    ...d.folders.map((f) => guarded(`Assistant instruction sections (${shortFolder(f)})`, () => checkInstructions(f, d), t)),
    guarded('Fallback timer (watchdog) is sensible', () => checkWatchdog(d), t),
    guarded('Free disk space for restore points', () => checkDiskSpace(d), t),
  ];
  const checks = (await Promise.all(groups)).flat();
  return { ok: checks.every((c) => c.ok), checks, ranAt: (d.now ?? (() => new Date()))().toISOString() };
}

/** Run every available fix once, in report order. Returns the names that were fixed and any failures. */
export async function applyAllFixes(report: DoctorReport): Promise<{ applied: string[]; failed: { name: string; detail: string }[] }> {
  const applied: string[] = [];
  const failed: { name: string; detail: string }[] = [];
  const seen = new Set<() => Promise<void>>();
  for (const c of report.checks) {
    if (c.ok || !c.fix) continue;
    // Several checks share one fix function (e.g. "Re-arm the hooks"); run it once. Per-folder fixes
    // are distinct closures and therefore run once per folder.
    if (seen.has(c.fix.run)) continue;
    seen.add(c.fix.run);
    try {
      await c.fix.run();
      applied.push(c.name);
    } catch (e) {
      failed.push({ name: c.name, detail: describe(e) });
    }
  }
  return { applied, failed };
}

export function shortFolder(folder: string): string {
  const parts = folder.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || folder;
}
