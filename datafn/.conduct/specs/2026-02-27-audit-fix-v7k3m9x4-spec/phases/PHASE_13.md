# PHASE 13: Structured Logging

## Phase goal
Implement pluggable logger interface, replace all console.* calls, extend redaction.

## In scope
- LOG-001: DatafnLogger interface + default implementation
- LOG-002: Replace all console.* calls with logger.*
- LOG-003: Structured context in log calls (request ID, namespace, operation)

## Out of scope
- External logger integrations (pino, winston)
- Log aggregation infrastructure

## Deliverables
- `datafn/server/src/logger.ts` — NEW: DatafnLogger default implementation + createLogger factory
- `datafn/server/src/server.ts` — Wire logger into config, inject into all subsystems
- All server source files that use `console.*` — Replace with `logger.*`
- `datafn/server/src/logging.ts` — Extended redaction

## Requirements covered
LOG-001, LOG-002, LOG-003, LOW-004

## Implementation tasks
1. **Logger interface** (`logger.ts`):
   - Create default console-based implementation:
     ```typescript
     function createDefaultLogger(debug: boolean): DatafnLogger {
       return {
         info: (msg, ctx) => console.log(JSON.stringify({ level: "info", msg, ...ctx, ts: Date.now() })),
         warn: (msg, ctx) => console.warn(JSON.stringify({ level: "warn", msg, ...ctx, ts: Date.now() })),
         error: (msg, ctx) => console.error(JSON.stringify({ level: "error", msg, ...ctx, ts: Date.now() })),
         debug: debug ? (msg, ctx) => console.log(JSON.stringify({ level: "debug", msg, ...ctx, ts: Date.now() })) : () => {},
       };
     }
     ```
   - Pretty-print mode when `debug: true`: `[INFO] msg {context}` format instead of JSON

2. **Wire into config** (`server.ts`):
   - `const logger = config.logger ?? createDefaultLogger(config.debug ?? process.env.NODE_ENV !== "production")`
   - Pass `logger` to all subsystems (routes, execution, WS, middleware)

3. **Replace console calls**:
   - Search all server src files for `console.log`, `console.warn`, `console.error`
   - Replace with `logger.info`, `logger.warn`, `logger.error`
   - Add structured context where available: `{ namespace, operation, resource, duration_ms }`

4. **Extend redaction** (`logging.ts`):
   - Add case-insensitive matching for: `password`, `token`, `secret`, `authorization`, `cookie`, `apikey`, `api_key`
   - Keep existing `encrypt: true` check

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- No remaining `console.log/warn/error` in server src (except in logger implementation)
- Custom logger injection works:
  ```typescript
  const logs: string[] = [];
  const server = createDatafnServer({
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} }
  });
  // Make a request
  // Assert logs array contains expected entries
  ```

## Stop condition
All console.* replaced. Logger interface works. Custom logger injectable. Report results.
