# Agent Consumption

Probefn is designed so coding agents can consume the framework in two ways:

- `CLI` for shell-driven workflows and CI
- `MCP` for long-lived tool-based interaction

Both surfaces are local-first and operate on the same artifact tree and canonical TypeScript contracts.

## When To Use The CLI

Use CLI JSON mode when:

- a human or script needs a deterministic shell command
- CI needs a reproducible command line
- an agent is operating in a terminal-first environment

Example:

```bash
npm run --silent probefn --workspace=@probefn/workspace -- page find --session sess_healthy --query "Save button" --json
```

CLI JSON always returns the canonical envelope:

- success: `{"ok": true, "schemaVersion": "1.0", "data": ..., "warnings": []}`
- failure: `{"ok": false, "schemaVersion": "1.0", "error": ...}`

Humans may use the concise non-JSON output, but agents should prefer `--json`.

## When To Use MCP

Use MCP when:

- the agent needs a persistent tool surface
- multiple page/session actions should share runtime state
- the host supports MCP tool calling directly

Start the server from the repository root:

```bash
npm run --silent probefn --workspace=@probefn/workspace -- mcp serve --stdio
```

## MCP Tool Parity

The MCP surface mirrors the core browser/session operations:

- `probefn_session_start`
- `probefn_session_stop`
- `probefn_auth_profile_save`
- `probefn_page_open`
- `probefn_page_find`
- `probefn_page_act`
- `probefn_checkpoint_create`
- `probefn_page_get_console`
- `probefn_page_get_network`
- `probefn_page_get_page_errors`
- `probefn_page_get_layout_report`
- `probefn_page_design_audit`
- `probefn_baseline_record`
- `probefn_baseline_compare`
- `probefn_report_export`
- `probefn_run_flow`

Tool results preserve the same logical fields that the CLI JSON mode returns, with MCP transport wrapping layered around that payload.

That includes `probefn_run_flow`, so an agent can execute the same repo-relative flow files through either surface depending on whether it is operating through a shell or a long-lived MCP session.

CLI example:

```bash
npm run --silent probefn --workspace=@probefn/workspace -- run flow --session sess_console_error --file test/fixtures/vite-console-error/flows/trigger-error.yaml --json
```

## Recommended Agent Loop

For debugging:

1. Start or attach to a local session.
2. Open the page.
3. Act on the page using `page.find` or `page.act`.
4. Capture a checkpoint.
5. Pull console, page-error, and network evidence.
6. Export a report tied to local artifacts.

For design review:

1. Start a local session for the fixture or app under test.
2. Capture a checkpoint.
3. Run `audit design`.
4. Inspect findings and warnings.
5. Record or compare a baseline when needed.

## Auth Profiles

Agents can save a reusable local auth profile from any session that has browser storage state:

```bash
npm run --silent probefn --workspace=@probefn/workspace -- auth profile save --session sess_auth --profile customer-admin --json
```

That profile is stored locally under `.artifacts/auth-profiles/` and can be loaded into future config-backed sessions with `--auth-profile`.

## Local-First Constraint

Agents should assume:

- artifacts live on local disk
- report export is local
- baseline registry is local
- design audits are local
- session orchestration is local

If the target app calls remote APIs, that is outside Probefn itself. The framework does not require a remote Probefn service.
