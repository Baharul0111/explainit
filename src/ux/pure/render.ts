/**
 * Markdown renderers for the doctor report, the journal view and the onboarding detection list.
 * Pure: no `vscode` import.
 */
import type { DetectResult, DoctorReport } from '../../core/interfaces';
import type { ChannelAvailability, JournalEntry } from '../../core/types';
import { AGENT_LABEL } from './doctorChecks';

export function renderDoctorMarkdown(report: DoctorReport, version: string): string {
  const failed = report.checks.filter((c) => !c.ok);
  const lines: string[] = [];
  lines.push(`# ExplainIT Doctor report`);
  lines.push('');
  lines.push(`Version ${version} — ran at ${report.ranAt}`);
  lines.push('');
  lines.push(report.ok ? `**Everything is installed, armed and healthy** (${report.checks.length} checks).` : `**${failed.length} problem(s) found** in ${report.checks.length} checks.`);
  lines.push('');
  if (failed.length) {
    lines.push('## What to do');
    lines.push('');
    for (const c of failed) {
      lines.push(`- **${c.name}** — ${c.detail}${c.fix ? ` _(fix available: ${c.fix.label})_` : ''}`);
    }
    lines.push('');
  }
  lines.push('## All checks');
  lines.push('');
  lines.push('| Result | Check | Details |');
  lines.push('|---|---|---|');
  for (const c of report.checks) {
    lines.push(`| ${c.ok ? 'OK' : 'PROBLEM'} | ${escapeCell(c.name)} | ${escapeCell(c.detail)}${c.fix && !c.ok ? ` — fix: ${escapeCell(c.fix.label)}` : ''} |`);
  }
  lines.push('');
  lines.push('## Where to look next');
  lines.push('');
  lines.push('- "ExplainIT: Help: the five most likely problems" opens the runbooks.');
  lines.push('- "ExplainIT: Show logs" opens the local log file. Nothing in it is ever sent anywhere.');
  lines.push('');
  return lines.join('\n');
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderJournalMarkdown(entriesByFolder: { folder: string; entries: JournalEntry[]; file: string }[]): string {
  const lines: string[] = ['# ExplainIT change journal', ''];
  lines.push('Every proposed and accepted change, newest first. The journal is append-only and hash-chained; run "ExplainIT: Verify the change journal" to check it.');
  lines.push('');
  let any = false;
  for (const { folder, entries, file } of entriesByFolder) {
    lines.push(`## ${folder}`);
    lines.push('');
    lines.push(`File: ${file}`);
    lines.push('');
    if (!entries.length) {
      lines.push('The change journal is empty. Entries appear as soon as an assistant proposes a change.');
      lines.push('');
      continue;
    }
    any = true;
    lines.push('| When | What | Assistant | File | Decision | Restore point |');
    lines.push('|---|---|---|---|---|---|');
    const sorted = [...entries].sort((a, b) => b.seq - a.seq);
    for (const e of sorted) {
      const decision = e.decision ? `${e.decision.verdict}${e.decision.reason ? ` — ${escapeCell(e.decision.reason)}` : ''}` : '';
      lines.push(`| ${e.ts} | ${e.kind}${e.note ? ` — ${escapeCell(e.note)}` : ''} | ${e.agent ?? ''} | ${e.path ? escapeCell(e.path) : ''} | ${decision} | ${e.checkpointId ?? ''} |`);
    }
    lines.push('');
  }
  if (!entriesByFolder.length) lines.push('Open a folder to see its change journal.');
  else if (!any) lines.push('');
  return lines.join('\n');
}

export interface DetectionLine {
  agent: 'claude' | 'codex' | 'copilot';
  label: string;
  found: boolean;
  ready: boolean;
  detail: string;
}

/**
 * Combine adapter detection (CLIs and VS Code extensions) with router channel availability into
 * the three lines shown during onboarding.
 */
export function detectionLines(detect: DetectResult[], channels: ChannelAvailability[]): DetectionLine[] {
  const order: ('copilot' | 'claude' | 'codex')[] = ['copilot', 'claude', 'codex'];
  const names: Record<'copilot' | 'claude' | 'codex', string> = {
    copilot: 'Copilot in VS Code',
    claude: 'Claude Code (terminal tool or VS Code extension)',
    codex: 'Codex (terminal tool or VS Code extension)',
  };
  return order.map((agent) => {
    const d = detect.find((r) => r.agent === agent);
    const c = channels.find((x) => x.channel === agent);
    const found = d?.present === true || c?.available === true;
    const ready = c?.available === true || (d?.present === true && d.ready !== false);
    const parts: string[] = [];
    if (found) {
      parts.push(ready ? 'ready' : 'not signed in');
      if (d?.location) parts.push(`at ${d.location}`);
      if (d?.version) parts.push(`version ${d.version}`);
      if (!ready && (c?.reason || d?.detail)) parts.push(c?.reason ?? d?.detail ?? '');
    } else {
      parts.push(c?.reason ?? d?.detail ?? 'not installed');
    }
    return { agent, label: names[agent], found, ready, detail: parts.filter(Boolean).join(', ') };
  });
}

export const INSTALL_LINKS: { agent: 'claude' | 'codex' | 'copilot'; label: string; url: string }[] = [
  { agent: 'claude', label: `Install ${AGENT_LABEL.claude}`, url: 'https://code.claude.com/docs/en/overview' },
  { agent: 'codex', label: `Install ${AGENT_LABEL.codex}`, url: 'https://developers.openai.com/codex' },
  { agent: 'copilot', label: `Install ${AGENT_LABEL.copilot}`, url: 'https://code.visualstudio.com/docs/copilot/setup' },
];
