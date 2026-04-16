# Phase goal

Implement canonical messaging envelopes, request routing, event fanout, persistent ports, reconnect behavior, and modular background handler discovery.

# In scope / Out of scope

- In scope:
  - request, response, and event envelopes
  - port-message and port-close envelopes
  - namespace and method routing
  - long-lived port channels
  - reconnect behavior for background suspension and restart
  - timeout handling
  - payload size enforcement
  - modular handler discovery from `messageHandlersDir`
  - modular handler discovery from `portHandlersDir`
- Out of scope:
  - content-script anchor runtime
  - DataFn-specific routes

# Deliverables

- Create `extfn/core/src/runtime/envelope.ts`
- Create `extfn/core/src/runtime/router.ts`
- Create `extfn/core/src/runtime/events.ts`
- Create `extfn/core/src/runtime/ports.ts`
- Create `extfn/core/src/runtime/errors.ts`
- Create `extfn/vite/src/discovery/backgroundHandlers.ts`
- Create `extfn/vite/src/discovery/backgroundPorts.ts`
- Create `extfn/core/__tests__/router.test.ts`
- Create `extfn/core/__tests__/events.test.ts`
- Create `extfn/core/__tests__/ports.test.ts`
- Create `extfn/vite/__tests__/backgroundHandlers.test.ts`
- Create `extfn/vite/__tests__/backgroundPorts.test.ts`

# Requirements covered

- `MSG-001`
- `MSG-002`
- `MSG-003`
- `MSG-004`
- `MSG-005`
- `SURF-002`
- `SURF-003`
- `PLG-002`

# Implementation tasks

- Define `RuntimeRequestEnvelope`, `RuntimeResponseEnvelope`, and `RuntimeEventEnvelope`.
- Define `RuntimePortEnvelope` and `RuntimePortCloseEnvelope`.
- Implement request dispatch keyed by `namespace + method`.
- Implement port open, ordered delivery, close, and close-reason handling keyed by `channel`.
- Implement timeout behavior and payload-size validation.
- Implement modular background handler discovery from a configured directory.
- Implement modular background port discovery from a configured directory.
- Reject invalid handler modules.
- Reject duplicate `namespace + method` registrations.
- Reject duplicate `channel` registrations.
- Implement event listener registration and ordered fanout.
- Implement reconnect semantics for background suspension and restart without duplicate listener or subscription registration.

# Verification steps

- Run `npm run test -- --filter=@superfunctions/extfn`
- Run `npm run test -- --filter=@superfunctions/extfn-vite`
- Expected outcomes:
  - valid envelopes route correctly
  - invalid envelopes fail with `E_RUNTIME_PROTOCOL`
  - duplicate handlers fail with `E_MANIFEST_COLLISION`
  - duplicate port channels fail with `E_MANIFEST_COLLISION`
  - timeout and payload-limit fixtures fail with the correct error codes
  - reconnect fixtures show `open -> reconnecting -> open` or `open -> reconnecting -> closed`

# Stop condition

Stop after RPC, event, and port fixtures pass and the runtime can discover modular background handlers and background port handlers deterministically.
