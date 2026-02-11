# PHASE_06
## Phase goal
Add WebSocket-based pull notifications (`ws:true`) for near-real-time sync.

## In scope
- Server websocket endpoint at `/datafn/ws` implementing the minimal message protocol from `SPEC.md`.
- Client websocket connection management and pull triggering on cursor notifications.
- Safe handling of unknown websocket messages.

## Out of scope
- Authentication and authorization on the websocket (Undefined).

## Deliverables
- Modify: `datafn/server/src/server.ts` (or routing layer) to expose websocket upgrade handling.
- Create: `datafn/server/src/ws.ts` (websocket handler implementation)
- Modify: `datafn/client/src/sync/engine.ts` (ws connection + triggers)
- Add tests:
  - Server-side websocket behavior tests (framework-dependent)
  - Client-side ws trigger tests

## Requirements covered
- WS-001

## Implementation tasks
1. Implement server websocket handler that:
   - accepts `hello` messages
   - sends `cursor` messages when new changes are recorded
2. Implement client websocket handler that:
   - connects to `${remote}/ws`
   - sends `hello` with `clientId` and current cursor
   - triggers pull when receiving a higher cursor
   - ignores unknown messages
3. Add tests for:
   - cursor notification triggers pull
   - unknown messages do not change cursor

## Verification steps
- `npm --prefix datafn/server test`
- `npm --prefix datafn/client test`

Expected outcomes:
- Tests pass.

## Stop condition
Report the websocket endpoint path and the exact message shapes validated by tests.
