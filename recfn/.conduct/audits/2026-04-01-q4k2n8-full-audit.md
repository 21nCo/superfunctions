# Metadata

- Timestamp: `2026-04-01T10:07:35Z`
- Agent name: `unknown-agent`
- Model: `gpt-5`
- Launcher: `Codex Desktop`
- Workspace/project path: `repo root`
- OS: `Darwin arm64`
- Shell: `zsh`
- Git: detached `HEAD`, commit `7adae771e458`, dirty status `clean`
- Intent/notes paths audited:
  - `AGENTS.md`
  - user task prompt requesting a production-readiness audit for `recfn` for `nucleus`, including major meeting-platform support and duplication/shared-package review
  - `recfn/README.md`
  - `recfn/platforms/meet/README.md`
  - `recfn/platforms/teams/README.md`
  - `recfn/python/README.md`
  - `pop.md`
- Spec bundle paths audited:
  - `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/`
  - included files: `INTENT_AUDIT.md`, `SPEC.md`, `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`
  - included phases: `phases/PHASE_00.md` through `phases/PHASE_20.md`
  - `phase-reports/` observed as historical context only and not used as pass/fail authority
- Codebase scope audited:
  - `recfn/core/`
  - `recfn/server/`
  - `recfn/client/`
  - `recfn/cli/`
  - `recfn/desktop/`
  - `recfn/platforms/zoom/`
  - `recfn/platforms/meet/`
  - `recfn/platforms/teams/`
  - `recfn/adapters/whisper/`
  - `recfn/adapters/deepgram/`
  - `recfn/adapters/assemblyai/`
  - `recfn/adapters/google-stt/`
  - `recfn/python/`
  - excluded: `node_modules/`, `dist/`

# Audit scope

This is a full, read-only audit of `recfn` against:

1. the authoritative user intent represented by the current task and repository context
2. the full spec bundle at `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/`

The audit specifically answers whether `recfn` is production-ready for use in `nucleus` for meeting recording and transcription across major meeting platforms, and it also evaluates code duplication and missed reuse of shared Superfunctions packages.

Verdict: `recfn` is not production-ready for the requested `nucleus` use case today.

The decisive blockers are:

1. Google Meet and Microsoft Teams audio capture are still stubbed, so real recording/transcription is not implemented there.
2. The bot lifecycle never captures and uploads a recording after a meeting; only the manual upload route creates recordings.
3. WebSocket authentication does not enforce namespace ownership of the requested `botId`.
4. Chat and metadata persistence are effectively unimplemented on the server side.
5. The Python SDK is not at feature parity with the TypeScript SDK.
6. The TypeScript packages are not cleanly typecheckable from the current package configs, and the top-level `turbo` test path was not green in this checkout.

# Inputs audited (intent + spec bundles)

## Intent sources

- Current task: production readiness for `nucleus`, meeting recording/transcription, all major meeting platforms, duplication/shared-package review.
- Repository guidance in `AGENTS.md`.
- Function-level docs in `recfn/README.md`, `recfn/platforms/meet/README.md`, `recfn/platforms/teams/README.md`, and `recfn/python/README.md`.
- Existing intent inventory in `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/INTENT_AUDIT.md`.

## Spec bundle inventory

- `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/SPEC.md`
- `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/REQUIREMENTS.md`
- `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/TEST_VECTORS.md`
- `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/PLAN.md`
- `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/phases/PHASE_00.md` through `PHASE_20.md`

## Verification approach

- Static audit across implementation and tests.
- Targeted command execution for test/build sanity, typechecking, and duplication analysis.
- External platform APIs, browser automation, Zoom SDK integration, and cloud ASR backends were not live-exercised in this audit environment.

# High-level findings

1. `recfn` is currently best described as a prototype or pre-production implementation, not a production-ready cross-platform recording/transcription system.
2. Zoom has the strongest implementation surface. Google Meet and Microsoft Teams are not ready for recording/transcription because their audio capture implementations return zero-byte placeholder streams: `recfn/platforms/meet/src/audio-capture.ts:37-49`, `recfn/platforms/teams/src/audio-capture.ts:26-33`.
3. The bot worker never turns meeting media into a recording artifact. The only implemented creation path is the manual upload endpoint at `recfn/server/src/routes/upload.ts:33-117`; the queue name `recfn.recording.upload` exists but is unused in code: `recfn/server/src/integrations/flowfn.ts:15-18`.
4. WebSocket authorization has a production-blocking security flaw. It validates a token but never verifies that the requested `botId` belongs to the authenticated namespace: `recfn/server/src/ws/auth.ts:11-33`, `recfn/server/src/ws/server.ts:60-68`.
5. Several API contract gaps remain: `GET /bots/:botId` omits nested participants/recordings/metadata (`recfn/server/src/routes/bots.ts:115-123`), metadata is never written (`recfn/server/src/store/types.ts:79-84`, `recfn/server/src/store/memory.ts:316-326`, `recfn/server/src/routes/metadata.ts:30-38`), and chat messages are never persisted to the store.
6. Client compatibility is incomplete. The server emits WebSocket `status` frames as `{ status: ... }`, while both client SDKs expect `{ botStatus: ... }`: `recfn/server/src/worker/lifecycle.ts:62-64`, `recfn/client/src/ws.ts:8`, `recfn/python/recfn/ws.py:61-63`.
7. Duplication is meaningful but not the main blocker. `jscpd` reported `1012` duplicated lines (`5.66%`) and `8921` duplicated tokens (`5.24%`). The most obvious duplication is between Meet and Teams adapters, which are roughly `93%` similar in `index.ts`, `95%` similar in `chat.ts`, and `92%` similar in `participants.ts`.

## Platform readiness for `nucleus`

| Platform | Readiness | Notes |
|---|---|---|
| Zoom | `Prototype` | Zoom SDK adapter exists and is the closest to usable, but bot-driven recording creation is still missing. |
| Google Meet | `Not ready` | Headless-browser join exists, but audio capture is a stub and server persistence is incomplete. |
| Microsoft Teams | `Not ready` | Headless-browser join exists, but audio capture is a stub and server persistence is incomplete. |
| Other platforms | `Unsupported` | The current spec and code only implement Zoom, Meet, Teams, and a desktop helper. |

# Intent Inventory

1. Meeting bot API: send bots to Zoom, Google Meet, and Microsoft Teams meetings by URL.
2. Bot lifecycle management: create, join, leave, status polling, and automatic leave on empty meetings.
3. Real-time transcription with speaker diarization and low-latency delivery over WebSocket.
4. Asynchronous post-meeting transcription with higher accuracy.
5. Recording capture of meeting media, including MP4 video and audio-only modes.
6. Separate participant audio tracks where a platform allows them.
7. Participant tracking: names, emails, roles, join times, leave times.
8. Chat message capture.
9. Calendar integration for upcoming meetings and auto-scheduling.
10. Webhook events for lifecycle, recording, transcript, and participant changes.
11. REST API coverage for bots, recordings, transcripts, participants, calendars, webhooks, chat, metadata, analytics, and search.
12. Multiple ASR providers: Whisper, Deepgram, AssemblyAI, Google Speech-to-Text.
13. Desktop recording SDK for system audio plus screen capture without a visible bot.
14. Recording storage through pluggable storage backends.
15. Transcript indexing and search.
16. Meeting analytics: talk time, silence, topic segmentation.
17. Export formats: SRT, VTT, JSON, plain text.
18. CLI coverage for the main workflows.
19. Python SDK parity with the TypeScript SDK.
20. Self-hosted operation with no mandatory third-party data custody.
21. Consent announcement before recording.
22. API-key authentication.
23. Namespace isolation.
24. Encryption at rest for recordings.
25. PII redaction.
26. Bot join latency under 10 seconds.
27. Real-time transcription latency under 2 seconds.
28. Support for 100 or more concurrent bots.
29. Recording upload within 60 seconds of meeting end.
30. `flowfn` integration.
31. `filefn` integration.
32. `searchfn` integration.
33. `memoryfn` remains consumer-side rather than being wrapped by `recfn`.
34. `logfn` integration.
35. `secfn` integration.
36. `plugfn` integration.
37. `sendfn` is optional.
38. No GPU required for baseline operation.
39. Platform adapters are modular.
40. ASR adapters are pluggable.
41. Canonical response envelope.
42. TypeScript client SDK coverage.
43. Configurable bot behavior through `BotConfig`.
44. Webhook HMAC signing.
45. At-least-once webhook delivery.
46. Platform auto-detection from meeting URL.
47. Production readiness for use inside `nucleus`.
48. Support for all major meeting platforms required by `nucleus`, not just the currently implemented three.
49. The audit must explicitly assess code duplication and improvements through shared Superfunctions packages where appropriate.

# Intent → Spec coverage matrix

| # | Intent item | Spec mapping | Coverage status |
|---|---|---|---|
| 1 | Meeting bot API | `BOT-001`, `PLAT-002`, `PLAT-003`, `PLAT-004` | Covered |
| 2 | Bot lifecycle management | `BOT-002`, `BOT-003`, `BOT-004`, `BOT-009` | Covered |
| 3 | Real-time transcription | `TRX-001`, `WS-001`, `WS-002` | Covered |
| 4 | Async transcription | `TRX-002`, `TRX-004` | Covered |
| 5 | Recording capture | `REC-001`, `REC-002` | Covered |
| 6 | Separate participant audio tracks | `REC-002` | Covered |
| 7 | Participant tracking | `PAR-001`, `PAR-003` | Covered |
| 8 | Chat message capture | `CHAT-001`, `CHAT-002` | Covered |
| 9 | Calendar integration | `CAL-001`, `CAL-002`, `CAL-003`, `CAL-004` | Covered |
| 10 | Webhook events | `WH-001`, `WH-002`, `WH-003`, `WH-004` | Covered |
| 11 | REST API coverage | `API-001` through `API-006`, plus `BOT-005` through `BOT-007`, `REC-006`, `SRCH-002` | Covered |
| 12 | Multiple ASR providers | `ASR-001` through `ASR-005` | Covered |
| 13 | Desktop recording SDK | `DSK-001`, `DSK-002`, `DSK-003` | Covered |
| 14 | Recording storage | `REC-003`, `REC-004`, `REC-005`, `INT-002` | Covered |
| 15 | Transcript indexing and search | `SRCH-001`, `SRCH-002`, `INT-003` | Covered |
| 16 | Analytics | `ANA-001`, `ANA-002`, `ANA-003` | Covered |
| 17 | Export formats | `TRX-005`, `EXP-001`, `EXP-002` | Covered |
| 18 | CLI | `CLI-001`, `CLI-002`, `CLI-003`, `CLI-004` | Covered |
| 19 | Python SDK parity | `SDK-002` | Covered |
| 20 | Self-hosted operation | `SEC-*`, `REC-*`, `ASR-002` | Covered |
| 21 | Consent announcement | `BOT-008`, `SEC-006` | Covered |
| 22 | API-key authentication | `API-002`, `SEC-001`, `INT-005` | Covered |
| 23 | Namespace isolation | `API-004`, `SEC-002` | Covered |
| 24 | Encryption at rest | `REC-004`, `SEC-003` | Covered |
| 25 | PII redaction | `TRX-008`, `EXP-002` | Covered |
| 26 | Join latency <10s | `OBS-003` | Covered |
| 27 | Real-time latency <2s | `TRX-001` | Covered |
| 28 | 100+ concurrent bots | `LIMIT-001` | Covered |
| 29 | Recording upload within 60s | `REC-003` | Covered |
| 30 | `flowfn` integration | `INT-001` | Covered |
| 31 | `filefn` integration | `INT-002` | Covered |
| 32 | `searchfn` integration | `INT-003`, `SRCH-001` | Covered |
| 33 | `memoryfn` consumer-side only | N/A by design in `INTENT_AUDIT.md` | Covered as consumer-side exception |
| 34 | `logfn` integration | `INT-006`, `OBS-001` | Covered |
| 35 | `secfn` integration | `INT-005`, `SEC-001`, `SEC-004` | Covered |
| 36 | `plugfn` integration | `INT-004`, `WH-*` | Covered |
| 37 | `sendfn` optional | N/A by design in `INTENT_AUDIT.md` | Covered as optional |
| 38 | No GPU required | `ASR-002` | Covered |
| 39 | Modular platform adapters | `PLAT-001` | Covered |
| 40 | Pluggable ASR adapters | `ASR-001` | Covered |
| 41 | Canonical envelope | `API-001` | Covered |
| 42 | TypeScript client SDK | `SDK-001`, `SDK-003` | Covered |
| 43 | Configurable `BotConfig` | `BOT-010` | Covered |
| 44 | Webhook HMAC signing | `WH-003`, `SEC-005` | Covered |
| 45 | At-least-once webhook delivery | `WH-004` | Covered |
| 46 | Platform auto-detection from URL | `BOT-001` | Covered |
| 47 | Production readiness for `nucleus` | No dedicated operational readiness requirements beyond feature coverage | `SPEC PARTIAL` |
| 48 | All major meeting platforms for `nucleus` | Current bundle only specifies Zoom, Meet, Teams, desktop | `SPEC MISSING` |
| 49 | Duplication and shared-package improvements | Partially implied by `API-005`, `API-006`, `INT-001` through `INT-006` | `SPEC PARTIAL` |

# Requirement coverage summary

## Bundle summary

| Spec bundle | PASS | PARTIAL | FAIL | UNVERIFIED | Notes |
|---|---:|---:|---:|---:|---|
| `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/` | 48 | 29 | 13 | 0 | Functional surface is broad, but cross-platform recording/transcription and production-hardening remain incomplete. |

## Highest-risk failed requirements

- `BOT-006` — bot detail endpoint does not return participants, recordings, or metadata.
- `REC-001` — bot-driven recording creation is not implemented.
- `REC-003` — no recording-upload pipeline runs after a bot leaves.
- `TRX-001` — real-time transcription is not actually streaming and cannot meet the stated latency target.
- `CHAT-001` — chat capture is not persisted through the server/API.
- `API-003` — pagination is not implemented consistently across list endpoints.
- `API-006` — server persistence does not use `@superfunctions/db`.
- `WS-002` — `status` frame schema is incompatible with both SDKs.
- `CLI-003` — CLI can output transcript PII by default.
- `SDK-002` — Python SDK is missing TypeScript parity.
- `SEC-002` — namespace isolation is broken for WebSockets.
- `SEC-004` — secrets are not fully managed through `secfn`.
- `INT-002` — storage uses a local abstraction instead of `filefn/storage`.

# Requirement-by-requirement results

## Bot lifecycle and management

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `BOT-001` | `PARTIAL` | `recfn/server/src/routes/bots.ts`, `recfn/server/src/worker/bot-worker.ts`, platform adapters | Bot creation, URL validation, and join queueing exist. Confidence is reduced by unverified external integrations and by the narrow supported-platform set. |
| `BOT-002` | `PASS` | `recfn/core/src/validators/state-machine.ts`, `recfn/server/src/worker/lifecycle.ts` | The lifecycle state machine and transition checks are implemented. |
| `BOT-003` | `PASS` | `recfn/server/src/routes/bots.ts:127-164` | Explicit leave is implemented with expected conflict handling. |
| `BOT-004` | `PASS` | `recfn/server/src/worker/auto-leave.ts`, `recfn/server/src/worker/bot-worker.ts:155-173` | Auto-leave logic is present and wired to participant events. |
| `BOT-005` | `PASS` | `recfn/server/src/routes/bots.ts:82-111`, `recfn/server/src/store/memory.ts:58-92` | Bot listing supports `limit`, `cursor`, `status`, and `platform`. |
| `BOT-006` | `FAIL` | `recfn/server/src/routes/bots.ts:115-123` | The detail endpoint returns only the raw bot object; it does not include nested participants, recordings, or metadata as required. |
| `BOT-007` | `PARTIAL` | `recfn/server/src/routes/bots.ts:167-187`, `recfn/server/src/store/memory.ts:109-128` | The in-memory store cascades some data deletion, but storage files, search index entries, and broader persistence cleanup are not handled. |
| `BOT-008` | `PASS` | `recfn/server/src/worker/consent.ts`, `recfn/server/src/worker/bot-worker.ts:108-114` | Consent is sent before transition to `recording`, with non-fatal failure handling. |
| `BOT-009` | `PASS` | `recfn/server/src/worker/bot-worker.ts:79-103` | Join timeout handling transitions bots to `error`. |
| `BOT-010` | `PASS` | `recfn/core/src/validators/bot-config.ts`, `recfn/server/src/routes/bots.ts:47-58` | `BotConfig` validation/defaulting covers the required fields. |

## Recording capture and storage

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `REC-001` | `FAIL` | `recfn/server/src/worker/bot-worker.ts:143-152`, `recfn/server/src/recording/capture.ts:14-56`, `recfn/server/src/routes/upload.ts:33-117` | The worker starts real-time transcription from `getAudioStream()` but never captures or uploads a meeting recording. Recordings are only created through the manual upload route. |
| `REC-002` | `PARTIAL` | `recfn/platforms/zoom/src/audio-capture.ts`, `recfn/server/src/recording/capture.ts` | Zoom exposes raw/per-participant audio helpers, but there is no integrated server pipeline using them and Meet/Teams do not implement equivalent capture. |
| `REC-003` | `FAIL` | `recfn/server/src/integrations/flowfn.ts:15-18`, `recfn/server/src/routes/upload.ts`, `rg` result showing no `RECORDING_UPLOAD` usage | The queue name exists, but no recording-upload processor or leave-triggered enqueue path is implemented. |
| `REC-004` | `PARTIAL` | `recfn/server/src/recording/storage.ts:83-86`, `recfn/server/src/integrations/filefn.ts:15-24` | The storage abstraction sets an `encryption` flag, but the shipped memory adapter does not perform real encryption at rest. |
| `REC-005` | `PASS` | `recfn/server/src/routes/recordings.ts:38-102`, `recfn/server/src/recording/signed-url.ts` | Signed download URLs are supported. |
| `REC-006` | `PASS` | `recfn/server/src/routes/recordings.ts:20-34` | Recording listing for a bot is implemented. |

## Transcription

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `TRX-001` | `FAIL` | `recfn/server/src/transcription/realtime.ts:19-41`, `recfn/adapters/whisper/src/index.ts:51-57`, `recfn/adapters/deepgram/src/index.ts:106-115`, `recfn/adapters/assemblyai/src/index.ts:113-121`, `recfn/adapters/google-stt/src/index.ts:122-130` | Whisper throws for streaming, and the cloud adapters buffer the full stream before yielding segments. This is not true live streaming and cannot satisfy the stated `<2s` latency target. |
| `TRX-002` | `PASS` | `recfn/server/src/transcription/pipeline.ts`, `recfn/server/src/routes/transcripts.ts:36-99` | Batch transcription pipeline is implemented. |
| `TRX-003` | `PARTIAL` | ASR adapters, `recfn/server/src/transcription/pipeline.ts`, participant tracking code | Segments carry `speakerId`, but stable mapping from ASR speaker labels to tracked `Participant` entities is not fully guaranteed. |
| `TRX-004` | `PASS` | `recfn/server/src/routes/transcripts.ts:51-61` | Duplicate in-progress transcriptions correctly return `409`. |
| `TRX-005` | `PASS` | `recfn/server/src/routes/transcripts.ts:102-187`, `recfn/core/src/formatters/` | Transcript retrieval and export formats are implemented. |
| `TRX-006` | `PASS` | `recfn/server/src/routes/transcripts.ts:18-23`, `recfn/server/src/transcription/pipeline.ts:20-25` | Segments are sorted by `startTime`, then `speakerId`. |
| `TRX-007` | `PARTIAL` | `recfn/core/src/validators/bot-config.ts`, `recfn/server/src/routes/transcripts.ts:63-65`, `recfn/server/src/worker/bot-worker.ts:143-152` | Provider/language can be configured for batch transcription and bot config, but the real-time path uses a single injected ASR adapter and does not honor per-bot provider selection. |
| `TRX-008` | `PASS` | `recfn/server/src/transcription/redact.ts`, `recfn/server/src/routes/transcripts.ts:134-152` | Redaction is implemented for exported transcripts. |

## Participant tracking

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `PAR-001` | `PARTIAL` | `recfn/server/src/worker/bot-worker.ts:121-140`, `recfn/server/src/store/memory.ts:244-300`, platform trackers | Participant state is captured from join/leave events, but metadata integrity is incomplete and initial/snapshot behavior is platform-dependent. |
| `PAR-002` | `PARTIAL` | `recfn/server/src/worker/bot-worker.ts:125-130`, `recfn/server/src/store/memory.ts:281-300` | Participants default to `pending`, and updates are possible, but there is no platform-driven mechanism for granted/denied consent states. |
| `PAR-003` | `PASS` | `recfn/server/src/worker/bot-worker.ts:120-140`, `recfn/server/src/webhooks/events.ts` | Join/leave webhook events are emitted. |

## Chat

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `CHAT-001` | `FAIL` | `recfn/server/src/store/types.ts:79-84`, `recfn/server/src/routes/chat.ts:18-30`, `recfn/server/src/worker/bot-worker.ts` (no chat subscription) | Platform adapters can capture chat locally, but the server never subscribes to `onChatMessage()` and the store has no write API for chat messages. The REST endpoint will therefore stay empty. |
| `CHAT-002` | `PASS` | `recfn/server/src/worker/consent.ts`, platform `sendChatMessage()` implementations | Outbound chat sending is implemented for consent/status messages. |

## Calendar integration

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `CAL-001` | `PARTIAL` | `recfn/server/src/routes/calendars.ts:36-82`, `recfn/server/package.json` OAuth dependencies | Calendars can be connected by supplying tokens, but first-class OAuth authorize/callback flows are not exposed by `recfn` itself. |
| `CAL-002` | `PASS` | `recfn/server/src/routes/calendars.ts:114-169`, `recfn/server/src/calendar/google.ts`, `recfn/server/src/calendar/outlook.ts` | Upcoming event discovery with meeting links is implemented. |
| `CAL-003` | `PARTIAL` | `recfn/server/src/calendar/scheduler.ts:28-114`, `recfn/server/src/index.ts` | The scheduler exists, but it is exported as a helper rather than being wired into a running production scheduler loop. |
| `CAL-004` | `PARTIAL` | `recfn/server/src/calendar/token-refresh.ts`, `rg` result showing no runtime usage | Token refresh helpers exist, but they are not invoked automatically by routes or the scheduler. |

## Webhooks

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `WH-001` | `PASS` | `recfn/server/src/routes/webhooks.ts:29-77` | Webhook configuration is implemented. |
| `WH-002` | `PASS` | `recfn/server/src/worker/lifecycle.ts`, `recfn/server/src/worker/bot-worker.ts`, `recfn/server/src/recording/storage.ts`, `recfn/server/src/transcription/pipeline.ts` | The named lifecycle, recording, transcript, and participant events are emitted. |
| `WH-003` | `PASS` | `recfn/server/src/webhooks/deliver.ts:23-51` | HMAC-SHA256 signing is implemented using `X-RecFn-Signature`. |
| `WH-004` | `PASS` | `recfn/server/src/webhooks/deliver.ts:6-40` | At-least-once retry behavior is implemented via the shared webhook package. |

## REST API

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `API-001` | `PARTIAL` | `recfn/server/src/middleware/envelope.ts`, `recfn/server/src/index.ts:113-137`, transcript/download routes | JSON endpoints use the canonical envelope, but transcript export and download endpoints return raw bodies/redirects instead of envelopes. |
| `API-002` | `PASS` | `recfn/server/src/middleware/auth.ts`, all route handlers | REST endpoints require Bearer authentication. |
| `API-003` | `FAIL` | `recfn/server/src/routes/bots.ts:82-111`, `recfn/server/src/routes/recordings.ts`, `recfn/server/src/routes/calendars.ts`, `recfn/server/src/routes/webhooks.ts` | Pagination is implemented for bots, but not consistently for other list endpoints. |
| `API-004` | `PASS` | namespace-scoped store calls throughout routes and store implementations | HTTP routes enforce namespace scoping for the entities they access. |
| `API-005` | `PASS` | `recfn/server/src/index.ts:1`, route definitions throughout `recfn/server/src/routes/` | The server is built on `@superfunctions/http`. |
| `API-006` | `FAIL` | `recfn/server/src/index.ts:142`, `recfn/server/src/store/memory.ts`, `recfn/server/package.json` | Persistence is a local in-memory store rather than `@superfunctions/db`. |

## WebSocket streaming

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `WS-001` | `PASS` | `recfn/server/src/ws/server.ts`, `recfn/client/src/ws.ts`, `recfn/python/recfn/ws.py` | The transcript WebSocket endpoint exists. |
| `WS-002` | `FAIL` | `recfn/server/src/worker/lifecycle.ts:62-64`, `recfn/client/src/ws.ts:8,82-83`, `recfn/python/recfn/ws.py:61-63` | The server emits `status` payloads as `{ status }`, but both clients expect `{ botStatus }`. This breaks the typed contract. |
| `WS-003` | `PASS` | `recfn/server/src/ws/transcript-stream.ts:4-16` | The connection manager enforces a 50-connection cap per bot. |

## Platform adapters

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `PLAT-001` | `PASS` | `recfn/core/src/adapters/platform.ts:11-24` | A shared `PlatformAdapter` interface exists. |
| `PLAT-002` | `PASS` | `recfn/platforms/zoom/src/index.ts` | A Zoom adapter using the Zoom Meeting SDK is implemented. |
| `PLAT-003` | `PARTIAL` | `recfn/platforms/meet/src/index.ts`, `recfn/platforms/meet/src/audio-capture.ts:37-49` | The Meet adapter exists and can attempt to join meetings, but media capture is stubbed and production recording/transcription is not ready. |
| `PLAT-004` | `PARTIAL` | `recfn/platforms/teams/src/index.ts`, `recfn/platforms/teams/src/audio-capture.ts:26-33` | The Teams adapter exists and can attempt to join meetings, but media capture is stubbed and production recording/transcription is not ready. |

## ASR adapters

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `ASR-001` | `PASS` | `recfn/core/src/adapters/asr.ts` | The ASR adapter interface defines stream and batch methods. |
| `ASR-002` | `PASS` | `recfn/adapters/whisper/src/index.ts` | Whisper batch transcription is implemented for offline/local use. |
| `ASR-003` | `PASS` | `recfn/adapters/deepgram/src/index.ts` | Deepgram adapter is implemented. |
| `ASR-004` | `PASS` | `recfn/adapters/assemblyai/src/index.ts` | AssemblyAI adapter is implemented. |
| `ASR-005` | `PASS` | `recfn/adapters/google-stt/src/index.ts` | Google STT adapter is implemented. |

## Analytics

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `ANA-001` | `PASS` | `recfn/core/src/analytics/talk-time.ts`, `recfn/server/src/routes/analytics.ts` | Talk-time analytics are implemented. |
| `ANA-002` | `PASS` | `recfn/core/src/analytics/silence.ts`, `recfn/server/src/routes/analytics.ts` | Silence analytics are implemented. |
| `ANA-003` | `PASS` | `recfn/core/src/analytics/topics.ts`, `recfn/core/src/analytics/index.ts` | Topic segmentation is implemented as a heuristic analytics helper. |

## Export formats

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `EXP-001` | `PASS` | `recfn/core/src/formatters/srt.ts`, `vtt.ts`, `text.ts`, transcript route | Export formats are implemented. |
| `EXP-002` | `PASS` | `recfn/server/src/transcription/redact.ts`, transcript route | Export redaction support is implemented. |

## Desktop SDK

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `DSK-001` | `PARTIAL` | `recfn/desktop/src/capture.ts`, `recfn/desktop/src/recorder.ts:32-91` | The package provides capture/record abstractions, but it does not ship a concrete Electron/Tauri capture provider and the recorder hard-stops after 2 seconds. |
| `DSK-002` | `PASS` | `recfn/desktop/src/uploader.ts:15-24` | Desktop upload to the server is implemented through the TypeScript client. |
| `DSK-003` | `PASS` | `recfn/desktop/src/transcriber.ts:23-37` | Local Whisper-based transcription is supported by the desktop helper. |

## CLI

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `CLI-001` | `PASS` | `recfn/cli/src/index.ts`, command modules | The CLI covers bots, recordings, transcripts, analytics, and calendars. |
| `CLI-002` | `PARTIAL` | `recfn/cli/src/index.ts:13-24`, `recfn/cli/src/commands/transcript.ts:9-18` | Human-readable vs JSON output is supported globally, but the transcript command reuses `-f/--format` for transcript export format, which creates UX ambiguity. |
| `CLI-003` | `FAIL` | `recfn/cli/src/commands/transcript.ts:12-35` | The CLI outputs transcript content and participant names by default unless the caller explicitly passes `--redact`. That does not satisfy a strict “must not output PII” reading. |
| `CLI-004` | `PARTIAL` | `recfn/cli/package.json:6-8,26-28`, verification commands in appendix | The package has a `bin` entry and public publish config, but global-install readiness was not demonstrated and build verification was not green end-to-end in this checkout. |

## SDKs

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `SDK-001` | `PASS` | `recfn/client/src/index.ts`, resource modules, `recfn/client/src/ws.ts` | The TypeScript SDK covers the REST surface and exports the WebSocket helper. |
| `SDK-002` | `FAIL` | `recfn/client/src/resources/recordings.ts:53-90`, `recfn/python/recfn/resources/recordings.py:9-63`, `recfn/python/recfn/ws.py:61-63` | The Python SDK lacks the TypeScript `recordings.upload()` method and also inherits the broken `status` frame contract. |
| `SDK-003` | `PASS` | `recfn/client/src/client.ts`, `recfn/python/recfn/client.py` | Both SDKs return typed error envelopes for expected API errors. |

## Security

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `SEC-001` | `PARTIAL` | `recfn/server/src/middleware/auth.ts` | API auth is enforced, but the implementation is an injected validator plus `@superfunctions/auth` helpers rather than an explicit `secfn` integration. |
| `SEC-002` | `FAIL` | `recfn/server/src/ws/auth.ts:11-33`, `recfn/server/src/ws/server.ts:60-68` | A valid token can subscribe to any `botId` over WebSockets because namespace ownership is never checked. |
| `SEC-003` | `PARTIAL` | `recfn/server/src/recording/storage.ts:83-86`, `recfn/server/src/integrations/filefn.ts` | Encryption is represented as adapter intent, not as a concrete encrypted storage backend. |
| `SEC-004` | `FAIL` | `recfn/adapters/deepgram/src/index.ts:101-104`, `recfn/adapters/assemblyai/src/index.ts:108-111`, `recfn/adapters/google-stt/src/index.ts:117-120`, `recfn/server/src/routes/calendars.ts:77-80` | API keys/tokens are passed directly into adapters or token stores rather than being consistently managed by `secfn`. |
| `SEC-005` | `PASS` | `recfn/server/src/webhooks/deliver.ts` | Webhook HMAC signing is implemented. |
| `SEC-006` | `PASS` | `recfn/server/src/worker/consent.ts`, `recfn/server/src/worker/bot-worker.ts:108-114` | Consent is announced before recording begins. |

## Ecosystem integrations

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `INT-001` | `PARTIAL` | `recfn/server/src/integrations/flowfn.ts`, bot worker, transcript route/pipeline | Queue integration exists for join and transcription, but not for recording upload. |
| `INT-002` | `FAIL` | `recfn/server/src/integrations/filefn.ts:1-50` | Recording storage is implemented as a local abstraction instead of consuming a shared `filefn/storage` package. |
| `INT-003` | `PASS` | `recfn/server/src/integrations/searchfn.ts`, `recfn/server/src/search/indexer.ts` | Transcript indexing/search uses `searchfn` infrastructure. |
| `INT-004` | `PARTIAL` | `recfn/server/src/integrations/plugfn.ts`, `recfn/server/src/webhooks/deliver.ts` | Behavior matches the intended webhook-delivery semantics, but the implementation is a local wrapper around `@superfunctions/webhooks` rather than a direct `plugfn` integration. |
| `INT-005` | `PARTIAL` | auth middleware, calendar token store, ASR adapters | Some security concerns are abstracted, but API key validation, token storage, and ASR API key management are not consistently delegated to `secfn`. |
| `INT-006` | `PARTIAL` | `recfn/server/src/integrations/logfn.ts`, usage across worker/pipeline/storage | Structured logging exists, but it is implemented through a local logger abstraction rather than the shared `logfn` package. |

## Limits

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `LIMIT-001` | `PARTIAL` | `recfn/server/src/config.ts`, `recfn/server/src/middleware/limits.ts`, `recfn/server/src/ws/transcript-stream.ts` | Most limits are implemented, but the WebSocket limit is hard-coded rather than config-driven and some runtime paths remain unenforced. |
| `LIMIT-002` | `PASS` | `recfn/server/src/middleware/limits.ts:107-118`, bot/search routes | The `max 100` pagination cap is implemented where pagination exists. |
| `LIMIT-003` | `PARTIAL` | `recfn/server/src/middleware/rate-limit.ts:35-64` | HTTP rate limiting exists, but it keys on IP, not namespace, and does not cover the WebSocket path. |

## Observability

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `OBS-001` | `PARTIAL` | logging throughout worker/pipeline/storage plus `recfn/server/src/integrations/logfn.ts` | Logging coverage is decent, but it is not backed by shared `logfn`, and API request/error coverage is incomplete. |
| `OBS-002` | `PARTIAL` | `recfn/server/src/observability/metrics.ts`, usages found by `rg` | Active bot, recording, ASR, join latency, and webhook metrics are present; `emitApiRequest()` exists but is not wired. |
| `OBS-003` | `PASS` | `recfn/server/src/worker/lifecycle.ts:71-76`, `recfn/server/src/observability/latency.ts` | Join latency is recorded. |

## Search

| ID | Status | Evidence | Notes |
|---|---|---|---|
| `SRCH-001` | `PARTIAL` | `recfn/server/src/transcription/pipeline.ts:124-138`, `recfn/server/src/search/indexer.ts` | Indexing happens on transcript completion, but the 60-second operational guarantee is not specifically enforced or measured. |
| `SRCH-002` | `PARTIAL` | `recfn/server/src/routes/search.ts:57-109` | Results include `recordingId`, `botId`, `segment`, and limited context, but they do not include a participant info object as required. |

# Spec conflicts / spec gaps

## Spec gaps introduced by the current task

1. `SPEC PARTIAL`: production readiness for `nucleus` is not concretely specified. The bundle is rich in functional requirements, but it does not define operational readiness gates such as persistent storage requirements, worker orchestration, failure recovery, restart semantics, deployment topology, or release criteria.
2. `SPEC MISSING`: “all major meeting platforms” is not represented. The current spec only covers Zoom, Google Meet, Microsoft Teams, and a desktop SDK.
3. `SPEC PARTIAL`: duplication and shared-package reuse are only implied by architectural requirements (`API-005`, `API-006`, `INT-*`). There is no explicit duplication threshold or “must consume shared package X instead of local abstraction Y” acceptance rule.

## Internal spec tensions

1. `API-001` says all API responses must use the canonical envelope, but transcript export and download semantics naturally return raw text or redirects. The current implementation follows the practical endpoint behavior, not the literal universal-envelope wording.
2. `CLI-003` says the CLI must not output PII, while `CLI-001` and transcript retrieval/export imply that callers need transcript content. The spec needs to clarify whether CLI transcript access must default to redacted output or whether PII-safe behavior is only required for non-transcript command surfaces.
3. `INTENT_AUDIT.md` concludes there are no missing intent items, but that file predates the present request for `nucleus` production readiness and major-platform breadth. It is correct only for the earlier scope.

# Cross-cutting audits

## Security / authz / validation boundaries

- Strengths:
  - HTTP routes consistently call `authenticate()` and then use namespace-scoped store access.
  - Consent-before-recording and webhook HMAC signing are implemented.
  - URL validation and `BotConfig` validation are in place.
- Risks:
  - WebSocket subscriptions are not namespace-authorized against the target bot.
  - Secrets are not consistently managed through `secfn`.
  - The shipped storage adapter models encryption as a flag, not as real cryptography.

## Determinism invariants

- Transcript sorting is deterministic (`startTime`, then `speakerId`) in both route and pipeline paths.
- State transitions are guarded by a dedicated state-machine validator.
- ID generation uses `Date.now()` plus `Math.random()`, which is reasonable for uniqueness but not reproducible.
- Search result context selection depends on matching `speakerId`, `startTime`, and `text`; duplicate segments can make that matching ambiguous.

## Limits / caps

- Concurrent bot, webhook count, calendar count, recording duration, transcript segment count, and pagination caps are implemented in helper functions.
- The WebSocket connection cap is enforced but hard-coded to 50 in `recfn/server/src/ws/transcript-stream.ts`, creating config drift against `recfn/server/src/config.ts`.
- Rate limiting is implemented by IP instead of namespace.
- There is no explicit enforcement of the “recording upload within 60 seconds” objective because the leave-to-upload path is not implemented.

## Error handling + canonical envelopes

- JSON REST errors consistently use `RecFnError` / envelope helpers.
- Both SDKs interpret typed error responses correctly for expected API failures.
- Export/download endpoints intentionally break the universal envelope rule, which should be resolved in the spec rather than hidden in implementation.
- WebSocket error handling exists, but the `status` frame contract is inconsistent with both clients.

## Compatibility / versioning / migrations

- All `recfn` npm packages are currently at version `0.1.0`.
- The Python SDK declares `Development Status :: 3 - Alpha` in `recfn/python/pyproject.toml`.
- `recfn/server/src/calendar/MIGRATION.md` shows some migration awareness around token refresh.
- The core TypeScript package does not typecheck cleanly under its own `tsconfig` because DOM/Web globals like `ReadableStream` and `URL` are referenced while `lib` is only `["ES2022"]`: `recfn/core/tsconfig.json:3-6`.
- The server package uses the same minimal `lib` configuration and was not cleanly typechecked from a plain checkout in this audit environment.

## Code duplication status

- `jscpd` result: `44` clones, `1012` duplicated lines (`5.66%`), `8921` duplicated tokens (`5.24%`).
- Highest-concentration duplication:
  - `recfn/platforms/meet/src/index.ts` vs `recfn/platforms/teams/src/index.ts` (`0.931` similarity)
  - `recfn/platforms/meet/src/chat.ts` vs `recfn/platforms/teams/src/chat.ts` (`0.949` similarity)
  - `recfn/platforms/meet/src/participants.ts` vs `recfn/platforms/teams/src/participants.ts` (`0.918` similarity)
  - cloud ASR adapters share repeated upload/poll/map/sort structure
  - server tests repeat substantial scaffolding

## Shared-package reuse status

- Good reuse already present:
  - `@superfunctions/http`
  - `@superfunctions/auth`
  - `@superfunctions/webhooks`
  - `@superfunctions/queue`
  - `@superfunctions/middleware`
  - `@superfunctions/oauth-flow`
  - `@superfunctions/oauth-http`
  - `@superfunctions/oauth-storage`
- Clear missed reuse / local re-implementation:
  - `recfn/server/src/integrations/filefn.ts` defines a local storage interface rather than using a shared `filefn/storage` package.
  - `recfn/server/src/integrations/logfn.ts` defines a local logger rather than using shared `logfn`.
  - `recfn/server/src/store/memory.ts` is the only persistence implementation and does not use `@superfunctions/db`.
  - `recfn/server/src/integrations/searchfn.ts` is a local wrapper around `@searchfn/adapter-memory`; it is functional but still bespoke.
  - Meet and Teams adapters should be refactored around a shared headless-browser platform core.
  - The cloud ASR adapters should share request/poll/segment-normalization helpers.

# Recommendations

1. Implement actual media capture and recording upload for bot-driven sessions before using `recfn` in `nucleus`.
   - Addresses: intent items `1`, `3`, `5`, `27`, `29`, `48`
   - Requirements: `REC-001`, `REC-003`, `TRX-001`, `PLAT-003`, `PLAT-004`, `INT-001`
2. Fix WebSocket authorization and frame compatibility immediately.
   - Addresses: intent items `3`, `22`, `23`, `42`
   - Requirements: `SEC-002`, `WS-002`, `SDK-002`
3. Complete server-side persistence for bot details, metadata, and chat.
   - Addresses: intent items `7`, `8`, `11`, `15`
   - Requirements: `BOT-006`, `CHAT-001`, `SRCH-002`, partially `PAR-001`
4. Replace local persistence/storage/logging abstractions with shared Superfunctions packages.
   - Addresses: intent items `30`, `31`, `34`, `35`, `49`
   - Requirements: `API-006`, `INT-002`, `INT-005`, `INT-006`
5. Close SDK and CLI production gaps.
   - Addresses: intent items `17`, `18`, `19`, `25`
   - Requirements: `SDK-002`, `CLI-003`, `CLI-004`
6. Add a concrete operational-readiness spec for `nucleus`.
   - Add acceptance for persistent storage, worker deployment, restart recovery, metrics dashboards, secrets rotation, failure replay, and supported platform matrix.
7. Refactor duplication hotspots after the production blockers above.
   - Create a shared browser-platform core for Meet/Teams.
   - Create shared cloud-ASR transport/polling helpers.
   - Replace local storage/logger wrappers with shared packages instead of copying interfaces.

# Appendix: commands run + environment details

## Commands run from `repo root`

- `git status --short --branch`
- `git rev-parse --short=12 HEAD`
- `git diff --stat`
- `uname -sm`
- `npx turbo run test --filter=recfn --filter=recfn-server --filter=recfn-client --filter=recfn-cli --filter=recfn-desktop --filter=recfn-zoom --filter=recfn-meet --filter=recfn-teams --filter=recfn-whisper --filter=recfn-deepgram --filter=recfn-assemblyai --filter=recfn-google-stt`
- `python3 -m pytest recfn/python/tests`
- `PYTHONPATH=recfn/python python3 -m pytest recfn/python/tests`
- `PYTHONPATH=recfn/python python3 -m pytest recfn/python/tests/test_client.py`
- `python3 -c "import httpx, websockets"`
- `npm exec --package typescript@5.6.3 -- tsc --noEmit -p recfn/core/tsconfig.json`
- `npm exec --package typescript@5.6.3 -- tsc --noEmit -p recfn/server/tsconfig.json`
- `npx jscpd recfn --min-lines 15 --min-tokens 80 --reporters console`
- static inspection commands using `rg`, `sed`, `nl`, and small one-off Python scripts for inventorying requirements and measuring duplication similarity

## Verification results

- `turbo run test ...` did not reach a clean package-test pass in this checkout because local `tsc` resolution was missing for workspace builds.
- The targeted core typecheck found a real config/code issue: `ReadableStream` and `URL` are used while `recfn/core/tsconfig.json` only declares `lib: ["ES2022"]`.
- The targeted server typecheck also failed from the plain checkout configuration due missing resolved workspace types/globals under its current config.
- Python tests:
  - `recfn/python/tests/test_client.py` passed (`6 passed`).
  - Full Python test collection required the `websockets` dependency, which was not installed in the audit environment.
- Duplication analysis completed successfully and showed meaningful, non-trivial duplication.

## Environment details

- OS: `Darwin arm64`
- Shell: `zsh`
- Git state: detached `HEAD`
- Commit audited: `7adae771e458`
- Dirty state at audit time: `clean`

