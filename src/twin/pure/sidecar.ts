/**
 * Sidecar metadata per source file (function ids, content hashes, section line ranges). Lives OUTSIDE
 * the workspace at `<home>/workspaces/<key>/twins/<sha256(sourcePath)>.json` so agents cannot edit it
 * and the twin itself stays plain prose. Node only (no vscode).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from '../../core/hash';
import { HOME_LAYOUT, canonicalPath, ensureDir } from '../../core/paths';
import type { TwinSection } from '../../core/types';
import type { TwinSidecar } from './stale';

export function sidecarPathFor(workspaceFolder: string, sourcePath: string): string {
  return path.join(HOME_LAYOUT.workspace(workspaceFolder), 'twins', sha256(canonicalPath(sourcePath)) + '.json');
}

function isSection(s: unknown): s is TwinSection {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.index === 'number' &&
    typeof o.functionId === 'string' &&
    typeof o.name === 'string' &&
    typeof o.contentHash === 'string' &&
    typeof o.startLine === 'number' &&
    typeof o.endLine === 'number' &&
    typeof o.stale === 'boolean'
  );
}

/** Validate a parsed JSON value; anything malformed yields undefined (treated as "no sidecar"). */
export function validateSidecar(value: unknown): TwinSidecar | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.sourcePath !== 'string' || typeof o.twinPath !== 'string' || typeof o.textHash !== 'string') return undefined;
  if (!Array.isArray(o.sections) || !o.sections.every(isSection)) return undefined;
  return {
    sourcePath: o.sourcePath,
    twinPath: o.twinPath,
    textHash: o.textHash,
    sections: o.sections.map((s) => ({ ...s })),
    generatedAt: typeof o.generatedAt === 'string' ? o.generatedAt : new Date(0).toISOString(),
  };
}

export function parseSidecar(text: string): TwinSidecar | undefined {
  try {
    return validateSidecar(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function serializeSidecar(s: TwinSidecar): string {
  const ordered: TwinSidecar = {
    sourcePath: s.sourcePath,
    twinPath: s.twinPath,
    textHash: s.textHash,
    sections: s.sections,
    generatedAt: s.generatedAt,
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

export async function readSidecar(file: string): Promise<TwinSidecar | undefined> {
  try {
    return parseSidecar(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function writeSidecar(file: string, s: TwinSidecar): Promise<void> {
  ensureDir(path.dirname(file));
  // Write-then-rename so a crash never leaves a half-written sidecar behind.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, serializeSidecar(s), 'utf8');
  await fs.promises.rename(tmp, file);
}

export async function deleteSidecar(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file);
  } catch {
    /* already gone */
  }
}
