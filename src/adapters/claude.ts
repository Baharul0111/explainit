/**
 * Claude Code adapter: PreToolUse/PostToolUse hooks in the user layer (~/.claude/settings.json).
 * The Claude Code VS Code extension runs the same engine with the same user-layer settings, so one
 * install arms both the terminal and the editor path (REQ-016, REQ-022).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DetectResult } from '../core/interfaces';
import { HookAgentBase, findExtensionDir, isFile, type AdapterEnv, type AgentAdapterSpec } from './installer';
import { claudeEntrySpecs } from './pure/hookConfig';
import { findOnPath, splitCliValue } from './pure/pathLookup';
import { CLAUDE_EXTENSION_ID, claudeBundledBinary, versionFromOutput } from './pure/extensionDirs';
import { runCommand } from './proc';

export const CLAUDE_SPEC: AgentAdapterSpec = {
  agent: 'claude',
  label: 'Claude Code',
  configPath: (env) => path.join(env.userHome, '.claude', 'settings.json'),
  specs: claudeEntrySpecs,
  nextSteps: () => [
    'Claude Code picks up the new hooks on its own, but to be safe start a new Claude Code session (or a new turn) before the next edit.',
    'The Claude Code VS Code extension uses the same settings file, so edits made from inside VS Code go through the same checkpoint. Nothing else to install.',
  ],
};

export const VERSION_TIMEOUT_MS = 10_000;

export class ClaudeAdapter extends HookAgentBase {
  constructor(env: AdapterEnv) {
    super(env, CLAUDE_SPEC);
  }

  /** CLI path from the setting (if not the default), else PATH, else common install spots. */
  resolveCli(): { cmd: string; args: string[] } | undefined {
    const setting = this.env.settings.get('claudeCliPath');
    if (setting && setting.trim() && setting.trim() !== 'claude') {
      const split = splitCliValue(setting);
      return split;
    }
    const lookup = { pathEnv: process.env.PATH ?? process.env.Path, pathExt: process.env.PATHEXT, platform: this.env.platform, isFile };
    const onPath = findOnPath('claude', lookup);
    if (onPath) return { cmd: onPath, args: [] };
    const home = this.env.userHome;
    const spots = this.env.platform === 'win32'
      ? [path.join(home, '.claude', 'local', 'claude.exe'), path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd')]
      : [path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(home, '.local', 'bin', 'claude')];
    const hit = spots.find(isFile);
    return hit ? { cmd: hit, args: [] } : undefined;
  }

  override async detect(): Promise<DetectResult> {
    const cli = this.resolveCli();
    const ext = findExtensionDir(this.env, CLAUDE_EXTENSION_ID);
    const bundled = ext ? claudeBundledBinary(ext.path, this.env.platform) : undefined;
    const bundledOk = !!bundled && isFile(bundled);
    const locations: string[] = [];
    if (cli) locations.push(`CLI: ${cli.args.length ? `${cli.cmd} ${cli.args.join(' ')}` : cli.cmd}`);
    if (ext) locations.push(`VS Code extension ${ext.version ?? ''} at ${ext.path}${bundledOk ? ' (bundled claude binary)' : ''}`.replace('  ', ' '));

    let version: string | undefined;
    let versionError: string | undefined;
    const probeCmd = cli ?? (bundledOk ? { cmd: bundled!, args: [] } : undefined);
    if (probeCmd) {
      const r = await runCommand(probeCmd.cmd, [...probeCmd.args, '--version'], { timeoutMs: VERSION_TIMEOUT_MS, retry: true });
      if (r.ok) version = versionFromOutput(r.stdout) ?? r.stdout.trim().split('\n')[0];
      else versionError = r.error ?? `exit code ${r.code}${r.stderr ? ': ' + r.stderr.trim().split('\n')[0] : ''}`;
    }
    const present = !!cli || !!ext;
    const signedInHint = this.credentialsPresent()
      ? 'A Claude sign-in was found on this machine.'
      : 'If you have not signed in yet, run `claude` once in a terminal (or open the Claude Code panel in VS Code) and follow the sign-in.';
    let detail: string;
    if (!present) {
      detail = 'Claude Code was not found. Install the CLI (npm install -g @anthropic-ai/claude-code) or the "Claude Code" VS Code extension, sign in once, then run "ExplainIT: Set up assistants" again.';
    } else if (versionError) {
      detail = `Claude Code is installed but "claude --version" did not answer (${versionError}). Try running it in a terminal to see what is wrong.`;
    } else {
      const both = cli && ext;
      detail = `${both ? 'The Claude Code CLI and the VS Code extension are both installed; they share one settings file, so one checkpoint install covers both.' : cli ? 'Claude Code CLI found.' : 'Claude Code VS Code extension found (its bundled claude binary can write explanations too).'} ${signedInHint}`;
    }
    return { agent: 'claude', present, version, ready: present && !versionError, detail, location: locations.join('; ') || undefined };
  }

  /** Existence only (never reads the content): ~/.claude/.credentials.json or ~/.claude.json with an OAuth account. */
  private credentialsPresent(): boolean {
    const home = this.env.userHome;
    if (isFile(path.join(home, '.claude', '.credentials.json'))) return true;
    try {
      const raw = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
      return raw.includes('"oauthAccount"');
    } catch {
      return false;
    }
  }
}
