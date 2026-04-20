# Phase goal

Implement the MCP server with full parity to core browser/session/report operations.

# In scope / Out of scope

- In scope: MCP server bootstrap, tool registration, argument validation, tool-to-core adapters, structured errors.
- Out of scope: CLI human-friendly formatting and fixture-authoring docs.

# Deliverables

- `packages/mcp-server/package.json`
- `packages/mcp-server/src/index.ts`
- `packages/mcp-server/src/server.ts`
- `packages/mcp-server/src/tools/session.ts`
- `packages/mcp-server/src/tools/page.ts`
- `packages/mcp-server/src/tools/checkpoint.ts`
- `packages/mcp-server/src/tools/design.ts`
- `packages/mcp-server/src/tools/baseline.ts`
- `packages/mcp-server/src/tools/report.ts`
- `packages/mcp-server/test/mcp-server.test.ts`

# Requirements covered

- `API-002`
- `ERROR-001`

# Implementation tasks

1. Implement MCP server startup over stdio and optional TCP transport.
2. Register every tool defined in `SPEC.md`.
3. Validate tool arguments with shared contracts and translate validation failures into `E_MCP_INVALID_ARGS`.
4. Marshal core results and errors into stable tool payloads.
5. Add contract tests asserting CLI JSON and MCP payload parity.

# Verification steps

1. Run `pnpm --filter @probefn/mcp-server test`.
   Expected outcome: MCP contract tests pass.
2. Run `pnpm probefn mcp serve`.
   Expected outcome: the server starts successfully and registers all expected tools.
3. Execute an MCP test harness call for `probefn_page_get_console`.
   Expected outcome: the returned payload matches the CLI JSON shape for the same action.

# Stop condition

Report the registered tool list, one parity assertion, and one invalid-args error payload before starting Phase 10.
