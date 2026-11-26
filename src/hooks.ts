import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { CONFIG_FILE } from './config.js';

export type HookEvent = 'PreToolUse' | 'PostToolUse';

interface HookHandler {
  type: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: HookHandler[];
}

export interface HooksConfig {
  hooks?: Partial<Record<HookEvent, MatcherGroup[]>>;
}

const DEFAULT_TIMEOUT_SECONDS = 600;

export const HOOKS_FILE = path.join(path.dirname(CONFIG_FILE), 'hooks.json');

export function loadHooksConfig(file: string = HOOKS_FILE): HooksConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return false;
  }
}

export function findHandlers(config: HooksConfig | null, event: HookEvent, toolName: string): HookHandler[] {
  const groups = config?.hooks?.[event];
  if (!Array.isArray(groups)) return [];
  return groups
    .filter(group => matchesTool(group.matcher, toolName))
    .flatMap(group => group.hooks ?? [])
    .filter(handler => handler.type === 'command' && typeof handler.command === 'string' && handler.command.length > 0);
}

export interface HookRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export function runCommandHook(handler: HookHandler, input: unknown, cwd: string): Promise<HookRun> {
  return new Promise(resolve => {
    const timeoutMs = (handler.timeout && handler.timeout > 0 ? handler.timeout : DEFAULT_TIMEOUT_SECONDS) * 1000;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (run: HookRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };

    const child = spawn(handler.command!, { shell: true, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => finish({ exitCode: null, stdout, stderr, timedOut, spawnError: err.message }));
    child.on('close', code => finish({ exitCode: code, stdout, stderr, timedOut }));
    child.stdin.on('error', () => { /* hook exited before reading stdin */ });
    child.stdin.end(JSON.stringify(input));
  });
}

export interface HookOutcome {
  denyReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext: string[];
  systemMessages: string[];
}

/** Interprets one hook run. Errors, timeouts and unparsable output are ignored (fail open). */
export function interpretRun(event: HookEvent, run: HookRun): { block?: string; updatedInput?: Record<string, unknown>; context?: string; message?: string } {
  if (run.timedOut || run.spawnError) return {};
  if (run.exitCode === 2) return { block: run.stderr.trim() || 'Blocked by hook.' };
  if (run.exitCode !== 0) return {};

  const text = run.stdout.trim();
  if (!text) return {};
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  if (!json || typeof json !== 'object') return {};

  const specific = json.hookSpecificOutput ?? {};
  const out: ReturnType<typeof interpretRun> = {};
  if (typeof json.systemMessage === 'string') out.message = json.systemMessage;
  if (typeof specific.additionalContext === 'string') out.context = specific.additionalContext;

  if (json.decision === 'block') {
    out.block = typeof json.reason === 'string' ? json.reason : 'Blocked by hook.';
  }
  if (event === 'PreToolUse') {
    if (specific.permissionDecision === 'deny') {
      out.block = typeof specific.permissionDecisionReason === 'string' ? specific.permissionDecisionReason : 'Blocked by hook.';
    } else if (specific.permissionDecision === 'allow' && specific.updatedInput && typeof specific.updatedInput === 'object') {
      out.updatedInput = specific.updatedInput;
    }
  }
  return out;
}

/** Runs every matching hook concurrently; any deny wins. */
export async function runHooks(
  config: HooksConfig | null,
  event: HookEvent,
  toolName: string,
  payload: Record<string, unknown>,
  cwd: string = process.cwd()
): Promise<HookOutcome> {
  const outcome: HookOutcome = { additionalContext: [], systemMessages: [] };
  const handlers = findHandlers(config, event, toolName);
  if (handlers.length === 0) return outcome;

  const input = { cwd, hook_event_name: event, tool_name: toolName, ...payload };
  const runs = await Promise.all(handlers.map(h => runCommandHook(h, input, cwd)));

  for (const run of runs) {
    const result = interpretRun(event, run);
    if (result.block !== undefined && outcome.denyReason === undefined) outcome.denyReason = result.block;
    if (result.updatedInput) outcome.updatedInput = result.updatedInput;
    if (result.context) outcome.additionalContext.push(result.context);
    if (result.message) outcome.systemMessages.push(result.message);
  }
  return outcome;
}
