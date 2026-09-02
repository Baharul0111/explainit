/**
 * Shared machinery for the Claude Code and Codex hook adapters: copies the hook script into
 * <home>/hooks, writes the wrappers, edits the agent's config surgically, records hashes in
 * state.json and verifies all of it. No `vscode` import here so it is unit-testable in plain Node;
 * host lookups (installed extensions, language models) come in through `HostProbe`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256 } from '../core/hash';
import type { DetectResult, InstallResult, IntegrityReport } from '../core/interfaces';
import type { Logger } from '../core/log';
import { HOME_LAYOUT, ensureDir, explainitHome } from '../core/paths';
import type { Settings } from '../core/settings';
import type { AdapterRecord, StateStore } from '../core/state';
import type { AgentKind } from '../core/types';
import { entriesMatch, findOurEntries, parseJsonFile, removeOurEntries, stringifyJsonFile, upsertOurEntries, configHashFor, type HookEntrySpec, type HookPins } from './pure/hookConfig';
import { cmdQuote, HOOK_SCRIPT, shQuote, wrapperNameFor } from './pure/wrappers';
import { atomicWrite, resolveNodeRuntime, writeWrappers, type NodeRuntime } from './runtime';
import { extensionRoots, pickExtensionDir, type ExtensionDir } from './pure/extensionDirs';

export type IntegrityCheck = IntegrityReport['checks'][number];

export interface HostProbe {
  /** vscode.extensions.getExtension(id) when running inside VS Code; undefined otherwise. */
  findExtension(id: string): ExtensionDir | undefined;
  /** Number of Copilot chat models vscode.lm reports (undefined when unavailable). Must never trigger consent. */
  copilotModelCount(): Promise<number | undefined>;
}

export interface AdapterEnv {
  logger: Logger;
  settings: Settings;
  extensionPath: string;
  version: string;
  state: StateStore;
  probe: HostProbe;
  explainitHome: string;
  hooksDir: string;
  userHome: string;
  /** Codex's home when the person set CODEX_HOME (Codex honours it); undefined means <userHome>/.codex. */
  codexHome?: string;
  platform: NodeJS.Platform;
  arch: string;
}

/** Codex keeps everything under CODEX_HOME when that is set, else ~/.codex (shared by the CLI and the VS Code extension). */
export function codexHomeDir(env: Pick<AdapterEnv, 'userHome' | 'codexHome'>): string {
  return env.codexHome ?? path.join(env.userHome, '.codex');
}

/** Claude Code's user-layer folder (settings.json, settings.local.json). */
export function claudeHomeDir(env: Pick<AdapterEnv, 'userHome'>): string {
  return path.join(env.userHome, '.claude');
}

/** The absolute locations baked into the hook command so the hook never trusts environment variables for them. */
export function hookPins(env: AdapterEnv): HookPins {
  return {
    explainitHome: env.explainitHome,
    claudeHome: claudeHomeDir(env),
    codexHome: codexHomeDir(env),
    platform: env.platform,
    codexUnresponsive: env.settings.get('gateCodexUnresponsive') === 'passthrough' ? 'passthrough' : 'deny',
  };
}

/** CODEX_HOME is honoured only for the real user home; test homes always use <userHome>/.codex. */
export function codexHomeOverride(userHome: string): string | undefined {
  const raw = process.env.CODEX_HOME;
  if (!raw || !raw.trim() || userHome !== os.homedir()) return undefined;
  return path.resolve(raw.trim());
}

/**
 * Where the agents' user-layer config lives. `EXPLAINIT_USER_HOME` overrides it; in test mode
 * without an override it is a folder inside the ExplainIT home so tests never touch the real
 * ~/.claude or ~/.codex.
 */
export function userHomeDir(): string {
  const override = process.env.EXPLAINIT_USER_HOME;
  if (override && override.trim()) return path.resolve(override);
  if (process.env.EXPLAINIT_TEST_MODE === '1') return path.join(explainitHome(), 'user-home');
  return os.homedir();
}

export function makeAdapterEnv(core: { logger: Logger; settings: Settings; extensionPath: string; version: string }, state: StateStore, probe: HostProbe, overrides: Partial<AdapterEnv> = {}): AdapterEnv {
  const userHome = overrides.userHome ?? userHomeDir();
  return {
    ...core,
    state,
    probe,
    explainitHome: explainitHome(),
    hooksDir: HOME_LAYOUT.hooks(),
    userHome,
    codexHome: codexHomeOverride(userHome),
    platform: process.platform,
    arch: process.arch,
    ...overrides,
  };
}

export function fileHash(file: string): string | undefined {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function bundledScriptPath(env: AdapterEnv): string {
  return path.join(env.extensionPath, 'hooks', HOOK_SCRIPT);
}

export function installedScriptPath(env: AdapterEnv): string {
  return path.join(env.hooksDir, HOOK_SCRIPT);
}

export function installedWrapperPath(env: AdapterEnv): string {
  return path.join(env.hooksDir, wrapperNameFor(env.platform));
}

/** Copies hooks/explainit-hook.js from the extension into <home>/hooks. Returns its hash. */
export function installScript(env: AdapterEnv): string {
  const src = bundledScriptPath(env);
  let content: Buffer;
  try {
    content = fs.readFileSync(src);
  } catch {
    throw new Error(`The hook script is missing from the ExplainIT install (${src}). Reinstall the ExplainIT extension and try again.`);
  }
  ensureDir(env.hooksDir);
  atomicWrite(installedScriptPath(env), content, 0o644);
  return sha256(content);
}

export interface InstalledWrappers {
  wrapperPath: string;
  wrapperHash: string;
  runtime: NodeRuntime;
}

export function installWrappers(env: AdapterEnv): InstalledWrappers {
  const runtime = resolveNodeRuntime({ platform: env.platform, homeDir: env.userHome });
  const written = writeWrappers(env.hooksDir, runtime, installedScriptPath(env), env.explainitHome);
  const chosen = env.platform === 'win32' ? written.cmd : written.sh;
  return { wrapperPath: chosen.path, wrapperHash: chosen.hash, runtime };
}

/** The wrapper path quoted for the shell the agent uses to run hook commands. */
export function quotedWrapper(env: AdapterEnv, wrapperPath: string): string {
  return env.platform === 'win32' ? cmdQuote(wrapperPath) : shQuote(wrapperPath);
}

export function friendlyPath(env: AdapterEnv, p: string): string {
  const rel = path.relative(env.userHome, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? '~' + path.sep + rel : p;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function parseOrThrow(env: AdapterEnv, file: string) {
  const text = readText(file);
  const parsed = parseJsonFile(text);
  if (!parsed.value) {
    throw new Error(`${friendlyPath(env, file)} is not valid JSON (${parsed.error}). Fix or move that file aside, then run Connect again.`);
  }
  return { text, parsed, root: parsed.value };
}

/** Adds/replaces our hook entries in `file` (created when missing). Keeps a one-time backup beside it. */
export function upsertConfigFile(env: AdapterEnv, file: string, specs: HookEntrySpec[]): boolean {
  const { text, parsed, root } = parseOrThrow(env, file);
  const changed = upsertOurEntries(root, specs);
  if (!changed) return false;
  if (text !== undefined && !fs.existsSync(file + '.explainit-backup')) {
    try {
      fs.writeFileSync(file + '.explainit-backup', text);
    } catch {
      /* best effort */
    }
  }
  atomicWrite(file, stringifyJsonFile(root, parsed), 0o644);
  return true;
}

export function removeFromConfigFile(env: AdapterEnv, file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const { parsed, root } = parseOrThrow(env, file);
  const changed = removeOurEntries(root);
  if (changed) atomicWrite(file, stringifyJsonFile(root, parsed), 0o644);
  return changed;
}

export function configHasOurEntries(file: string): boolean {
  const parsed = parseJsonFile(readText(file));
  return !!parsed.value && findOurEntries(parsed.value).length > 0;
}

export function verifyConfigFile(env: AdapterEnv, file: string, specs: HookEntrySpec[]): IntegrityCheck {
  const label = friendlyPath(env, file);
  const text = readText(file);
  if (text === undefined) return { name: label, ok: false, fixable: true, detail: `${label} does not exist, so the checkpoint hook is not wired in. Rearm or run Connect to write it.` };
  const parsed = parseJsonFile(text);
  if (!parsed.value) return { name: label, ok: false, fixable: false, detail: `${label} is not valid JSON (${parsed.error}); the assistant cannot load any hooks from it. Fix the file by hand, then run the Doctor again.` };
  const m = entriesMatch(parsed.value, specs);
  return { name: label, ok: m.ok, fixable: !m.ok, detail: m.ok ? `Checkpoint hook entries present and unchanged in ${label}.` : `${label}: ${m.detail} Rearm rewrites the ExplainIT entries and leaves everything else alone.` };
}

/** Script / wrapper / runtime checks shared by both agents. */
export function fileChecks(env: AdapterEnv, label: string, rec: AdapterRecord): IntegrityCheck[] {
  const checks: IntegrityCheck[] = [];
  const script = installedScriptPath(env);
  const scriptHash = fileHash(script);
  if (!scriptHash) checks.push({ name: `${label} hook script`, ok: false, fixable: true, detail: `The hook script is missing (${script}). Rearm copies it back.` });
  else if (rec.scriptHash && scriptHash !== rec.scriptHash) checks.push({ name: `${label} hook script`, ok: false, fixable: true, detail: `The hook script at ${script} was changed since ExplainIT installed it. Rearm restores the original.` });
  else checks.push({ name: `${label} hook script`, ok: true, detail: 'Hook script present and unchanged.' });

  const bundled = fileHash(bundledScriptPath(env));
  // Only meaningful when the installed script is intact (tampering is reported above).
  if (scriptHash && bundled && bundled !== scriptHash && scriptHash === rec.scriptHash) {
    checks.push({ name: `${label} hook script up to date`, ok: false, fixable: true, detail: 'ExplainIT was updated and ships a newer hook script. Rearm installs it.' });
  }

  const wrapper = rec.wrapperPath || installedWrapperPath(env);
  const wrapperHash = fileHash(wrapper);
  if (!wrapperHash) checks.push({ name: `${label} hook wrapper`, ok: false, fixable: true, detail: `The wrapper script is missing (${wrapper}). Rearm writes it again.` });
  else if (rec.wrapperHash && wrapperHash !== rec.wrapperHash) checks.push({ name: `${label} hook wrapper`, ok: false, fixable: true, detail: `The wrapper script at ${wrapper} was changed since ExplainIT wrote it. Rearm restores it.` });
  else checks.push({ name: `${label} hook wrapper`, ok: true, detail: 'Wrapper script present and unchanged.' });

  if (rec.runtime) {
    if (isFile(rec.runtime)) checks.push({ name: `${label} hook runtime`, ok: true, detail: `Node runtime: ${rec.runtime}` });
    else checks.push({ name: `${label} hook runtime`, ok: false, fixable: true, detail: `The Node runtime the hook uses is gone (${rec.runtime}). Rearm picks a new one.` });
  }
  return checks;
}

/** Finds an extension folder through the host first, then by scanning the usual extension roots on disk. */
export function findExtensionDir(env: AdapterEnv, id: string): ExtensionDir | undefined {
  const viaHost = env.probe.findExtension(id);
  if (viaHost) return viaHost;
  for (const root of extensionRoots(env.userHome === os.homedir() ? env.userHome : os.homedir())) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    const hit = pickExtensionDir(root, entries, id);
    if (hit) return hit;
  }
  return undefined;
}

export interface AgentAdapterSpec {
  agent: AgentKind;
  label: string;
  configPath(env: AdapterEnv): string;
  specs(quotedWrapper: string, watchdog: number, pins: HookPins): HookEntrySpec[];
  nextSteps(env: AdapterEnv, changed: boolean): string[];
}

/** Install / uninstall / verify shared by Claude Code and Codex. */
export class HookAgentBase {
  constructor(protected readonly env: AdapterEnv, protected readonly spec: AgentAdapterSpec) {}

  get agent(): AgentKind {
    return this.spec.agent;
  }

  configPath(): string {
    return this.spec.configPath(this.env);
  }

  record(): AdapterRecord | undefined {
    return this.env.state.read().adapters?.[this.spec.agent];
  }

  isInstalled(): boolean {
    return !!this.record() || configHasOurEntries(this.configPath());
  }

  specsFor(wrapperPath: string): HookEntrySpec[] {
    return this.spec.specs(quotedWrapper(this.env, wrapperPath), this.env.settings.get('gateWatchdogSeconds'), hookPins(this.env));
  }

  async install(): Promise<InstallResult> {
    const log = this.env.logger;
    try {
      const scriptHash = installScript(this.env);
      const w = installWrappers(this.env);
      const specs = this.specsFor(w.wrapperPath);
      const file = this.configPath();
      const changed = upsertConfigFile(this.env, file, specs);
      const previous = this.record();
      await this.env.state.update((s) => {
        s.adapters = s.adapters ?? {};
        s.adapters[this.spec.agent] = {
          installedAt: previous?.installedAt ?? new Date().toISOString(),
          scriptHash,
          wrapperHash: w.wrapperHash,
          configHash: configHashFor(specs),
          configPath: file,
          wrapperPath: w.wrapperPath,
          runtime: w.runtime.path,
        };
      });
      log.info(`${this.spec.label} hook ${changed ? 'installed' : 'already installed'}`, { config: file, runtime: w.runtime.path, source: w.runtime.source });
      return {
        agent: this.spec.agent,
        ok: true,
        changed,
        nextSteps: this.spec.nextSteps(this.env, changed),
        detail: `Hook entries written to ${friendlyPath(this.env, file)}; hook script at ${installedScriptPath(this.env)} (runtime: ${w.runtime.path}).`,
      };
    } catch (e) {
      log.error(`${this.spec.label} hook install failed`, e);
      return { agent: this.spec.agent, ok: false, changed: false, nextSteps: [], detail: (e as Error).message };
    }
  }

  async uninstall(): Promise<InstallResult> {
    try {
      const file = this.configPath();
      const changed = removeFromConfigFile(this.env, file);
      await this.env.state.update((s) => {
        if (s.adapters) delete s.adapters[this.spec.agent];
      });
      this.env.logger.info(`${this.spec.label} hook removed`, { config: file, changed });
      return { agent: this.spec.agent, ok: true, changed, nextSteps: [`${this.spec.label} now uses its own permission prompts for file changes.`], detail: changed ? `ExplainIT entries removed from ${friendlyPath(this.env, file)}; other hooks were left in place.` : 'No ExplainIT entries were present.' };
    } catch (e) {
      this.env.logger.error(`${this.spec.label} hook uninstall failed`, e);
      return { agent: this.spec.agent, ok: false, changed: false, nextSteps: [], detail: (e as Error).message };
    }
  }

  /** Fast, synchronous, never throws. */
  verify(): IntegrityCheck[] {
    const label = this.spec.label;
    try {
      const rec = this.record();
      const file = this.configPath();
      if (!rec) {
        if (configHasOurEntries(file)) {
          return [{ name: `${label} hook`, ok: false, fixable: true, detail: `${friendlyPath(this.env, file)} contains ExplainIT hook entries but ExplainIT has no record of installing them. Rearm re-installs and records them.` }];
        }
        return [{ name: `${label} hook`, ok: true, detail: `Not connected. Run "ExplainIT: Connect ${label}" to arm the checkpoint.` }];
      }
      const checks = fileChecks(this.env, label, rec);
      checks.push(verifyConfigFile(this.env, file, this.specsFor(rec.wrapperPath || installedWrapperPath(this.env))));
      checks.push(...this.extraChecks(rec));
      return checks;
    } catch (e) {
      return [{ name: `${label} hook`, ok: false, fixable: false, detail: `Integrity check failed unexpectedly: ${(e as Error).message}` }];
    }
  }

  protected extraChecks(_rec: AdapterRecord): IntegrityCheck[] {
    return [];
  }

  /** Re-writes whatever a failed, fixable check complained about. Returns true when something was rewritten. */
  async rearm(): Promise<boolean> {
    if (!this.isInstalled()) return false;
    const failed = this.verify().filter((c) => !c.ok && c.fixable);
    if (failed.length === 0) return false;
    this.env.logger.warn(`${this.spec.label}: re-arming the checkpoint hook`, { reasons: failed.map((c) => c.detail) });
    const r = await this.install();
    return r.ok;
  }

  async detect(): Promise<DetectResult> {
    return { agent: this.spec.agent, present: false };
  }
}
