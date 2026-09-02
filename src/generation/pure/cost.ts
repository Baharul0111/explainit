/**
 * Cost estimate for backfill (REQ-011 input, pure heuristic from CONTRACTS):
 *   inputTokens  = ceil(chars / 4) where chars = every function body + capped file summary
 *                  + the fixed prompt text once per request
 *   outputTokens = functions * 120
 *   requests     = sum over files of ceil(functions / maxPerRequest)   (files with 0 functions cost nothing)
 */
import type { Channel, CostEstimate } from '../../core/types';
import type { ExplainRequest } from '../../core/interfaces';
import { MAX_FUNCTIONS_PER_REQUEST, buildExplainPrompt, capFileSummary } from './prompts';

export const OUTPUT_TOKENS_PER_FUNCTION = 120;

/** Characters of fixed prompt text sent with every request (measured from the real template). */
export const PROMPT_OVERHEAD_CHARS: number = buildExplainPrompt({ fileName: 'x', languageId: 'x', functions: [] }, { nonce: '0000000000000000' }).combined.length;

export function estimateCost(reqs: ExplainRequest[], channel: Channel | 'none', maxPerRequest = MAX_FUNCTIONS_PER_REQUEST, thrift = true): CostEstimate {
  const per = Math.min(MAX_FUNCTIONS_PER_REQUEST, Math.max(1, Math.floor(maxPerRequest)));
  let functions = 0;
  let requests = 0;
  let chars = 0;
  for (const r of reqs) {
    const n = r.functions.length;
    if (n === 0) continue;
    functions += n;
    const reqCount = Math.ceil(n / per);
    requests += reqCount;
    const summary = capFileSummary(r.fileSummary, thrift) ?? '';
    for (const f of r.functions) chars += f.text.length;
    chars += reqCount * (summary.length + PROMPT_OVERHEAD_CHARS);
  }
  return {
    functions,
    files: reqs.length,
    requests,
    inputTokens: Math.ceil(chars / 4),
    outputTokens: functions * OUTPUT_TOKENS_PER_FUNCTION,
    channel,
  };
}
