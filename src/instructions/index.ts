/**
 * Instructions generator: keeps the ExplainIT sections in CLAUDE.md, AGENTS.md and
 * .github/copilot-instructions.md up to date (marker-delimited, idempotent, never touches the
 * person's own text). Steering on top of enforcement, never instead of it.
 *
 * Files that ExplainIT CREATES are kept out of git through the repository's local exclude list
 * (goal item 6 applied to every file ExplainIT writes); files that already existed belong to the team
 * and their git status is never touched.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureFileExcluded } from '../core/gitExclude';
import type { CoreDeps, InstructionsGenerator } from '../core/interfaces';
import type { AgentKind } from '../core/types';
import { fileForAgent, sectionText, upsertSection } from './pure/sections';

const ALL_AGENTS: AgentKind[] = ['claude', 'codex', 'copilot'];

export interface InstructionsDeps extends CoreDeps {
  /** Whether newly created instruction files should be kept out of git (default: the setting). */
  keepOutOfGit?: () => boolean;
}

export function createInstructionsGenerator(deps: InstructionsDeps): InstructionsGenerator {
  const log = deps.logger.child('instructions');
  const keepOutOfGit = deps.keepOutOfGit ?? (() => deps.settings.get('instructionsKeepOutOfGit'));
  let tmpCounter = 0;
  return {
    sectionText,
    async ensure(folder, opts) {
      const agents = opts?.agents?.length ? opts.agents : ALL_AGENTS;
      const written: string[] = [];
      const unchanged: string[] = [];
      const excluded: string[] = [];
      const failures: string[] = [];
      for (const agent of agents) {
        const file = path.join(folder, fileForAgent(agent));
        try {
          let existing: string | undefined;
          try {
            existing = fs.readFileSync(file, 'utf8');
          } catch {
            existing = undefined;
          }
          const r = upsertSection(existing, sectionText(agent));
          if (!r.changed) {
            unchanged.push(file);
            continue;
          }
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const tmp = `${file}.${process.pid}.${++tmpCounter}.explainit-tmp`;
          fs.writeFileSync(tmp, r.text, 'utf8');
          fs.renameSync(tmp, file);
          written.push(file);
          log.info(`${r.action} ExplainIT section in ${file}`);
          if (existing === undefined && keepOutOfGit()) {
            // Only files ExplainIT brought into existence are excluded; a team's own CLAUDE.md stays theirs.
            const ex = await ensureFileExcluded(file);
            if (ex.result === 'added' || ex.result === 'present') excluded.push(file);
            else if (ex.result === 'error') log.warn(`could not keep ${file} out of git: ${ex.error}`);
          }
        } catch (e) {
          failures.push(`${file}: ${(e as Error).message}`);
          log.warn(`could not update ${file}`, e);
        }
      }
      if (failures.length) {
        throw new Error(`ExplainIT could not update ${failures.length} instruction file${failures.length === 1 ? '' : 's'} (${failures.join('; ')}). Check that the folder is writable, then run "ExplainIT: Update assistant instructions" again.`);
      }
      return { written, unchanged, excluded };
    },
  };
}
