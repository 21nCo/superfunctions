# Metadata

- timestamp: `2026-04-01T10:37:06Z`
- agent_name: `unknown-agent`
- model: `gpt-5`
- launcher: `Codex Desktop`
- workspace/project path: `repo root`
- OS: `Darwin arm64`
- shell: `zsh`
- repo:
  - git repo: `yes`
  - branch: `detached HEAD`
  - commit: `7adae771e458`
  - dirty: `yes`
- spec_folder: `2026-04-01-audit-fix-xv2qyvtw-spec`
- spec_folder path: `recfn/.conduct/specs/2026-04-01-audit-fix-xv2qyvtw-spec`
- spec_type: `audit-fix`
- spec_id: `xv2qyvtw`
- input paths:
  - `AGENTS.md`
  - `recfn/README.md`
  - `recfn/platforms/meet/README.md`
  - `recfn/platforms/teams/README.md`
  - `recfn/python/README.md`
  - `recfn/.conduct/audits/2026-04-01-q4k2n8-full-audit.md`
  - `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/SPEC.md`
  - `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/REQUIREMENTS.md`
  - `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/TEST_VECTORS.md`
  - `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/PLAN.md`
  - `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec/INTENT_AUDIT.md`
- audit reference:
  - audit file: `recfn/.conduct/audits/2026-04-01-q4k2n8-full-audit.md`
  - audited spec bundle: `recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec`

# Overview

This audit-fix specification productionizes `recfn` for `nucleus` by correcting the blockers identified in the `2026-04-01-q4k2n8` audit, preserving the existing `recfn` public contract where practical, and replacing bespoke infrastructure seams with shared Superfunctions packages where they already exist in the monorepo.

One-sentence goal: `recfn` MUST become a production-ready, self-hosted meeting recording and transcription subsystem for `nucleus`, with reliable end-to-end bot recording on the named Tier-1 platforms, durable storage and persistence, secure namespace isolation, SDK parity, and materially reduced duplication through shared Superfunctions infrastructure.

Assumption A1: For this spec, the named Tier-1 production platform matrix is `zoom`, `meet`, `teams`, and `desktop_capture`. No additional platform names were provided in the source material.

Question Q1: If `nucleus` requires additional named platforms such as Webex or Slack Huddles in the same delivery window, a follow-up change spec MUST be written before execution starts. This bundle does not silently claim support for unnamed platforms.

# Glossary

- Tier-1 Platform: A platform that the product MAY claim as production-supported in documentation and runtime capability responses. In this spec, Tier-1 means `zoom`, `meet`, `teams`, and `desktop_capture`.
- Production support matrix: The canonical, versioned record of which capabilities are supported for each Tier-1 platform, including join, recording, chat capture, participant tracking, and real-time transcription.
- Aggregate bot view: The API representation returned by `GET /api/v1/bots/:botId`, containing the base bot plus recordings, participants, metadata, and chat state.
- Durable store: The namespace-scoped persistence layer implemented through `@superfunctions/db`.
- Storage adapter: A shared adapter implementing the `@superfunctions/storage` contract.
- Browser core: A shared package used by browser-automation platforms to handle page/session bootstrap, participant observation, chat observation, and media-capture lifecycle.
- Streaming-capable ASR: An ASR adapter path that emits partial or complete segments continuously from live audio without buffering the entire meeting first.
- Secret reference: A stable identifier resolved through `secfn` at runtime instead of embedding plaintext credentials in config or request bodies.
- Import recording: A recording uploaded manually through the existing `POST /api/v1/recordings/upload` path, typically by the desktop SDK or backfill tooling.
- Capability gate: Runtime validation that rejects unsupported feature combinations before work starts, using deterministic error codes.
- Release gate: A repo-root verification suite that MUST pass before the remediation bundle can be marked complete.

# Goals / Non-goals

## Goals

1. `recfn` MUST reliably create recordings from bot-driven sessions on `zoom`, `meet`, and `teams`.
2. `recfn` MUST retain the existing HTTP and SDK surface wherever the audit does not require a contract correction.
3. Server state MUST move from ad hoc memory-only persistence to durable namespace-scoped persistence.
4. Recording storage MUST move to shared storage abstractions already present in the monorepo.
5. Browser-platform duplication MUST be reduced through a shared browser core.
6. WebSocket authorization and frame schemas MUST be production-safe and cross-SDK consistent.
7. Python SDK and CLI behavior MUST close the gaps called out in the audit.
8. Observability, secret handling, and release verification MUST be strong enough for production rollout inside `nucleus`.

## Non-goals

1. This spec does NOT add a hosted SaaS control plane.
2. This spec does NOT add mobile SDKs.
3. This spec does NOT add PSTN or phone-call recording.
4. This spec does NOT add AI summarization, memory storage, or notification workflows beyond preserving consumer-side integration points.

# Public API

## Runtime configuration

The production server configuration MUST converge on the following contract:

```ts
type PlatformName = "zoom" | "meet" | "teams" | "desktop_capture";
type BotStatus =
  | "creating"
  | "joining"
  | "joined"
  | "recording"
  | "finalizing"
  | "leaving"
  | "left"
  | "done"
  | "error";

interface RecFnServerConfig {
  db: RecFnPersistence;
  storage: import("@superfunctions/storage").StorageAdapter;
  queue: import("@superfunctions/queue").QueueAdapter<JobPayload>;
  validateApiKey: ValidateApiKey;
  secretResolver: RecFnSecretResolver;
  logger: RecFnLogger;
  metrics?: RecFnMetrics;
  searchClient?: SearchFnClient;
  calendarService?: CalendarRuntimeService;
  platformRegistry: PlatformRegistry;
  asrRegistry: AsrRegistry;
  limits: RecFnLimitsConfig;
}
```

The existing `createRecFnServer(...)` entry point MUST remain available. If the internal config shape changes, the package MUST provide a compatibility layer or explicit migration notes.

## HTTP API

The following endpoints remain public and MUST continue to exist:

- `POST /api/v1/bots`
- `GET /api/v1/bots`
- `GET /api/v1/bots/:botId`
- `POST /api/v1/bots/:botId/leave`
- `DELETE /api/v1/bots/:botId`
- `GET /api/v1/bots/:botId/participants`
- `GET /api/v1/bots/:botId/chat`
- `GET /api/v1/bots/:botId/metadata`
- `GET /api/v1/bots/:botId/recordings`
- `GET /api/v1/recordings/:recordingId`
- `GET /api/v1/recordings/:recordingId/download`
- `POST /api/v1/recordings/:recordingId/transcribe`
- `GET /api/v1/recordings/:recordingId/transcript`
- `POST /api/v1/recordings/upload`
- `GET /api/v1/transcripts/search`
- `GET /api/v1/recordings/:recordingId/analytics`
- `POST /api/v1/calendars`
- `GET /api/v1/calendars`
- `DELETE /api/v1/calendars/:calendarId`
- `GET /api/v1/calendars/:calendarId/events`
- `POST /api/v1/webhooks`
- `GET /api/v1/webhooks`
- `DELETE /api/v1/webhooks/:webhookId`

## Aggregate bot view

`GET /api/v1/bots/:botId` MUST return:

```ts
interface AggregateBot {
  id: string;
  namespace: string;
  meetingUrl: string;
  platform: PlatformName;
  status: BotStatus;
  config: Required<BotConfig>;
  errorMessage?: string;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
  participants: Participant[];
  recordings: Recording[];
  metadata: MeetingMetadata | null;
  chatMessages: ChatMessage[];
}
```

## Search result shape

`GET /api/v1/transcripts/search` MUST return:

```ts
interface TranscriptSearchHit {
  recordingId: string;
  botId: string;
  participant: {
    id: string;
    name?: string;
    email?: string;
    role: "host" | "attendee" | "bot";
  } | null;
  segment: {
    speakerId: string;
    startTime: number;
    endTime: number;
    text: string;
    confidence?: number;
  };
  context: Array<{
    speakerId: string;
    startTime: number;
    endTime: number;
    text: string;
  }>;
}
```

## WebSocket API

The public WebSocket endpoint remains:

- `WS /ws/transcripts/:botId`

The server MUST use only the following frame shapes:

```ts
type WsFrame =
  | { type: "segment"; data: Segment }
  | { type: "participant_joined"; data: Participant }
  | { type: "participant_left"; data: { participantId: string } }
  | { type: "status"; data: { botStatus: BotStatus } }
  | { type: "error"; data: { code: string; message: string } }
  | { type: "pong" };
```

The first client frame MAY be omitted when the query string contains a valid token. When query-string auth is absent, the first client frame MUST be:

```json
{ "type": "auth", "token": "sk_live_..." }
```

## SDK contract

The TypeScript and Python SDKs MUST both expose:

- bot create/list/get/leave/delete
- recording list/get/downloadUrl/download/upload
- transcript get/search/transcribe
- participants list
- chat list
- metadata get
- analytics get
- calendars create/list/delete/listEvents
- webhooks create/list/delete
- transcript stream helpers that expose the canonical WS frame contract

## CLI contract

The `recfn` CLI MUST keep the existing command families (`bot`, `recording`, `transcript`, `analytics`, `calendar`) and MUST add an explicit opt-in flag for raw PII transcript output if the default output is redacted.

# Data formats / protocol

## Canonical JSON envelope

All JSON responses MUST use exactly one of:

```ts
type OkEnvelope<T> = { ok: true; data: T };
type ErrorEnvelope = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
```

## Raw success responses

The following success paths MAY return raw non-JSON bodies:

- `GET /api/v1/recordings/:recordingId/download`
- `GET /api/v1/recordings/:recordingId/transcript?format=srt|vtt|text`

All error responses for those endpoints MUST still return the canonical JSON error envelope.

## Canonical error codes

At minimum, the implementation MUST preserve or introduce these error codes:

- `BAD_REQUEST`
- `UNAUTHORIZED`
- `BOT_NOT_FOUND`
- `BOT_ALREADY_LEFT`
- `BOT_STILL_ACTIVE`
- `UNSUPPORTED_PLATFORM`
- `PLATFORM_CAPTURE_UNAVAILABLE`
- `RECORDING_NOT_FOUND`
- `RECORDING_FINALIZATION_FAILED`
- `TRANSCRIPTION_IN_PROGRESS`
- `REALTIME_TRANSCRIPT_UNSUPPORTED`
- `TRANSCRIPT_NOT_FOUND`
- `RATE_LIMIT_EXCEEDED`
- `WEBHOOK_NOT_FOUND`
- `CALENDAR_NOT_FOUND`
- `CALENDAR_AUTH_FAILED`
- `WS_UNAUTHORIZED`
- `WS_NAMESPACE_FORBIDDEN`
- `SECRET_NOT_FOUND`
- `INTERNAL_ERROR`

## Platform capability matrix

The runtime MUST expose a single source of truth for platform capabilities:

```ts
interface PlatformCapabilityMatrix {
  platform: PlatformName;
  join: boolean;
  botRecording: boolean;
  audioCapture: boolean;
  videoCapture: boolean;
  participantTracking: boolean;
  chatCapture: boolean;
  realtimeTranscript: boolean;
}
```

Documentation and error behavior MUST match this matrix. The system MUST NOT claim a capability that is not actually implemented in the runtime.

# Semantics

## Bot lifecycle and recording finalization

1. `POST /api/v1/bots` creates a bot in `creating`.
2. Queue processing transitions the bot through `joining`, `joined`, and `recording`.
3. Consent MUST be announced before recording begins.
4. When the meeting ends, the user calls leave, or auto-leave triggers, the bot MUST:
   - stop real-time transcription
   - finalize captured media
   - upload the finalized recording through the shared storage adapter
   - create or update the recording record in the durable store
   - emit `recording.ready`
   - transition through `finalizing` and then `done`
5. Manual import through `POST /api/v1/recordings/upload` remains valid for desktop capture and backfills, but it MUST NOT be the only way to create recordings.

## Persistence

The durable store MUST contain namespace-scoped records for:

- bots
- recordings
- transcripts
- transcript segments or transcript blobs
- participants
- chat messages
- meeting metadata
- webhooks
- calendars
- calendar event to bot associations

The development test harness MAY still use ephemeral or in-memory adapters, but production paths MUST use the `@superfunctions/db` interfaces.

## Browser-platform architecture

Google Meet and Microsoft Teams MUST share a common browser core for:

- browser/context/page bootstrap
- login/join readiness detection
- participant observation lifecycle
- chat observation lifecycle
- audio capture lifecycle
- deterministic teardown

Platform-specific packages MAY override selectors and provider-specific join flows, but MUST NOT duplicate the core orchestration pipeline.

## Real-time transcription

Real-time transcription MUST be capability-gated by:

- selected ASR adapter
- selected platform capture path
- measured latency profile

If the requested combination cannot provide streaming segments within the declared production constraint, the server MUST reject the request with `REALTIME_TRANSCRIPT_UNSUPPORTED` rather than silently buffering the full audio stream and pretending to be live.

## Search and analytics

Batch transcription completion MUST:

1. store sorted segments
2. index them into `searchfn`
3. preserve stable segment ordering
4. expose participant-resolved search hits and context windows
5. keep analytics inputs consistent with the stored transcript order

## Calendar runtime

Calendar auto-scheduling and token refresh MUST run as explicit runtime services. Exported helper functions alone are insufficient for production support.

# Invariants

1. All persisted entities MUST be namespace-scoped.
2. A WebSocket subscriber MUST NOT receive frames for a bot outside its authenticated namespace.
3. `participant.botId`, `recording.botId`, `metadata.botId`, and aggregate response identifiers MUST always agree.
4. Transcript segments MUST be sorted by `startTime`, then `speakerId`, then stable insertion index when needed as a final tiebreaker.
5. Search results MUST be ordered by score descending, with `recordingId` and segment position as deterministic tiebreakers.
6. All timestamps exposed publicly MUST be ISO 8601 UTC strings, except transcript segment times which remain numeric milliseconds.
7. Raw export/download success bodies MAY vary by requested format, but error envelopes MUST NOT vary.
8. Unsupported platforms or unsupported capability combinations MUST fail before queueing long-running work.
9. Secret material MUST NOT appear in logs, API responses, webhook payloads, or CLI default output.
10. The platform support matrix and documentation MUST stay consistent with runtime capability gates.

# Security

1. HTTP authentication MUST continue to require API keys.
2. WebSocket authentication MUST validate both the token and the target bot namespace.
3. OAuth tokens, ASR credentials, and any third-party secret material MUST be resolved through `secfn`-backed secret references or an equivalent `secfn` integration layer.
4. Recordings MUST be stored through shared storage adapters with encryption-at-rest enabled where the backing adapter supports it.
5. CLI transcript output MUST default to redacted mode. A caller MAY opt in to raw PII output with an explicit flag.
6. Diagnostic logs MUST include enough structured context for debugging but MUST exclude secrets and full transcript bodies.

# Limits/caps

The implementation MUST keep the baseline limits and make them config-driven:

- max concurrent bots per namespace: default `100`
- max recording duration: default `8h`
- max transcript segments per recording: default `100000`
- max WebSocket connections per bot: default `50`
- max webhooks per namespace: default `20`
- max calendars per namespace: default `10`
- max page size for list endpoints: default `100`
- max search query length: implementation-defined but fixed and documented

All limit checks MUST be enforced consistently across HTTP and WebSocket entry points.

# Observability

The system MUST emit structured logs and metrics for:

- bot lifecycle transitions
- join latency
- recording finalization start/finish/failure
- ASR latency
- WebSocket authorization failures
- search indexing completion
- calendar scheduling decisions
- token refresh failures

The system MUST NOT log:

- API keys
- OAuth access tokens
- OAuth refresh tokens
- ASR provider secrets
- raw transcript content by default

# Compatibility / versioning strategy

1. Existing route paths MUST remain stable.
2. Existing package names and entry points MUST remain stable.
3. Contract-correcting field changes MAY add fields but MUST NOT rename or remove existing public fields without a documented migration.
4. The WebSocket `status` payload correction to `{ botStatus }` is REQUIRED. If a transitional compatibility shim is needed, it MUST be documented and time-bounded.
5. This remediation bundle MUST ship migration notes for:
   - persistence changes
   - storage config changes
   - secret resolution changes
   - CLI redaction default change

# Undefined / Explicitly user-deferred only

The following are Undefined and therefore NOT required by this bundle:

1. Production support for platforms not named in Assumption A1.
2. A hosted UI or dashboard for bot/session management.
3. Built-in memory storage or summarization behavior for downstream AI workflows.
4. Optional `sendfn` notification workflows beyond preserving integration points.

