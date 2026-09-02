/**
 * Copilot detection: the Copilot Chat extension (built in to recent VS Code builds or installed
 * separately) plus, once the person has granted permission, the Copilot models vscode.lm exposes.
 * Never triggers the consent dialog (only sendRequest does; listing models does not).
 */
import type { DetectResult } from '../core/interfaces';
import type { AdapterEnv } from './installer';
import { COPILOT_CHAT_EXTENSION_ID, COPILOT_EXTENSION_ID } from './pure/extensionDirs';

export async function detectCopilot(env: AdapterEnv): Promise<DetectResult> {
  const chat = env.probe.findExtension(COPILOT_CHAT_EXTENSION_ID);
  const base = chat ? undefined : env.probe.findExtension(COPILOT_EXTENSION_ID);
  const ext = chat ?? base;
  const consent = env.state.read().consentGranted === true;
  let models: number | undefined;
  if (consent) {
    try {
      models = await env.probe.copilotModelCount();
    } catch {
      models = undefined;
    }
  }
  const present = !!ext || (models ?? 0) > 0;
  const location = ext ? `VS Code extension ${ext.version ?? ''} at ${ext.path}`.replace('  ', ' ') : undefined;
  let detail: string;
  if (!present) {
    detail = 'GitHub Copilot Chat was not found. Install the "GitHub Copilot Chat" extension and sign in to GitHub, then run "ExplainIT: Set up assistants" again.';
  } else if (!consent) {
    detail = 'Copilot Chat is installed. Grant ExplainIT permission to use your assistants (onboarding) to check that Copilot models are available.';
  } else if ((models ?? 0) > 0) {
    detail = `Copilot Chat is installed and ${models} model${models === 1 ? '' : 's'} are available. Copilot changes cannot be stopped before they land; ExplainIT reviews them right after (Keep/Undo stays with Copilot).`;
  } else {
    detail = 'Copilot Chat is installed but no Copilot models are available yet. Sign in to GitHub in VS Code (Accounts menu) and make sure your Copilot plan is active.';
  }
  return { agent: 'copilot', present, version: ext?.version, ready: consent ? (models ?? 0) > 0 : undefined, detail, location };
}
