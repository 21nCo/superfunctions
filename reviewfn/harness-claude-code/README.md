# @superfunctions/reviewfn-harness-claude-code

Claude Code CLI adapter for ReviewFn. It runs `claude` in non-interactive print mode, read-only, and returns structured output validated against the slot's output schema, with normalized events, usage and the resolved model. Select it in a panel slot with `"harness": { "adapter": "claude-code", "version": "<claude --version>" }`; the ReviewFn CLI loads it when it is installed next to `@superfunctions/reviewfn-cli`.

## Invocation

The prompt goes to stdin, in the slot's own checkout, with this exact argv (`claudeCodeArguments`):

```
claude -p --output-format stream-json --verbose --model <model>
  --tools Read,Grep,Glob --allowedTools Read,Grep,Glob
  --disallowedTools Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch
  --permission-mode default --strict-mcp-config --mcp-config {"mcpServers":{}}
  --setting-sources "" --no-session-persistence
```

`--verbose` is required for stream-json in print mode. `--tools` removes every other built-in tool, `--setting-sources ""` loads no user, project or local settings or instruction files, and the empty strict MCP configuration loads no MCP server.

The environment is an allowlist: `PATH`, `HOME`, `LANG`, `TMPDIR` and the configured `credentialEnv`. `HOME` is a fresh temporary directory, removed after the run, unless auth is `subscription`. With `api-key` auth the credential is also passed as `ANTHROPIC_API_KEY`, which is where Claude Code reads it.

## Contract

- **Capabilities.** Provider `anthropic`; auth `api-key` or `subscription`; sandbox mode `read-only-tools`, enforced by the tool allowlist and the panel's checkout comparison. An explicit model is required.
- **Trusted local reviews only.** Neither auth mode isolates the credential from repository content, so a pull-request identity fails preflight with `REVIEWFN_PR_AUTH_REQUIRED`, and `run` refuses it before starting Claude Code.
- **Version floor.** Preflight runs `claude --version`; a version below `CLAUDE_CODE_MIN_VERSION` (2.1.0), or none, fails with `REVIEWFN_HARNESS_VERSION`. The reported `major.minor.patch` is the harness version a slot pins.
- **Structured output.** The final result message must be exactly one JSON object (optionally inside one code fence) that validates against the slot's output schema, or the 0.1 harness schema when the slot has none. Otherwise the adapter re-prompts once with the validation errors and the rejected message; if that also fails, the slot ends `malformed`.
- **Model check.** Every model the stream names (the session model, each assistant message and each `modelUsage` entry) must match `^<model>(-\d{8})?$`. A run that served another model reports it as the observed model, so the panel voids the slot with `model_mismatch`. A run that reports no serving model fails.
- **Tool-use check.** Any tool-use event outside `Read`, `Grep`, `Glob` (including server and MCP tool use) is reported in `observed.disallowedTools`, so the panel voids the slot with `disallowed_tool_use`.
- **Process control.** The shared `runProcessGroup` runner from `@superfunctions/reviewfn-core` bounds time and output and kills the whole process group on timeout or cancellation. Both attempts share the slot's time budget.
- **Telemetry.** Normalized events keep event types, models, tool names, usage and cost, never message or tool content; the redacted transcript is the only content-bearing artifact. The credential value is redacted from events, transcript, errors and payload.

## Not claimed

The `claude` executable is operator configuration (`harness.executable`); a compromised binary on `PATH` is out of scope. Container-isolated Claude Code inference for PR review is deferred to REV-9, and a live run with a real credential to REV-20. The test fixtures are stream-json recordings in Claude Code 2.1's format; no test calls Claude Code.
