/**
 * User hooks (src/hooks.ts): matcher filtering, deny via JSON and exit code 2,
 * updatedInput rewrite, additionalContext, and fail-open on timeout/bad output.
 */
import assert from 'assert';
import { findHandlers, runHooks, matchesTool } from '../dist/hooks.js';
import { runIfMain } from './helpers/run-if-main.js';

const node = JSON.stringify(process.execPath);
const hook = (script, extra = {}) => ({ type: 'command', command: `${node} -e ${JSON.stringify(script)}`, ...extra });
const cfg = (event, matcher, ...hooks) => ({ hooks: { [event]: [{ matcher, hooks }] } });

export default async function runTests() {
  assert.ok(matchesTool(undefined, 'anything'));
  assert.ok(matchesTool('*', 'anything'));
  assert.ok(matchesTool('read_file|write_file', 'write_file'));
  assert.ok(!matchesTool('^read_file$', 'write_file'));
  assert.strictEqual(findHandlers(cfg('PreToolUse', 'read_file', hook('0')), 'PreToolUse', 'write_file').length, 0);

  const deny = hook(`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'nope'}}))`);
  let out = await runHooks(cfg('PreToolUse', 'start_process', deny), 'PreToolUse', 'start_process', { tool_input: {} });
  assert.strictEqual(out.denyReason, 'nope');

  const exit2 = hook(`process.stderr.write('stderr reason');process.exit(2)`);
  out = await runHooks(cfg('PreToolUse', '', exit2), 'PreToolUse', 'x', { tool_input: {} });
  assert.strictEqual(out.denyReason, 'stderr reason');

  const rewrite = hook(`console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow',updatedInput:{path:'/safe'}}}))`);
  out = await runHooks(cfg('PreToolUse', 'x', rewrite), 'PreToolUse', 'x', { tool_input: {} });
  assert.deepStrictEqual(out.updatedInput, { path: '/safe' });

  const echo = hook(`let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const i=JSON.parse(d);console.log(JSON.stringify({hookSpecificOutput:{additionalContext:i.hook_event_name+':'+i.tool_name+':'+i.tool_input.a}}))})`);
  out = await runHooks(cfg('PostToolUse', 'x', echo), 'PostToolUse', 'x', { tool_input: { a: 1 } });
  assert.deepStrictEqual(out.additionalContext, ['PostToolUse:x:1']);

  const slow = hook(`setTimeout(()=>{},5000)`, { timeout: 0.2 });
  out = await runHooks(cfg('PreToolUse', 'x', slow, hook(`console.log('not json')`), hook(`process.exit(1)`)), 'PreToolUse', 'x', { tool_input: {} });
  assert.strictEqual(out.denyReason, undefined);

  console.log('hooks tests passed');
}

runIfMain(import.meta.url, runTests);
