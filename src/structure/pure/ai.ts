/**
 * Converts AI segmentation answers (fallback 3) into RawFunctions. The model's output is untrusted
 * data: names are trimmed and capped, ranges are validated and clamped, nonsense is dropped.
 */
import type { AiSegment } from '../../core/interfaces';
import type { RawFunction } from './normalize';

const MAX_NAME = 120;

export function aiSegmentsToRaw(segments: readonly AiSegment[] | undefined | null, lineCount: number): RawFunction[] {
  if (!Array.isArray(segments) || lineCount <= 0) return [];
  const out: RawFunction[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const name = typeof seg.name === 'string' ? seg.name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
    if (!name) continue;
    const start = Number(seg.startLine);
    const end = Number(seg.endLine);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const startLine = Math.max(0, Math.floor(start));
    const endLine = Math.min(lineCount - 1, Math.floor(end));
    if (startLine >= lineCount || endLine < startLine) continue;
    out.push({ name, kind: name.includes('.') ? 'method' : 'function', range: { startLine, endLine } });
  }
  return out;
}
