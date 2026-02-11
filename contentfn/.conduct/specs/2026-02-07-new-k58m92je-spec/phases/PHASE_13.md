# PHASE_13: CLI (schema + dataset + doc ops)

## Phase goal

Deliver a CLI that automates schema validation/upsert, dataset export/import, and basic document operations.

## In scope

- CLI commands (names are normative for this phase):
  - `contentfn schema validate <file>`
  - `contentfn schema upsert --dataset <name> --file <file>`
  - `contentfn dataset export --dataset <name> --out <file>`
  - `contentfn dataset import --dataset <name> --in <file>`
  - `contentfn doc get --dataset <name> --id <id> --perspective <published|draft>`
- Deterministic error messages and exit codes.

## Out of scope

- Interactive TUI studio (belongs to `cmsfn`)

## Deliverables

- `contentfn/cli/package.json`
- `contentfn/cli/src/index.ts` (entrypoint)
- `contentfn/cli/src/commands/schema.ts`
- `contentfn/cli/src/commands/dataset.ts`
- `contentfn/cli/src/commands/doc.ts`
- `contentfn/cli/src/http/client.ts` (reuse `@contentfn/client` where possible)
- Tests (or golden CLI transcript tests) implementing:
  - TV-CLI-001
  - TV-CLI-002
  - TV-CLI-003

## Requirements covered

- CLI-001

## Implementation tasks

1. Choose CLI parser library (or minimal custom parser) and document it.
2. Implement schema validate:
   - read file
   - validate via `@contentfn/core`
   - exit 0 on success
3. Implement schema upsert:
   - call server schema upsert endpoint
4. Implement dataset export/import:
   - export writes artifact to file
   - import reads artifact from file
5. Implement doc get:
   - call docs.get endpoint and print JSON
6. Add tests:
   - validate success output
   - export/import end-to-end
   - missing file yields non-zero exit code

## Verification steps

- Run CLI tests.
- Manual run: validate a schema file and upsert it to a running server.

## Stop condition

- CLI passes referenced TVs and is usable for automation.

