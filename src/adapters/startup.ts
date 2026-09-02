/**
 * Session-start integrity pass: verify the hook script, wrappers and config entries, and re-arm
 * whatever was tampered with or is out of date. Pure orchestration (no `vscode` import) so it can be
 * unit-tested with a fake AdapterManager; src/extension.ts calls it once after the gate is up.
 */
import type { AdapterManager, IntegrityReport } from '../core/interfaces';
import type { Logger } from '../core/log';

export type StartupAdapters = Pick<AdapterManager, 'verifyIntegrity' | 'rearm'>;

/**
 * Verifies, and when something is wrong re-arms once, logging the report before and after.
 * Never throws: a crash inside verify/rearm is logged and reported as a single failing check so
 * activation is never blocked by it.
 */
export async function verifyAndRearmAtStartup(adapters: StartupAdapters, logger: Logger): Promise<IntegrityReport> {
  let before: IntegrityReport;
  try {
    before = await adapters.verifyIntegrity();
  } catch (e) {
    logger.error('startup integrity check failed', e);
    return { ok: false, checks: [{ name: 'Startup integrity check', ok: false, fixable: false, detail: `The integrity check could not run: ${(e as Error).message}. Run "ExplainIT: Doctor" to see what is wrong.` }] };
  }
  if (before.ok) {
    logger.debug('adapter integrity verified at startup', { checks: before.checks.length });
    return before;
  }
  const failing = before.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? 'failed'}`);
  logger.warn('adapter integrity problems found at startup; re-arming', { before: failing });
  try {
    const after = await adapters.rearm();
    const stillFailing = after.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? 'failed'}`);
    if (after.ok) logger.info('checkpoint hooks re-armed at startup', { fixed: failing });
    else logger.warn('some checkpoint hook problems remain after re-arming; the Doctor explains what to do', { after: stillFailing });
    return after;
  } catch (e) {
    logger.error('re-arming the checkpoint hooks failed at startup', e);
    return before;
  }
}
