# PHASE_02
## Phase goal
Replace the required `remote: DatafnRemoteAdapter` configuration with a default HTTP transport driven by `sync.remote`.

## In scope
- Update `createDatafnClient` config to follow the `sync` shape defined in `SPEC.md`.
- Implement a default HTTP transport that calls `@datafn/server` endpoints at `${sync.remote}/*`.
- Ensure query/mutation/transact/clone/pull/push requests are routed through the internal transport.

## Out of scope
- Supporting custom transports/adapters beyond the default HTTP case (Undefined unless explicitly implemented).

## Deliverables
- Modify: `datafn/client/src/client.ts`
- Create: `datafn/client/src/transport/http.ts`
- Modify: `datafn/client/src/query.ts`
- Modify: `datafn/client/src/mutate.ts`
- Modify: `datafn/client/src/transact.ts`
- Update docs: `datafn/client/README.md`

## Requirements covered
- CFG-001

## Implementation tasks
1. Define an internal HTTP transport that uses `fetch` to call:
   - `${remote}/query`
   - `${remote}/mutation`
   - `${remote}/transact`
   - `${remote}/clone`
   - `${remote}/pull`
   - `${remote}/push`
2. Update `createDatafnClient` to accept `sync.remote` instead of `remote` adapter.
3. Ensure the existing response unwrapping (`unwrapRemoteSuccess`) still applies.
4. Update README examples to match the new configuration.

## Verification steps
- `npm --prefix datafn/client test`
- `npm --prefix datafn/client build`

Expected outcomes:
- Tests pass.
- Build passes.

## Stop condition
Report the new config surface and confirm the README example compiles before starting PHASE_03.
