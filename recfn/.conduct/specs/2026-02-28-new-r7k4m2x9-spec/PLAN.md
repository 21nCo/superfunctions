# RecFn Implementation Plan

## Architecture sketch

- **recfn/core/** (TypeScript): Shared types (Bot, Recording, Transcript, Segment, Participant, etc.), ASR adapter interface, platform adapter interface, transcript export formatters (SRT, VTT, text), analytics computation, URL validation, error codes. Zero runtime dependencies on server/platform specifics.
- **recfn/server/** (TypeScript): Bot orchestration server. HTTP API routes (bots, recordings, transcripts, participants, chat, analytics, calendars, webhooks). WebSocket server for real-time transcript streaming. Bot worker (picks up flowfn jobs, manages platform adapters). Uses @superfunctions/http for routes, @superfunctions/db for persistence, flowfn for job queues, filefn for storage, secfn for auth, plugfn for webhooks, logfn for logging.
- **recfn/client/** (TypeScript): Client SDK. RecFn class with namespaced methods (bots, recordings, transcripts, participants, chat, analytics, calendars, webhooks). WebSocket helper for real-time streaming. Uses fetch and WebSocket APIs.
- **recfn/python/** (Python): Python client SDK. Feature parity with TypeScript client. Uses httpx + websockets.
- **recfn/cli/** (TypeScript): CLI tool (`recfn`). Commands: bot create/status/leave/list, recording list/download, transcript get/search, analytics, calendar add/list. Calls server REST API.
- **recfn/platforms/zoom/** (TypeScript): Zoom platform adapter implementing PlatformAdapter interface. Uses Zoom Meeting SDK for bot join/leave, audio/video capture, participant tracking, chat.
- **recfn/platforms/meet/** (TypeScript): Google Meet platform adapter. Headless browser (Puppeteer/Playwright) approach for join/leave, WebRTC audio capture, DOM-based participant/chat tracking.
- **recfn/platforms/teams/** (TypeScript): Microsoft Teams platform adapter. Graph Communications API or headless browser.
- **recfn/adapters/whisper/** (TypeScript): Whisper ASR adapter. Invokes whisper.cpp or openai-whisper via child process. CPU mode by default, GPU optional.
- **recfn/adapters/deepgram/** (TypeScript): Deepgram ASR adapter. Real-time streaming and batch via Deepgram API.
- **recfn/adapters/assemblyai/** (TypeScript): AssemblyAI ASR adapter. Batch and real-time via AssemblyAI API.
- **recfn/adapters/google-stt/** (TypeScript): Google Speech-to-Text ASR adapter.
- **recfn/desktop/** (TypeScript + Rust/Electron): Desktop capture SDK. System audio + screen capture without visible bot. Local transcription via Whisper.

## Dependency graph

1. **recfn/core** (types, interfaces, formatters, validators): Must exist first — all other modules depend on it.
2. **recfn/server** core (DB schema, store, API routes without bot worker): Depends on core. Required before client/CLI can be tested against a live server.
3. **recfn/server** bot worker (flowfn integration, bot lifecycle state machine): Depends on core + server store.
4. **recfn/adapters/whisper**: Depends on core (AsrAdapter interface). First ASR adapter — enables end-to-end transcription.
5. **recfn/platforms/zoom**: Depends on core (PlatformAdapter interface). First platform adapter — enables end-to-end bot lifecycle.
6. **recfn/server** WebSocket (real-time transcript streaming): Depends on server core + ASR adapter.
7. **recfn/server** webhooks: Depends on server core + plugfn.
8. **recfn/client**: Depends on server API being defined (types from core). Can be developed in parallel with server.
9. **recfn/cli**: Depends on client SDK.
10. **recfn/platforms/meet**: Depends on core. Independent of zoom adapter.
11. **recfn/platforms/teams**: Depends on core. Independent of other platform adapters.
12. **recfn/adapters/deepgram**: Depends on core. Independent of whisper adapter.
13. **recfn/adapters/assemblyai**: Depends on core. Independent.
14. **recfn/adapters/google-stt**: Depends on core. Independent.
15. **recfn/server** calendar integration: Depends on server core + secfn.
16. **recfn/server** analytics + search: Depends on server core + transcription pipeline + searchfn.
17. **recfn/python**: Depends on API definition (types from core). Independent of TypeScript client.
18. **recfn/desktop**: Depends on core + whisper adapter. Largely independent of server.

## Phases overview

| Phase | Goal | Delivered capability | Verification |
|-------|------|----------------------|--------------|
| 00 | Core types, interfaces, and validators | Types, AsrAdapter/PlatformAdapter interfaces, error codes, URL validator, transcript formatters | Unit tests for types, validators, formatters |
| 01 | Server foundation: DB schema, store, API skeleton | Server with in-memory store, CRUD endpoints for bots (no actual bot joining), envelope responses, auth middleware | TV-BOT-001, TV-BOT-002, TV-API-001–005 |
| 02 | Bot lifecycle state machine and flowfn integration | Bot status transitions, flowfn job queue, bot worker skeleton (mock platform) | TV-BOT-003, TV-BOT-004, TV-BOT-005, TV-BOT-006, TV-INT-001 |
| 03 | Zoom platform adapter | Zoom bot joins/leaves meetings, captures audio, tracks participants, captures chat | TV-PLAT-001, TV-PAR-001, TV-CHAT-001 |
| 04 | Recording capture and storage (filefn) | Recording created after bot leaves, stored in filefn, download via signed URL | TV-REC-001–005, TV-INT-002 |
| 05 | Whisper ASR adapter and batch transcription | Whisper adapter, POST /transcribe endpoint, transcript stored and retrievable | TV-ASR-001, TV-TRX-002, TV-TRX-003, TV-TRX-005 |
| 06 | Real-time transcription and WebSocket streaming | WebSocket endpoint, real-time segments from ASR during live meeting | TV-TRX-001, TV-WS-001, TV-WS-002 |
| 07 | Transcript export formats (SRT, VTT, text) | format query param on transcript endpoint, export formatters | TV-EXP-001, TV-EXP-002, TV-TRX-005 |
| 08 | Webhook events via plugfn | Webhook CRUD, event delivery for all lifecycle events, HMAC signing | TV-WH-001–005, TV-INT-003 |
| 09 | Consent mechanism and participant tracking | Consent message on join, consent status per participant, PII handling | TV-BOT-008, TV-BOT-010, TV-PAR-002, TV-SEC-006 |
| 10 | Google Meet platform adapter | Meet bot joins/leaves via headless browser, audio/participant/chat capture | TV-PLAT-002 |
| 11 | Microsoft Teams platform adapter | Teams bot joins/leaves, audio/participant/chat capture | TV-PLAT-003 |
| 12 | TypeScript client SDK | RecFn client class with all namespaced methods, WebSocket streaming helper | TV-SDK-001, TV-SDK-003 |
| 13 | CLI tool | recfn CLI with all commands, human and JSON output | TV-CLI-001–003 |
| 14 | Analytics and transcript search (searchfn) | Analytics computation, search indexing, GET /analytics and /transcripts/search | TV-ANA-001–003, TV-SRCH-001–002 |
| 15 | Calendar integration | Calendar CRUD, event discovery, auto-scheduling, token refresh | TV-CAL-001–005 |
| 16 | Cloud ASR adapters (Deepgram, AssemblyAI, Google STT) | Three additional ASR adapters | TV-ASR-002–004 |
| 17 | Python client SDK | Python RecFn client with feature parity, async WebSocket streaming | TV-SDK-002 |
| 18 | Desktop capture SDK | Electron/Tauri desktop capture, local Whisper transcription, server upload | TV-DSK-001–003 |
| 19 | Limits, rate limiting, security hardening | Enforce all limits, rate limiting, PII redaction, security audit | TV-LIMIT-001–003, TV-SEC-001–004, TV-EXP-003 |
| 20 | Observability, metrics, and polish | logfn integration, metrics, join latency tracking, final testing | TV-OBS-001–003, TV-INT-005 |

## Definition of Done (global)

No phase is complete unless:
1. All deliverables for that phase are implemented and committed.
2. Verification steps for that phase pass (exact commands or manual steps as in phases/PHASE_XX.md).
3. No regressions in previous phases (all prior tests still pass).
4. Code follows superfunctions conventions: @superfunctions/http, @superfunctions/db, envelope pattern, TypeScript strict mode.
