# Phase 13: CLI tool

## Phase goal
Implement the recfn CLI tool with all commands for bot management, recording access, transcript retrieval, analytics, and calendar management.

## In scope
- CLI binary `recfn` with subcommands.
- Commands: bot create/status/leave/list, recording list/download, transcript get/search, analytics, calendar add/list.
- Human-readable default output, JSON output via --format json.
- Configuration via RECFN_API_KEY and RECFN_SERVER_URL env vars.
- No secrets in output.

## Out of scope
- Python CLI. Desktop.

## Deliverables
- `recfn/cli/package.json` (bin: { recfn: "./dist/index.js" })
- `recfn/cli/tsconfig.json`
- `recfn/cli/src/index.ts` — CLI entry point, command router
- `recfn/cli/src/commands/bot.ts` — bot subcommands
- `recfn/cli/src/commands/recording.ts` — recording subcommands
- `recfn/cli/src/commands/transcript.ts` — transcript subcommands
- `recfn/cli/src/commands/analytics.ts` — analytics command
- `recfn/cli/src/commands/calendar.ts` — calendar subcommands
- `recfn/cli/src/output.ts` — human-readable output formatter
- `recfn/cli/src/config.ts` — env var and config file loader
- `recfn/cli/__tests__/cli.test.ts`

## Requirements covered
- CLI-001, CLI-002, CLI-003, CLI-004

## Implementation tasks
1. Create `recfn/cli/` with package.json (deps: recfn-client, commander or yargs).
2. Set up CLI entry point with command routing.
3. Implement config.ts: read RECFN_API_KEY, RECFN_SERVER_URL from env. Error if missing.
4. Implement bot commands: create (POST /bots), status (GET /bots/:id), leave (POST leave), list (GET /bots).
5. Implement recording commands: list (GET /bots/:id/recordings), download (GET download, write to file).
6. Implement transcript commands: get (GET transcript with format param, write to file or stdout), search (GET search).
7. Implement analytics command: GET analytics, display table.
8. Implement calendar commands: add (POST /calendars), list (GET /calendars).
9. Implement output.ts: human-readable table/text output. --format json outputs raw API JSON.
10. Ensure no secrets in output: API key never printed.
11. Write tests: mock client, verify output format, verify no secrets leaked.

## Verification steps
- `cd recfn/cli && npm install && npm run build` — builds.
- `cd recfn/cli && npx vitest run` — tests pass.
- `node dist/index.js bot list --format json` → JSON output.
- Tests cover: TV-CLI-001, TV-CLI-002, TV-CLI-003.

## Stop condition
- All CLI commands work. Human and JSON output modes work. No secrets in output. Tests pass. Report: "Phase 13 complete; CLI ready for Phase 14."
