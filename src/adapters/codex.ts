/**
 * Codex adapter: user-layer hooks in ~/.codex/hooks.json (apply_patch|Edit|Write|Bash). Codex only
 * runs hooks the person has trusted; trust is recorded in ~/.codex/config.toml [hooks.state] and is
 * shared by the CLI and the Codex VS Code extension (REQ-017, REQ-022).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DetectResult } from '../core/interfaces';
import type { AdapterRecord } from '../core/state';
import { HookAgentBase, findExtensionDir, friendlyPath, isFile, type AdapterEnv, type AgentAdapterSpec, type IntegrityCheck } from './installer';
import { codexEntrySpecs, findOurEntries, parseJsonFile } from './pure/hookConfig';
import { codexHookHash, lookupTrust, parseHookStates, type TrustLookup } from './pure/codexTrust';
import { findOnPath, splitCliValue } from './pure/pathLookup';
import { CODEX_EXTENSION_ID, codexBundledBinary, versionFromOutput } from './pure/extensionDirs';
import { runCommand } from './proc';
import { VERSION_TIMEOUT_MS } from './claude';

export const CODEX_TRUST_STEP =
  'Codex only runs hooks you have trusted: open codex in a terminal once, and when it shows the ExplainIT hook choose Trust (or type /hooks). The Codex VS Code extension uses the same trust record.';

/** Codex keeps everything under CODEX_HOME when that is set, else ~/.codex (shared by the CLI and the VS Code extension). */
export function codexHomeDir(env: Pick<AdapterEnv, 'userHome' | 'codexHome'>): string {
  return env.codexHome ?? path.join(env.userHome, '.codex');
}

export const CODEX_SPEC: AgentAdapterSpec = {
  agent: 'codex',
  label: 'Codex',
  configPath: (env) => path.join(codexHomeDir(env), 'hooks.json'),
  specs: codexEntrySpecs,
  nextSteps: () => [CODEX_TRUST_STEP, 'Then run "ExplainIT: Doctor" to confirm the hook shows as trusted.'],
};

export class CodexAdapter extends HookAgentBase {
  constructor(env: AdapterEnv) {
    super(env, CODEX_SPEC);
  }

  configTomlPath(): string {
    return path.join(codexHomeDir(this.env), 'config.toml');
  }

  resolveCli(): { cmd: string; args: string[] } | undefined {
    const setting = this.env.settings.get('codexCliPath');
    if (setting && setting.trim() && setting.trim() !== 'codex') return splitCliValue(setting);
    const lookup = { pathEnv: process.env.PATH ?? process.env.Path, pathExt: process.env.PATHEXT, platform: this.env.platform, isFile };
    const onPath = findOnPath('codex', lookup);
    if (onPath) return { cmd: onPath, args: [] };
    const home = this.env.userHome;
    const spots = this.env.platform === 'win32'
      ? [path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd')]
      : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home, '.local', 'bin', 'codex')];
    const hit = spots.find(isFile);
    return hit ? { cmd: hit, args: [] } : undefined;
  }

  bundledBinary(): string | undefined {
    const ext = findExtensionDir(this.env, CODEX_EXTENSION_ID);
    if (!ext) return undefined;
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(ext.path, 'bin'));
    } catch {
      return undefined;
    }
    const bin = codexBundledBinary(ext.path, entries, this.env.platform, this.env.arch);
    return bin && isFile(bin) ? bin : undefined;
  }

  /** Trust status of our PreToolUse handler as recorded in config.toml. */
  trustStatus(): TrustLookup {
    const file = this.configPath();
    let root;
    try {
      root = parseJsonFile(fs.readFileSync(file, 'utf8')).value;
    } catch {
      return { status: 'unknown', detail: 'hooks.json could not be read.' };
    }
    const ours = root ? findOurEntries(root).filter((e) => e.event === 'PreToolUse') : [];
    if (ours.length === 0) return { status: 'unknown', detail: 'No ExplainIT PreToolUse entry in hooks.json.' };
    let toml = '';
    try {
      toml = fs.readFileSync(this.configTomlPath(), 'utf8');
    } catch {
      return { status: 'untrusted', detail: 'No ~/.codex/config.toml yet, so Codex has not recorded any hook trust.' };
    }
    const states = parseHookStates(toml);
    const e = ours[0];
    const expected = codexHookHash('PreToolUse', e.matcher, { command: e.command, timeout: e.timeout });
    // Codex writes the key with the real path of hooks.json (symlinks resolved), so accept both spellings.
    let real = file;
    try {
      real = fs.realpathSync.native(file);
    } catch {
      /* keep the configured path */
    }
    return lookupTrust(states, 'PreToolUse', e.groupIndex, e.handlerIndex, expected, [file, real]);
  }

  protected override extraChecks(_rec: AdapterRecord): IntegrityCheck[] {
    const t = this.trustStatus();
    const name = 'Codex hook trust';
    switch (t.status) {
      case 'trusted':
        return [{ name, ok: true, detail: t.detail }];
      case 'disabled':
        return [{ name, ok: false, fixable: false, detail: `${t.detail} Enable it in codex with /hooks.` }];
      case 'modified':
        return [{ name, ok: false, fixable: false, detail: `${t.detail} ${CODEX_TRUST_STEP}` }];
      case 'untrusted':
        return [{ name, ok: false, fixable: false, detail: `${t.detail} ${CODEX_TRUST_STEP}` }];
      default:
        return [{ name, ok: false, fixable: false, detail: `Trust unknown — run the Doctor after starting codex once. (${t.detail} Config: ${friendlyPath(this.env, this.configTomlPath())})` }];
    }
  }

  override async detect(): Promise<DetectResult> {
    const cli = this.resolveCli();
    const ext = findExtensionDir(this.env, CODEX_EXTENSION_ID);
    const bundled = this.bundledBinary();
    const locations: string[] = [];
    if (cli) locations.push(`CLI: ${cli.args.length ? `${cli.cmd} ${cli.args.join(' ')}` : cli.cmd}`);
    if (ext) locations.push(`VS Code extension ${ext.version ?? ''} at ${ext.path}${bundled ? ' (bundled codex binary)' : ''}`.replace('  ', ' '));
    let version: string | undefined;
    let versionError: string | undefined;
    const probeCmd = cli ?? (bundled ? { cmd: bundled, args: [] } : undefined);
    if (probeCmd) {
      const r = await runCommand(probeCmd.cmd, [...probeCmd.args, '--version'], { timeoutMs: VERSION_TIMEOUT_MS, retry: true });
      if (r.ok) version = versionFromOutput(r.stdout) ?? r.stdout.trim().split('\n')[0];
      else versionError = r.error ?? `exit code ${r.code}${r.stderr ? ': ' + r.stderr.trim().split('\n')[0] : ''}`;
    }
    const present = !!cli || !!ext;
    const signedIn = isFile(path.join(codexHomeDir(this.env), 'auth.json'));
    let detail: string;
    if (!present) {
      detail = 'Codex was not found. Install the CLI (npm install -g @openai/codex) or the "Codex" VS Code extension (openai.chatgpt), run `codex login` once, then run "ExplainIT: Set up assistants" again.';
    } else if (versionError) {
      detail = `Codex is installed but "codex --version" did not answer (${versionError}). Try running it in a terminal to see what is wrong.`;
    } else {
      const both = cli && ext;
      detail = `${both ? 'The Codex CLI and the VS Code extension are both installed; they share ~/.codex, so one hook install and one trust approval cover both.' : cli ? 'Codex CLI found.' : 'Codex VS Code extension found (its bundled codex binary can write explanations too).'} ${signedIn ? 'A Codex sign-in was found on this machine.' : 'Sign in with `codex login` (or from the Codex panel in VS Code) before using it.'}`;
    }
    return { agent: 'codex', present, version, ready: present && !versionError && signedIn, detail, location: locations.join('; ') || undefined };
  }
}
