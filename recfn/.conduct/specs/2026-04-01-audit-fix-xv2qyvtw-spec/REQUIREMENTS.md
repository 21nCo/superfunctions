# RecFn Audit-Fix Requirements

## Table of contents

- [PROD-001](#prod-001) Production support matrix
- [ARCH-001](#arch-001) Durable persistence via shared DB
- [ARCH-002](#arch-002) Shared storage integration
- [ARCH-003](#arch-003) Shared browser core
- [ARCH-004](#arch-004) Shared cloud ASR helpers
- [API-001](#api-001) Aggregate bot detail endpoint
- [API-002](#api-002) Consistent pagination and envelope behavior
- [DATA-001](#data-001) Persistent chat and metadata
- [BOT-001](#bot-001) Automatic recording finalization
- [BOT-002](#bot-002) Stable bot ownership on related entities
- [PLAT-001](#plat-001) Zoom end-to-end recording
- [PLAT-002](#plat-002) Google Meet real audio capture
- [PLAT-003](#plat-003) Microsoft Teams real audio capture
- [TRX-001](#trx-001) True streaming real-time transcription
- [TRX-002](#trx-002) Deterministic batch transcript processing
- [WS-001](#ws-001) WebSocket namespace authorization
- [WS-002](#ws-002) Canonical WebSocket frame schema
- [LIMIT-001](#limit-001) Config-driven limit enforcement
- [SEC-001](#sec-001) Secret resolution and leak prevention
- [INT-001](#int-001) Shared Superfunctions integration usage
- [SEARCH-001](#search-001) Participant-aware transcript search
- [SDK-001](#sdk-001) Python parity with TypeScript SDK
- [CLI-001](#cli-001) PII-safe CLI defaults
- [CAL-001](#cal-001) Calendar runtime services
- [DSK-001](#dsk-001) Desktop capture session control
- [OBS-001](#obs-001) Production observability
- [BUILD-001](#build-001) Repo-root release gates
- [COMPAT-001](#compat-001) Compatibility and migration discipline

## PROD-001

- **Priority**: P0
- **Statement**: The system MUST publish and enforce a production support matrix that names `zoom`, `meet`, `teams`, and `desktop_capture` as the only Tier-1 platforms for this spec, and it MUST reject unsupported platforms or unsupported capability combinations with deterministic error codes.
- **Rationale**: The audit showed that runtime claims were broader than actual capability, which is unsafe for `nucleus`.
- **Acceptance criteria**:
  - Supported platforms can be queried from a single runtime capability source.
  - `POST /api/v1/bots` rejects unsupported platforms with `UNSUPPORTED_PLATFORM`.
  - Unsupported feature combinations such as fake real-time streaming are rejected with deterministic errors before long-running work begins.
- **Test vectors**: `TV-PROD-001`
- **Notes**: Additional named platforms are Undefined until explicitly added by a later spec.

## ARCH-001

- **Priority**: P0
- **Statement**: The server MUST use `@superfunctions/db` for durable storage of bots, recordings, transcripts, participants, chat messages, meeting metadata, calendars, and webhooks.
- **Rationale**: The audit found that production persistence was still memory-only.
- **Acceptance criteria**:
  - Production server config requires a durable persistence adapter built on `@superfunctions/db`.
  - The in-memory store remains test-only and is not the primary production path.
  - Namespace scoping is enforced at the persistence layer.
- **Test vectors**: `TV-ARCH-001`
- **Notes**: SQLite-backed test adapters are acceptable for local verification if they use the shared DB abstraction.

## ARCH-002

- **Priority**: P0
- **Statement**: Recording storage MUST use `@superfunctions/storage` and shared storage adapters instead of the bespoke local `StorageAdapter` contract.
- **Rationale**: The repo already contains a shared storage abstraction; recfn should consume it rather than re-invent it.
- **Acceptance criteria**:
  - Server recording flows depend on `@superfunctions/storage`.
  - Signed URLs use shared storage adapter behavior.
  - The bespoke storage interface is removed from the public production path.
- **Test vectors**: `TV-ARCH-002`
- **Notes**: Thin compatibility wrappers are allowed only if they are internal and temporary.

## ARCH-003

- **Priority**: P1
- **Statement**: Browser-automation platforms SHOULD share a common browser core package for session bootstrap, participant observation, chat observation, and audio-capture lifecycle.
- **Rationale**: Meet and Teams currently duplicate the same structural logic.
- **Acceptance criteria**:
  - A shared browser-core package exists under `recfn/platforms/*`.
  - Meet and Teams adapters consume it for common lifecycle behavior.
  - Platform-specific code is limited to selectors, auth, and capability overrides.
- **Test vectors**: `TV-ARCH-003`
- **Notes**: This requirement targets maintainability and should not change the public API.

## ARCH-004

- **Priority**: P1
- **Statement**: Cloud ASR adapters SHOULD share a common helper layer for upload, polling, timeout handling, and segment normalization where provider semantics allow.
- **Rationale**: The audit found duplicated transport and normalization logic across cloud ASR adapters.
- **Acceptance criteria**:
  - Shared helper modules exist for the repeated transport/polling logic.
  - Adapter-specific code is limited to provider endpoints and result-shape mapping.
  - Existing provider-specific tests continue to pass after consolidation.
- **Test vectors**: `TV-ARCH-004`
- **Notes**: The Whisper adapter is explicitly outside this requirement.

## API-001

- **Priority**: P0
- **Statement**: `GET /api/v1/bots/:botId` MUST return an aggregate bot view containing participants, recordings, metadata, and chat messages in a single response.
- **Rationale**: The audit found that the endpoint returned only the bare bot object.
- **Acceptance criteria**:
  - The response includes the base bot fields plus `participants`, `recordings`, `metadata`, and `chatMessages`.
  - The endpoint is namespace-scoped.
  - Invalid bot IDs return `BOT_NOT_FOUND`.
- **Test vectors**: `TV-API-001`
- **Notes**: The dedicated child endpoints for participants, chat, metadata, and recordings still remain available.

## API-002

- **Priority**: P0
- **Statement**: All list endpoints MUST consistently support pagination via `limit` and `cursor`, and all non-raw error responses MUST use the canonical JSON envelope.
- **Rationale**: The audit found pagination and envelope behavior to be inconsistent across endpoints.
- **Acceptance criteria**:
  - `GET /bots`, `GET /bots/:botId/recordings`, `GET /webhooks`, `GET /calendars`, and `GET /transcripts/search` all support `limit` and `cursor`.
  - Success responses for JSON endpoints use `{ ok, data }`.
  - Transcript export and download MAY return raw success bodies, but errors still use the canonical JSON error envelope.
- **Test vectors**: `TV-API-002`
- **Notes**: The max page size remains capped by limit configuration.

## DATA-001

- **Priority**: P0
- **Statement**: Chat messages and meeting metadata MUST be persistently written, namespace-scoped, and retrievable through both aggregate and dedicated endpoints.
- **Rationale**: The audit found chat capture and metadata persistence to be effectively unimplemented.
- **Acceptance criteria**:
  - Platform chat events are persisted.
  - Metadata snapshots are persisted and updated as the bot lifecycle progresses.
  - `GET /bots/:botId/chat` and `GET /bots/:botId/metadata` return stored values, not placeholders.
- **Test vectors**: `TV-DATA-001`
- **Notes**: Metadata MAY be partial while the meeting is active, but it MUST still be stored as a real record.

## BOT-001

- **Priority**: P0
- **Statement**: Bot-driven meeting sessions MUST automatically finalize and upload recordings after meeting completion without requiring the manual upload endpoint.
- **Rationale**: This is the most important functional gap blocking `nucleus`.
- **Acceptance criteria**:
  - When a bot leaves or the meeting ends, a finalized recording record is created automatically.
  - `recording.ready` is emitted after successful upload and persistence.
  - Upload failures transition the bot or recording workflow into a deterministic failure state.
- **Test vectors**: `TV-BOT-001`
- **Notes**: Manual upload remains supported for desktop capture and backfills.

## BOT-002

- **Priority**: P0
- **Statement**: Participant, metadata, chat, and recording records MUST preserve the correct `botId` and namespace across all platform adapters and persistence writes.
- **Rationale**: The audit found empty or mismatched `botId` behavior in browser-platform adapters.
- **Acceptance criteria**:
  - Platform adapters receive the actual bot identity before event emission.
  - Persisted related records reference the owning bot deterministically.
  - Cross-namespace contamination is impossible through adapter state.
- **Test vectors**: `TV-BOT-002`
- **Notes**: This applies to Zoom, Meet, Teams, and desktop-imported recordings where relevant.

## PLAT-001

- **Priority**: P0
- **Statement**: The Zoom adapter MUST support end-to-end bot recording, participant tracking, chat capture, metadata capture, and recording finalization through the production pipeline.
- **Rationale**: Zoom is the strongest current path and should be the first production-hardened Tier-1 platform.
- **Acceptance criteria**:
  - Zoom bot sessions create persisted recordings without manual upload.
  - Zoom participant and chat events are persisted.
  - Zoom metadata is included in the aggregate bot view.
- **Test vectors**: `TV-PLAT-001`
- **Notes**: Per-participant tracks remain supported where the Zoom SDK exposes them.

## PLAT-002

- **Priority**: P0
- **Statement**: The Google Meet adapter MUST implement real audio capture and MUST NOT emit zero-byte placeholder streams on the production path.
- **Rationale**: The audit found the current Meet audio capture path to be a stub.
- **Acceptance criteria**:
  - Meet audio capture produces non-empty audio frames when prerequisites are satisfied.
  - Missing runtime prerequisites fail with `PLATFORM_CAPTURE_UNAVAILABLE`.
  - A successful Meet session can complete the full recording pipeline.
- **Test vectors**: `TV-PLAT-002`
- **Notes**: Acceptable implementations include browser/CDP capture or an explicit loopback-device requirement.

## PLAT-003

- **Priority**: P0
- **Statement**: The Microsoft Teams adapter MUST implement real audio capture and MUST NOT emit zero-byte placeholder streams on the production path.
- **Rationale**: The audit found the current Teams audio capture path to be a stub.
- **Acceptance criteria**:
  - Teams audio capture produces non-empty audio frames when prerequisites are satisfied.
  - Missing runtime prerequisites fail with `PLATFORM_CAPTURE_UNAVAILABLE`.
  - A successful Teams session can complete the full recording pipeline.
- **Test vectors**: `TV-PLAT-003`
- **Notes**: Teams may use the shared browser core plus platform-specific selector/auth logic.

## TRX-001

- **Priority**: P0
- **Statement**: Real-time transcription MUST use a streaming-capable ASR path and MUST reject unsupported live combinations instead of buffering the entire meeting first.
- **Rationale**: The audit found that the current “real-time” path is not genuinely streaming.
- **Acceptance criteria**:
  - Streaming-capable providers emit segments during live capture.
  - Unsupported combinations return `REALTIME_TRANSCRIPT_UNSUPPORTED` before work starts.
  - The production support matrix reflects which platforms/providers support live transcription.
- **Test vectors**: `TV-TRX-001`
- **Notes**: Batch transcription remains the fallback for non-streaming providers.

## TRX-002

- **Priority**: P0
- **Statement**: Batch transcription, indexing, and search preparation MUST preserve deterministic segment ordering and stable participant references.
- **Rationale**: Search and analytics depend on deterministic transcript order and identity mapping.
- **Acceptance criteria**:
  - Stored transcript segments are sorted deterministically.
  - Search indexing uses the persisted ordering, not transient adapter order.
  - Analytics and search use the same canonical transcript segment order.
- **Test vectors**: `TV-TRX-002`
- **Notes**: Deterministic ordering rules are part of the public contract.

## WS-001

- **Priority**: P0
- **Statement**: WebSocket authentication MUST verify both the token and the target bot namespace before admitting a transcript-stream subscription.
- **Rationale**: The audit identified a production-blocking cross-namespace access flaw.
- **Acceptance criteria**:
  - Valid credentials from another namespace are rejected for foreign bots.
  - Unauthorized connections receive deterministic close/error behavior.
  - Deferred auth and query-string auth enforce the same namespace rule.
- **Test vectors**: `TV-WS-001`
- **Notes**: The same logic applies whether auth happens during upgrade or via the first frame.

## WS-002

- **Priority**: P0
- **Statement**: WebSocket frame schemas MUST be defined once and shared across the server, TypeScript SDK, and Python SDK, including `status.data.botStatus`.
- **Rationale**: The audit found a schema mismatch that breaks both SDKs.
- **Acceptance criteria**:
  - Server and SDK tests use the same canonical frame shapes.
  - `status` frames always use `botStatus`.
  - Participant and error frames preserve the documented keys.
- **Test vectors**: `TV-WS-002`
- **Notes**: A temporary compatibility shim MAY exist, but the canonical schema is the shared source of truth.

## LIMIT-001

- **Priority**: P0
- **Statement**: Bot, recording, transcript, page-size, rate-limit, and WebSocket concurrency caps MUST all be configuration-driven and enforced consistently across HTTP and WebSocket entry points.
- **Rationale**: Production rollouts need predictable and centrally managed safeguards.
- **Acceptance criteria**:
  - No hard-coded runtime cap contradicts the config object.
  - HTTP routes and WebSocket connection admission both use the configured limits.
  - Violations return deterministic error codes.
- **Test vectors**: `TV-LIMIT-001`
- **Notes**: Namespace-based rate limiting is preferred over IP-based behavior for multi-tenant correctness.

## SEC-001

- **Priority**: P0
- **Statement**: API keys, OAuth tokens, and ASR provider credentials MUST be resolved through `secfn`-backed secret references or an equivalent `secfn` integration layer, and they MUST NOT appear in logs, API responses, or webhook payloads.
- **Rationale**: The audit found secret handling to be too ad hoc for production use.
- **Acceptance criteria**:
  - Calendar and ASR credentials are referenced indirectly, not passed around as raw long-lived plaintext config.
  - Logs and webhook payloads are scrubbed of secret material.
  - Missing or invalid secret references fail with deterministic error codes.
- **Test vectors**: `TV-SEC-001`
- **Notes**: Short-lived tokens MAY still exist in process memory but MUST not be surfaced externally.

## INT-001

- **Priority**: P0
- **Statement**: The production implementation MUST use existing Superfunctions shared packages and functions for DB, storage, queueing, auth, webhooks, and observability wherever those shared components already exist in the monorepo.
- **Rationale**: The user explicitly requested duplication and shared-package improvements, and the audit identified several bespoke seams.
- **Acceptance criteria**:
  - `@superfunctions/db`, `@superfunctions/storage`, `@superfunctions/queue`, `@superfunctions/http`, `@superfunctions/auth`, and `@superfunctions/webhooks` are used in the production path.
  - Logging and metrics integrate with shared `logfn` or `watchfn` primitives instead of remaining purely bespoke.
  - The remediation removes or thins the bespoke abstractions identified in the audit.
- **Test vectors**: `TV-INT-001`
- **Notes**: Thin wrapper modules are allowed only when they preserve a shared package as the implementation source of truth.

## SEARCH-001

- **Priority**: P0
- **Statement**: Transcript search MUST return participant info and stable context windows in addition to the matched segment and recording reference.
- **Rationale**: The audit found search results to be too thin for the intended API contract.
- **Acceptance criteria**:
  - Search hits include participant identity data when available.
  - Context windows are stable and deterministic.
  - Namespace scoping is preserved in search results.
- **Test vectors**: `TV-SEARCH-001`
- **Notes**: When participant resolution is unavailable, the field may be `null` but the shape must still be present.

## SDK-001

- **Priority**: P0
- **Statement**: The Python SDK MUST reach parity with the TypeScript SDK for the audited surfaces, including recording upload, aggregate bot detail, and canonical WebSocket status handling.
- **Rationale**: The audit found explicit parity gaps in the Python package.
- **Acceptance criteria**:
  - Python exposes `recordings.upload(...)`.
  - Python correctly parses `status.data.botStatus`.
  - Python resource coverage matches the TypeScript resource surface for audited features.
- **Test vectors**: `TV-SDK-001`
- **Notes**: Exact method naming MAY follow Python conventions as long as capability parity is preserved.

## CLI-001

- **Priority**: P0
- **Statement**: The CLI MUST default to PII-safe transcript behavior and MUST require an explicit opt-in flag before printing unredacted transcript content or participant-identifying data.
- **Rationale**: The audit found that the CLI could print transcript PII by default.
- **Acceptance criteria**:
  - Transcript retrieval defaults to redacted output.
  - A dedicated opt-in flag enables raw PII output.
  - Machine-readable output honors the same default safety rule unless explicitly overridden.
- **Test vectors**: `TV-CLI-001`
- **Notes**: The CLI MAY still write redacted transcript exports to files by default.

## CAL-001

- **Priority**: P0
- **Statement**: Calendar auto-scheduling and token refresh MUST run as explicit production services rather than existing only as exported helper functions.
- **Rationale**: The audit found the scheduling and refresh logic to be present but not fully wired into runtime behavior.
- **Acceptance criteria**:
  - A runtime service polls calendars for upcoming events when enabled.
  - Token refresh is executed automatically when required.
  - Scheduling decisions are observable and namespace-scoped.
- **Test vectors**: `TV-CAL-001`
- **Notes**: Manual list-events endpoints remain available for inspection and debugging.

## DSK-001

- **Priority**: P0
- **Statement**: The desktop capture SDK MUST support caller-controlled recording session duration and MUST NOT hard-stop after a fixed 2-second timer.
- **Rationale**: The audit found a hard-coded 2-second stop that prevents real usage.
- **Acceptance criteria**:
  - Desktop recording starts and stops on explicit caller control or configured policy.
  - Upload and local Whisper transcription flows still work with the longer-lived session.
  - Test doubles can simulate bounded sessions without relying on a hard-coded wall clock.
- **Test vectors**: `TV-DSK-001`
- **Notes**: The API MAY still offer helper timeouts, but they must be configurable.

## OBS-001

- **Priority**: P0
- **Statement**: The system MUST emit structured logs and metrics for lifecycle, capture, upload, transcription, WebSocket auth, scheduling, and secret-resolution failures through shared observability integration points.
- **Rationale**: Production rollout requires better operational visibility than the current prototype provides.
- **Acceptance criteria**:
  - Join latency, upload latency, ASR latency, and scheduling decisions are observable.
  - WebSocket auth failures and secret-resolution failures are logged with safe structured context.
  - Logs and metrics avoid raw transcript content and secrets.
- **Test vectors**: `TV-OBS-001`
- **Notes**: A no-op logger is acceptable for tests but not as the production default.

## BUILD-001

- **Priority**: P0
- **Statement**: The remediation MUST leave `recfn` in a state where repo-root build, typecheck, and test commands pass for the relevant packages and platform suites.
- **Rationale**: Production readiness is not credible without a green verification gate.
- **Acceptance criteria**:
  - TypeScript package configs resolve the required browser and Node globals correctly.
  - Repo-root verification commands pass for the targeted `recfn` workspaces.
  - Platform-specific integration suites for Zoom, Meet, and Teams are part of the release gate.
- **Test vectors**: `TV-BUILD-001`
- **Notes**: External-provider credentials may still be mocked in CI/local tests, but the contract suites must exist.

## COMPAT-001

- **Priority**: P0
- **Statement**: The remediation MUST preserve existing public HTTP routes and package entry points, and any required contract correction MUST ship with explicit migration notes and versioning guidance.
- **Rationale**: `nucleus` integration should not break unexpectedly while `recfn` is hardened.
- **Acceptance criteria**:
  - Existing route paths remain valid.
  - Existing package names and primary entry points remain valid.
  - Contract corrections ship with migration notes and compatibility tests.
- **Test vectors**: `TV-COMPAT-001`
- **Notes**: Compatibility shims MUST be explicit, documented, and time-bounded.

