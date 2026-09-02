/**
 * Ingress validation for hook envelopes (REQ-013). Pure: ajv schemas + path canonicalisation.
 *
 * The hook script wraps the agent's raw stdin JSON in a HookEnvelope. We validate the envelope,
 * then the agent-specific payload for the tools we care about, and finally resolve every target
 * path to its canonical absolute form and decide whether it is inside a workspace folder.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import * as path from 'node:path';
import type { AgentKind } from '../../core/types';
import type { HookEnvelope } from '../../core/interfaces';
import { canonicalPath, isInside } from '../../core/paths';

export const CLAUDE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'] as const;
export const CODEX_WRITE_TOOLS = ['apply_patch', 'Edit', 'Write'] as const;
export const CODEX_SHELL_TOOLS = ['Bash', 'shell', 'local_shell', 'shell_command', 'exec_command', 'container.exec'] as const;

export type ToolCategory = 'write' | 'edit' | 'multiedit' | 'notebook' | 'shell' | 'patch' | 'irrelevant';

export interface IngressOk {
  ok: true;
  agent: AgentKind;
  event: 'PreToolUse' | 'PostToolUse';
  toolName: string;
  category: ToolCategory;
  toolUseId?: string;
  sessionId: string;
  cwd: string;
  toolInput: Record<string, unknown>;
  hookVersion?: string;
}

export interface IngressError {
  ok: false;
  status: 400;
  error: string;
}

export type IngressResult = IngressOk | IngressError;

const ajv = new Ajv({ allErrors: false, strict: false });

const envelopeSchema = {
  type: 'object',
  required: ['agent', 'event', 'payload'],
  properties: {
    agent: { type: 'string', enum: ['claude', 'codex'] },
    event: { type: 'string', enum: ['PreToolUse', 'PostToolUse'] },
    payload: { type: 'object' },
    hookVersion: { type: 'string' },
  },
};

/** Fields both agents send; `tool_input` is validated per tool below. */
const payloadSchema = {
  type: 'object',
  required: ['tool_name', 'tool_input'],
  properties: {
    tool_name: { type: 'string', minLength: 1 },
    tool_input: { type: 'object' },
    cwd: { type: 'string' },
    session_id: { type: 'string' },
    turn_id: { type: 'string' },
    tool_use_id: { type: 'string' },
    hook_event_name: { type: 'string' },
  },
};

const stringOrArray = { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };

const toolInputSchemas: Record<Exclude<ToolCategory, 'irrelevant'>, object> = {
  write: {
    type: 'object',
    required: ['file_path', 'content'],
    properties: { file_path: { type: 'string', minLength: 1 }, content: { type: 'string' } },
  },
  edit: {
    type: 'object',
    required: ['file_path', 'old_string', 'new_string'],
    properties: {
      file_path: { type: 'string', minLength: 1 },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
  },
  multiedit: {
    type: 'object',
    required: ['file_path', 'edits'],
    properties: {
      file_path: { type: 'string', minLength: 1 },
      edits: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['old_string', 'new_string'],
          properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
        },
      },
    },
  },
  notebook: {
    type: 'object',
    anyOf: [{ required: ['notebook_path'] }, { required: ['file_path'] }],
    properties: { notebook_path: { type: 'string', minLength: 1 }, file_path: { type: 'string', minLength: 1 } },
  },
  shell: {
    type: 'object',
    properties: { command: stringOrArray, cmd: stringOrArray },
    anyOf: [{ required: ['command'] }, { required: ['cmd'] }],
  },
  patch: {
    // Codex sends the patch as `command` (string or argv array); older builds used `patch`/`input`.
    type: 'object',
    properties: { command: stringOrArray, patch: { type: 'string' }, input: { type: 'string' } },
    anyOf: [{ required: ['command'] }, { required: ['patch'] }, { required: ['input'] }],
  },
};

const validators = new Map<string, ValidateFunction>();
function validator(key: string, schema: object): ValidateFunction {
  let v = validators.get(key);
  if (!v) {
    v = ajv.compile(schema);
    validators.set(key, v);
  }
  return v;
}

function describe(v: ValidateFunction): string {
  const e = v.errors?.[0];
  if (!e) return 'invalid';
  const where = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'body';
  return `${where} ${e.message ?? 'is invalid'}`.trim();
}

/** Which of our categories a tool falls into for the given agent. */
export function categorize(agent: AgentKind, toolName: string, toolInput?: Record<string, unknown>): ToolCategory {
  if (agent === 'claude') {
    switch (toolName) {
      case 'Write':
        return 'write';
      case 'Edit':
        return 'edit';
      case 'MultiEdit':
        return 'multiedit';
      case 'NotebookEdit':
        return 'notebook';
      case 'Bash':
        return 'shell';
      default:
        return 'irrelevant';
    }
  }
  if (agent === 'codex') {
    if (toolName === 'apply_patch') return 'patch';
    if (toolName === 'Write') return 'write';
    if (toolName === 'Edit') return 'edit';
    if ((CODEX_SHELL_TOOLS as readonly string[]).includes(toolName) || toolName.startsWith('shell')) {
      // Codex may run apply_patch through its shell tool; the patch text identifies it.
      if (toolInput && commandMentionsPatch(toolInput)) return 'patch';
      return 'shell';
    }
  }
  return 'irrelevant';
}

function commandMentionsPatch(toolInput: Record<string, unknown>): boolean {
  const c = toolInput.command ?? toolInput.cmd ?? toolInput.patch ?? toolInput.input;
  const text = Array.isArray(c) ? c.map(String).join('\n') : typeof c === 'string' ? c : '';
  return text.includes('*** Begin Patch');
}

/** Validate a raw request body into a typed ingress record, or a 400-shaped error. */
export function validateEnvelope(body: unknown): IngressResult {
  const env = validator('envelope', envelopeSchema);
  if (!env(body)) {
    const raw = body as Record<string, unknown> | null;
    if (raw && typeof raw === 'object' && typeof raw.agent === 'string' && !['claude', 'codex'].includes(raw.agent)) {
      return { ok: false, status: 400, error: `Unknown agent "${raw.agent}". ExplainIT gates Claude Code and Codex only.` };
    }
    return { ok: false, status: 400, error: `The hook envelope is not valid: ${describe(env)}.` };
  }
  const e = body as HookEnvelope;
  const pay = validator('payload', payloadSchema);
  if (!pay(e.payload)) {
    return { ok: false, status: 400, error: `The ${e.agent} hook payload is not valid: ${describe(pay)}.` };
  }
  const p = e.payload as Record<string, unknown>;
  const toolName = p.tool_name as string;
  const toolInput = p.tool_input as Record<string, unknown>;
  const category = categorize(e.agent, toolName, toolInput);
  if (category !== 'irrelevant') {
    const tv = validator(`tool:${category}`, toolInputSchemas[category]);
    if (!tv(toolInput)) {
      return { ok: false, status: 400, error: `The tool_input for ${toolName} is not valid: ${describe(tv)}.` };
    }
  }
  return {
    ok: true,
    agent: e.agent,
    event: e.event,
    toolName,
    category,
    toolUseId: typeof p.tool_use_id === 'string' ? p.tool_use_id : undefined,
    sessionId: typeof p.session_id === 'string' && p.session_id ? p.session_id : 'unknown-session',
    cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd(),
    toolInput,
    hookVersion: e.hookVersion,
  };
}

export interface ResolvedPath {
  /** Canonical absolute path. */
  path: string;
  /** The workspace folder that contains it, or undefined when it is outside every folder. */
  folder?: string;
  confinement: 'inside' | 'outside';
}

/** Resolve an agent-supplied path against cwd, canonicalise it and check workspace confinement. */
export function resolveTarget(rawPath: string, cwd: string, folders: string[]): ResolvedPath {
  const abs = path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath);
  const canon = canonicalPath(abs);
  const folder = folders.find((f) => {
    try {
      return isInside(f, canon);
    } catch {
      return false;
    }
  });
  return { path: canon, folder, confinement: folder ? 'inside' : 'outside' };
}

/** The shell command text of a Bash/shell tool call as one string (argv arrays are joined). */
export function commandText(toolInput: Record<string, unknown>): string {
  const c = toolInput.command ?? toolInput.cmd;
  if (Array.isArray(c)) return c.map((x) => String(x)).join(' ');
  return typeof c === 'string' ? c : '';
}

/** The path an agent write targets (Claude tools and Codex Write/Edit). */
export function targetPathOf(toolInput: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = toolInput[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}
