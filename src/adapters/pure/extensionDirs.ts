/**
 * Finds installed VS Code extension folders on disk (fallback when the extension API does not list
 * them, e.g. the extension is disabled, or when running outside VS Code). Also knows where the
 * Claude Code and Codex extensions keep their bundled binaries.
 */
import * as path from 'node:path';

export interface ExtensionDir {
  path: string;
  version: string;
}

/** Version string embedded in "<publisher.name>-<version>[-<platform>]" folder names. */
export function versionFromDirName(dirName: string, idPrefix: string): string | undefined {
  if (!dirName.toLowerCase().startsWith(idPrefix.toLowerCase() + '-')) return undefined;
  // Strip the platform suffix VS Code appends to platform-specific builds ("-darwin-arm64", "-win32-x64", "-web").
  const rest = dirName.slice(idPrefix.length + 1).replace(/-(darwin|win32|linux|alpine|web|universal)(-[a-z0-9]+)?$/i, '');
  const m = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(rest);
  return m ? m[1] : rest;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** Newest matching extension folder among `entries` (folder names inside an extensions root). */
export function pickExtensionDir(root: string, entries: string[], idPrefix: string): ExtensionDir | undefined {
  let best: ExtensionDir | undefined;
  for (const name of entries) {
    const v = versionFromDirName(name, idPrefix);
    if (v === undefined) continue;
    if (!best || compareVersions(v, best.version) > 0) best = { path: path.join(root, name), version: v };
  }
  return best;
}

/** Extension roots for VS Code and its popular forks, in preference order. */
export function extensionRoots(homeDir: string): string[] {
  return [
    path.join(homeDir, '.vscode', 'extensions'),
    path.join(homeDir, '.vscode-insiders', 'extensions'),
    path.join(homeDir, '.cursor', 'extensions'),
    path.join(homeDir, '.vscode-oss', 'extensions'),
    path.join(homeDir, '.windsurf', 'extensions'),
  ];
}

export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
export const CODEX_EXTENSION_ID = 'openai.chatgpt';
export const COPILOT_CHAT_EXTENSION_ID = 'github.copilot-chat';
export const COPILOT_EXTENSION_ID = 'github.copilot';

/** Bundled Claude binary inside the Claude Code extension folder. */
export function claudeBundledBinary(extDir: string, platform: NodeJS.Platform): string {
  return path.join(extDir, 'resources', 'native-binary', platform === 'win32' ? 'claude.exe' : 'claude');
}

/** Folder name Codex uses under bin/ for this platform (e.g. "macos-aarch64"). */
export function codexPlatformFolder(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  return `${os}-${cpu}`;
}

/** Bundled Codex binary given the bin/ folder listing (prefers the exact platform folder, then any). */
export function codexBundledBinary(extDir: string, binEntries: string[], platform: NodeJS.Platform, arch: string): string | undefined {
  const want = codexPlatformFolder(platform, arch);
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const exact = binEntries.find((e) => e.toLowerCase() === want);
  const osPrefix = want.split('-')[0];
  const folder = exact ?? binEntries.find((e) => e.toLowerCase().startsWith(osPrefix + '-'));
  return folder ? path.join(extDir, 'bin', folder, exe) : undefined;
}

/** "2.1.252 (Claude Code)" / "codex-cli 0.152.0" -> "2.1.252". */
export function versionFromOutput(text: string): string | undefined {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text);
  return m ? m[1] : undefined;
}
