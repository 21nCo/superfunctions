# Phase 16: Mock Server

## Phase Goal
Implement a mock server that generates synthetic responses from an OpenAPI spec.

## In Scope
- `createMockServer(options)` — create and start mock server
- Response modes: schema, examples, random
- Request validation (optional)
- Configurable delay
- CORS support
- Uses `@superfunctions/http` for the server

## Out of Scope
- CLI mock command (next phase)
- Stateful mocking (POST creates, GET returns)

## Deliverables
- `apifn/mock/src/server.ts`
- `apifn/mock/src/response-generator.ts`
- `apifn/mock/src/request-validator.ts`
- `apifn/mock/__tests__/mock-server.test.ts`

## Requirements Covered
- MOCK-001, MOCK-002, MOCK-003, MOCK-004, MOCK-005, MOCK-006, MOCK-007

## Implementation Tasks
1. [ ] Implement response generator: schema mode (deterministic defaults), examples mode, random mode
2. [ ] Implement request validator: validate body and params against operation schemas
3. [ ] Implement mock router: register handler per path+method from spec
4. [ ] Implement delay middleware
5. [ ] Implement CORS middleware
6. [ ] Implement `createMockServer()`: build router, create server, return start/stop
7. [ ] Write integration tests: start mock, send requests, validate responses
8. [ ] Export from mock index

## Verification Steps
1. `npm run test` → mock server tests pass
2. TV-MOCK-002: Schema mode returns deterministic defaults
3. TV-MOCK-005: Invalid request body → 400
4. Mock server starts and stops cleanly

## Stop Condition
Mock server generates correct responses for all modes. Request validation works.
