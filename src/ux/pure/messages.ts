/**
 * Catalog of every user-facing string the UX layer shows for empty, loading and error states.
 * Kept in one place (and exported) so tests can assert that each message exists, is plain English
 * and says what happened and what to do next. No `vscode` import here.
 *
 * Placeholders use `{name}` and are filled by `msg()`.
 */

/** Verbatim consent sentence required by goal.md / architecture.md. Do not reword. */
export const CONSENT_SENTENCE =
  'Your code goes only to the assistants you already use, under your existing agreements. ' +
  'ExplainIT ships no model, holds no keys, runs no server and sends no telemetry.';

export const MESSAGES = {
  // --- assistants / onboarding -------------------------------------------------------------
  noAssistantConnected:
    'No assistant is connected yet, so ExplainIT cannot write explanations. Run "ExplainIT: Set up assistants" to connect Claude Code, Codex or Copilot.',
  consentNotGranted:
    'ExplainIT does not have your permission to use your assistants yet. Run "ExplainIT: Set up assistants" and choose Allow.',
  onboardingTitle: 'ExplainIT needs your permission to use the assistants you already have.',
  onboardingBody:
    'ExplainIT asks your connected assistant (Claude Code, Codex or Copilot) to write plain-English notes about your code and about every change it proposes. ' +
    CONSENT_SENTENCE,
  onboardingDeclined:
    'No problem. ExplainIT will not use your assistants until you allow it. Run "ExplainIT: Set up assistants" whenever you are ready.',
  onboardingDetecting: 'Looking for Claude Code, Codex and Copilot on this computer...',
  onboardingNothingFound:
    'ExplainIT could not find Claude Code, Codex or Copilot on this computer. Install one of them, sign in, then choose "Check again".',
  onboardingConnected: 'Connected {agent}. {steps}',
  onboardingConnectFailed: 'Could not connect {agent}: {detail} Run "ExplainIT: Doctor" for details and a fix.',
  onboardingDone: 'ExplainIT is set up. Open any code file to see its plain-English twin.',
  copilotSteeringDone:
    'Copilot steering is in place. Copilot cannot be stopped before it writes, so ExplainIT reviews its changes after they land and adds a plain-English note to each function.',
  codexTrustStep:
    'Start Codex once (terminal or the VS Code extension). It will ask whether to trust the ExplainIT hook. Choose "trust" so the checkpoint can stop changes before they reach the disk.',
  restartAgentStep: 'Restart {agent} so it picks up the new hook. Sessions that were already running are not protected until restarted.',

  // --- explanations / twins ----------------------------------------------------------------
  explanationLoading: 'Writing the plain-English twin with {channel}... The first section usually appears within a few seconds.',
  explanationFailed: 'ExplainIT could not write the explanation: {detail} Try again, or run "ExplainIT: Doctor" to check your assistant connection.',
  explanationTimedOut: 'The assistant did not answer in time. Check that it is signed in and try again.',
  twinUnsupportedFile:
    'ExplainIT cannot create a twin for this file. It only works for real code files saved on disk, not for untitled, binary or twin files. Save the file with a code language mode and try again.',
  twinNoEditor: 'Open a code file first, then run this command.',
  twinIsTwin: 'This is already a plain-English twin. Opening the code file it describes.',
  twinSourceMissing: 'The code file for this twin could not be found. It may have been moved or deleted. Open the code file itself, or delete this twin if the code is gone.',
  twinNoFunctions: 'This file has no functions to explain, so the twin only has a header.',
  twinCreateFailed: 'Could not create the twin for {file}: {detail} Try again, or run "ExplainIT: Doctor" if it keeps failing.',
  regenerateNoSection: 'Put the cursor inside a numbered section of the twin, then run "Regenerate this section" again.',
  regenerateNotTwin: 'This command only works inside a plain-English twin file (a file ending in _explain.txt).',
  regenerateDone: 'Section {index} was regenerated.',
  autoOpenOn: 'ExplainIT will open the plain-English twin beside every code file you open.',
  autoOpenOff: 'Automatic twin opening is off. Use "ExplainIT: Open plain-English twin" whenever you want one.',

  // --- backfill ------------------------------------------------------------------------------
  backfillNothingToDo: 'Every code file in this project already has an up-to-date twin. There is nothing to backfill.',
  backfillNoFolder: 'Open a folder first. Backfill works on the folders in your workspace.',
  backfillPaused: 'Backfill is paused after {done} of {total} files. Run "ExplainIT: Resume backfill" to continue.',
  backfillAlreadyRunning: 'Backfill is already running ({done} of {total} files done). Use "ExplainIT: Pause backfill" or "Cancel backfill" to control it.',
  backfillResumed: 'Backfill resumed.',
  backfillNotRunning: 'Backfill is not running right now. Run "ExplainIT: Backfill the whole project" to start one.',
  backfillNotPaused: 'Backfill is not paused, so there is nothing to resume.',
  backfillCancelled: 'Backfill was cancelled. Files that were already done keep their twins.',
  backfillDone: 'Backfill finished: {done} files now have plain-English twins.',
  backfillFailed: 'Backfill stopped because of an error: {detail} Run it again when you are ready; finished files are skipped.',

  // --- checkpoint / gate --------------------------------------------------------------------
  gateNotResponding:
    'ExplainIT is not responding. Assistants will fall back to their own permission prompts within {seconds} seconds. Reload the window, then run "ExplainIT: Doctor".',
  gateNotRunning: 'The ExplainIT checkpoint is not running in this window. Reload the window; if it keeps failing, run "ExplainIT: Doctor".',
  pausedBanner: 'ExplainIT checkpoint is paused. Assistants are using their own prompts.',
  pausedConfirm: 'The checkpoint is paused. Claude Code and Codex will use their own permission prompts until you resume it.',
  resumedConfirm: 'The checkpoint is on again. Every Claude Code and Codex change will stop for your approval.',
  resumeEnabledSetting: 'The setting "explainit.checkpoint.enabled" was off; ExplainIT turned it on so the checkpoint can resume.',
  pendingReviews: '{count} change(s) waiting for your decision.',
  noPendingReviews: 'No changes are waiting for review.',

  // --- restore / journal ---------------------------------------------------------------------
  restoreNoPoints: 'There are no restore points for this file yet. ExplainIT saves one before every accepted change.',
  restoreNoPointsAnywhere: 'There are no restore points in this workspace yet. ExplainIT saves one before every accepted change.',
  restoreNoWorkspace: 'Restore points belong to a workspace folder. Open the folder that contains the file first.',
  restoreSucceeded: 'Restored {file}. A safety restore point of the previous content was saved first.',
  restoreFailed: 'Could not restore {file}: {detail} The current content was not changed. Check file permissions and free disk space, then try again.',
  restoreUnknown: 'That restore point could not be found. It may have been removed by rotation. Refresh the journal view and try again.',
  journalEmpty: 'The change journal is empty. Entries appear as soon as an assistant proposes a change.',
  journalOk: 'The change journal is intact: {entries} entries verified.',
  journalTamper:
    'The change journal has been tampered with or damaged at entry {at}: {detail} Entries after that point cannot be trusted. Keep the file for inspection and run "ExplainIT: Doctor".',
  journalVerifyFailed: 'Could not verify the change journal: {detail} Run "ExplainIT: Doctor" and check free disk space.',

  // --- doctor / status -----------------------------------------------------------------------
  doctorRunning: 'ExplainIT Doctor is checking your setup...',
  doctorAllOk: 'ExplainIT Doctor: everything is installed, armed and healthy ({count} checks).',
  doctorProblems: 'ExplainIT Doctor found {failed} problem(s) in {count} checks. Open the report for details.',
  doctorFixed: 'ExplainIT applied {count} fix(es). Run the Doctor again to confirm.',
  doctorFixFailed: 'A fix did not work ({name}): {detail} Open the Doctor report for the manual steps.',
  statusArmed: 'Checkpoint armed: every Claude Code and Codex change stops for your approval.',
  statusPaused: 'Checkpoint paused: assistants use their own prompts.',
  statusNotResponding: 'The checkpoint has not sent a heartbeat for a while. Assistants will fall back to their own prompts. Reload the window if it stays red.',
  statusStarting: 'The checkpoint is starting...',
  statusChannel: 'Explanations written by: {channel}',
  statusNoChannel: 'Explanations: no assistant connected.',

  // --- misc ----------------------------------------------------------------------------------
  noWorkspaceFolder: 'Open a folder first. This command works on the folders in your workspace.',
  instructionsUpdated: 'Assistant instruction files are up to date: {written}',
  instructionsUnchanged: 'Assistant instruction files were already up to date.',
  hooksRemoved: 'The ExplainIT checkpoint hooks were removed. Claude Code and Codex now use their own prompts everywhere.',
  hooksRemoveFailed: 'Could not remove the hooks: {detail} Run "ExplainIT: Doctor" for details.',
  channelChanged: 'Explanations will now be written by: {channel}',
  runbookOpenFailed: 'Could not open the help page: {detail} Open the docs/runbooks folder inside the extension instead.',
  commandFailed: '{command} did not finish: {detail} Try again; if it keeps failing, run "ExplainIT: Show logs".',
  gitignoreOffered: 'Done. The shared .gitignore now ignores *_explain.txt for everyone on the team.',
} as const;

export type MessageKey = keyof typeof MESSAGES;

/** Fill `{name}` placeholders. Unknown placeholders are left as they are so nothing renders as "undefined". */
export function msg(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return MESSAGES[key].replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** Words that must never appear in a message shown to a person. */
export const FORBIDDEN_WORDS = ['undefined', 'null', 'NaN', '[object', 'TODO', 'lorem'];

/** Names of the placeholders used by a message (for tests and callers). */
export function placeholdersOf(key: MessageKey): string[] {
  const out = new Set<string>();
  for (const m of MESSAGES[key].matchAll(/\{(\w+)\}/g)) out.add(m[1]);
  return [...out];
}

/** Turn an unknown thrown value into a short plain-English fragment ending with a period. */
export function describeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'an unknown error occurred';
  const text = raw.trim().replace(/\s+/g, ' ') || 'an unknown error occurred';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
