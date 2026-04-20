# Execution Plan

## Architecture sketch

- `recfn/core`
  - shared public types, validators, frame schemas, formatters, analytics helpers
- `recfn/server`
  - HTTP routes, WebSocket server, orchestration, durable repositories, secret resolution, observability, calendar runtime
- `recfn/platforms/zoom`
  - Zoom-specific join/media/chat/participant behavior
- `recfn/platforms/browser-core`
  - shared browser automation lifecycle for Meet and Teams
- `recfn/platforms/meet`
  - Meet-specific selectors, auth quirks, capture requirements
- `recfn/platforms/teams`
  - Teams-specific selectors, auth quirks, capture requirements
- `recfn/adapters/shared-cloud`
  - shared cloud ASR transport/polling helpers
- `recfn/adapters/*`
  - provider-specific ASR adapters
- `recfn/client`
  - canonical TypeScript SDK
- `recfn/python`
  - parity Python SDK
- `recfn/cli`
  - user-facing command-line tooling
- `recfn/desktop`
  - local capture, upload, and optional local transcription

## Dependency graph

1. Durable DB and shared storage integration MUST exist before aggregate API and finalization work can be completed.
2. Aggregate persistence for metadata/chat MUST exist before API aggregate responses and search enrichment can be completed.
3. Canonical WebSocket frames MUST be defined before SDK parity work is complete.
4. Browser core MUST exist before Meet/Teams duplication cleanup is complete.
5. Real streaming capability gating MUST exist before production real-time transcription claims can be restored.
6. Observability and build gates are final cross-cutting release blockers and MUST validate all earlier phases.

## Phases overview

| Phase | Goal | Delivered capability | Verification method |
|---|---|---|---|
| `00` | Establish durable persistence and shared storage seams | shared DB/storage production path | repo-root unit tests for persistence/storage |
| `01` | Persist aggregate bot-related data | chat + metadata persistence and aggregate bot response | API tests for `/bots/:id`, `/chat`, `/metadata` |
| `02` | Fix WebSocket security and schema compatibility | namespace-safe WS auth and canonical frames | WS auth + SDK stream tests |
| `03` | Restore automatic bot recording finalization | leave/end-of-meeting produces uploaded recordings | bot worker + recording pipeline tests |
| `04` | Harden Zoom to full production path | zoom end-to-end recording lifecycle | zoom adapter + e2e tests |
| `05` | Extract shared browser core | duplication reduction for Meet/Teams common logic | browser-core and platform adapter tests |
| `06` | Implement production Meet capture | Meet recording path becomes real | meet adapter integration tests |
| `07` | Implement production Teams capture | Teams recording path becomes real | teams adapter integration tests |
| `08` | Consolidate ASR helpers and restore honest live transcription | real streaming capability gate + shared cloud ASR helpers | realtime transcription and adapter tests |
| `09` | Make search and calendars production-safe | participant-aware search and runtime scheduling services | search and calendar runtime tests |
| `10` | Close SDK, CLI, and desktop gaps | Python parity, CLI redaction defaults, desktop lifecycle control | SDK/CLI/desktop tests |
| `11` | Wire observability, compatibility, and release gates | migration docs, metrics/logging, repo-root verification | repo-root build/test/typecheck gate |

## Definition of Done

No phase is complete unless its verification steps pass from `repo root`.

