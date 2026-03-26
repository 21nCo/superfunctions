# Phase goal

Create the `authfn/examples` workspace scaffolding and the shared deterministic harness used by all example apps.

## In scope / Out of scope

- In scope:
  - root workspace updates
  - shared package scaffolding
  - shared README and optional shared Docker Compose
  - shared reset/events/OTP/fake-provider helpers
  - shared selector/test helper conventions
- Out of scope:
  - individual example-specific UI flows
  - authfn client API expansion

## Deliverables

- `package.json`
- `authfn/examples/README.md`
- `authfn/examples/shared/package.json`
- `authfn/examples/shared/tsconfig.json`
- `authfn/examples/shared/src/index.ts`
- `authfn/examples/shared/src/server/create-example-server.ts`
- `authfn/examples/shared/src/server/demo-routes.ts`
- `authfn/examples/shared/src/server/event-buffer.ts`
- `authfn/examples/shared/src/server/otp-inbox.ts`
- `authfn/examples/shared/src/server/fake-oauth-provider.ts`
- `authfn/examples/shared/src/client/testids.ts`
- `authfn/examples/shared/src/e2e/helpers.ts`
- `authfn/examples/docker-compose.yml`

## Requirements covered

- `EXAUTH-001`
- `EXAUTH-002`
- `EXAUTH-011`
- `EXAUTH-013`

## Implementation tasks

1. Add `authfn/examples/*` and `authfn/examples/*/*` to the root workspaces.
2. Create `authfn/examples/README.md` with a short portfolio matrix and shared setup instructions.
3. Create the private `authfn/examples/shared` package and export server, client, and e2e helpers.
4. Implement the shared demo envelope types and demo route helpers for reset/events/OTP.
5. Implement a local fake-provider scaffold reusable by the social example.
6. Add shared selector constants or builders for the stable `data-testid` contract.
7. Add an optional shared Postgres Docker Compose definition and env conventions.

## Verification steps

- Run `npm install`
  - Expected: new example workspaces resolve without workspace errors.
- Run `npm --workspace @authfn/examples-shared test` if a shared test script exists, or `npm --workspace @authfn/examples-shared run build`
  - Expected: shared package builds cleanly.
- Start a minimal shared-harness smoke server and call:

```bash
curl -X POST http://127.0.0.1:<port>/demo/reset \
  -H 'content-type: application/json' \
  -d '{"scenario":"baseline"}'
```

  - Expected: canonical success envelope returned.

## Stop condition

Report the shared package API surface, the root workspace edits, and the demo-route contract before starting Phase 02.
