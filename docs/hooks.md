# Hooks

Run your own commands around Desktop Commander tool calls. Hooks use the Codex shape.

Create `~/.claude-server-commander/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "start_process|write_file",
        "hooks": [{ "type": "command", "command": "python3 ~/hooks/policy.py", "timeout": 30 }]
      }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "python3 ~/hooks/audit.py" }] }
    ]
  }
}
```

- `matcher` is a regex on the tool name; `*`, empty or omitted matches every tool.
- `timeout` is in seconds (default 600). Matching hooks run concurrently.
- Each hook gets JSON on stdin: `cwd`, `hook_event_name`, `tool_name`, `tool_input`, and for `PostToolUse` also `tool_response`.
- Errors, timeouts and unparsable output never block the tool (fail open).

## PreToolUse output

- Deny: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`, the legacy `{"decision":"block","reason":"..."}`, or exit code `2` with the reason on stderr. Any deny wins.
- Rewrite arguments: `permissionDecision: "allow"` with `updatedInput` (the replacement arguments object).

## PostToolUse output

- `{"decision":"block","reason":"..."}` or exit `2` replaces the tool result with the reason (the tool already ran).
- `hookSpecificOutput.additionalContext` is appended to the result.

## Disabling

`set_config_value` with key `hooksEnabled` and value `false`.

Hooks are a guardrail, not a security boundary. Not supported: `mcp_tool`, async, managed and plugin hooks, and other events.
