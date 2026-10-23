# RecFn Requirements

## Table of contents

- [BOT-001](#bot-001) … [BOT-010](#bot-010) Bot lifecycle and management
- [REC-001](#rec-001) … [REC-006](#rec-006) Recording capture and storage
- [TRX-001](#trx-001) … [TRX-008](#trx-008) Transcription (real-time and batch)
- [PAR-001](#par-001) … [PAR-003](#par-003) Participant tracking
- [CHAT-001](#chat-001) … [CHAT-002](#chat-002) Chat message capture
- [CAL-001](#cal-001) … [CAL-004](#cal-004) Calendar integration
- [WH-001](#wh-001) … [WH-004](#wh-004) Webhook events
- [API-001](#api-001) … [API-006](#api-006) REST API
- [WS-001](#ws-001) … [WS-003](#ws-003) WebSocket real-time streaming
- [PLAT-001](#plat-001) … [PLAT-004](#plat-004) Platform adapters
- [ASR-001](#asr-001) … [ASR-005](#asr-005) ASR adapters
- [ANA-001](#ana-001) … [ANA-003](#ana-003) Analytics
- [EXP-001](#exp-001) … [EXP-002](#exp-002) Export formats
- [DSK-001](#dsk-001) … [DSK-003](#dsk-003) Desktop capture SDK
- [CLI-001](#cli-001) … [CLI-004](#cli-004) CLI
- [SDK-001](#sdk-001) … [SDK-003](#sdk-003) Client SDKs (TypeScript + Python)
- [SEC-001](#sec-001) … [SEC-006](#sec-006) Security
- [INT-001](#int-001) … [INT-006](#int-006) Ecosystem integrations
- [LIMIT-001](#limit-001) … [LIMIT-003](#limit-003) Limits
- [OBS-001](#obs-001) … [OBS-003](#obs-003) Observability
- [SRCH-001](#srch-001) … [SRCH-002](#srch-002) Transcript search

---

## Bot lifecycle and management

### BOT-001
- **Priority**: P0
- **Statement**: The system MUST allow creating a bot by providing a meeting URL; the bot MUST join the meeting on the detected or specified platform.
- **Rationale**: Core capability — sending bots into meetings is the primary use case.
- **Acceptance criteria**:
  - POST /bots with valid meetingUrl returns 201 with Bot entity.
  - Bot transitions through creating → joining → joined → recording.
  - Platform auto-detected from URL when not explicitly provided.
- **Test vectors**: TV-BOT-001, TV-BOT-002
- **Notes**: URL validation against known platform patterns. Unknown/invalid URL → BOT_CREATE_FAILED.

### BOT-002
- **Priority**: P0
- **Statement**: The system MUST support the full bot lifecycle state machine: creating → joining → joined → recording → leaving → left → done | error.
- **Rationale**: Callers need reliable status to coordinate their workflows.
- **Acceptance criteria**:
  - Bot status transitions follow defined state machine.
  - No backward transitions allowed.
  - Terminal states (done, error) are final.
- **Test vectors**: TV-BOT-003
- **Notes**: Each transition fires a webhook event if webhooks are configured.

### BOT-003
- **Priority**: P0
- **Statement**: The system MUST support an explicit leave command (POST /bots/:botId/leave) that causes the bot to leave the meeting gracefully.
- **Rationale**: Callers need control over when the bot exits.
- **Acceptance criteria**:
  - POST /bots/:botId/leave transitions bot to `leaving`, then `left`.
  - Returns 409 BOT_ALREADY_LEFT if bot already left/done.
  - Returns 404 BOT_NOT_FOUND if invalid botId.
- **Test vectors**: TV-BOT-004, TV-BOT-005
- **Notes**: Idempotent for bots already leaving/left.

### BOT-004
- **Priority**: P0
- **Statement**: The system MUST auto-leave when all non-bot participants have left the meeting, after a configurable timeout (default 30s).
- **Rationale**: Prevents bots from staying in empty meetings indefinitely.
- **Acceptance criteria**:
  - When autoLeaveOnEmpty is true (default) and last non-bot participant leaves, bot waits autoLeaveEmptyTimeout ms then transitions to `leaving`.
  - When autoLeaveOnEmpty is false, bot stays until explicit leave or meeting ends.
- **Test vectors**: TV-BOT-006
- **Notes**: autoLeaveEmptyTimeout configurable per bot via BotConfig.

### BOT-005
- **Priority**: P0
- **Statement**: The system MUST support listing bots with pagination (limit + cursor) and filtering by status and platform.
- **Rationale**: Standard CRUD listing requirement.
- **Acceptance criteria**:
  - GET /bots returns paginated list scoped to namespace.
  - status filter returns only matching bots.
  - nextCursor present when more results exist.
- **Test vectors**: TV-API-001, TV-API-002
- **Notes**: Default limit 20, max 100. Order: createdAt descending.

### BOT-006
- **Priority**: P0
- **Statement**: The system MUST support getting a single bot by ID, including its participants, recordings, and metadata.
- **Rationale**: Standard CRUD detail requirement.
- **Acceptance criteria**:
  - GET /bots/:botId returns full Bot entity with nested data.
  - 404 BOT_NOT_FOUND for invalid ID.
- **Test vectors**: TV-BOT-007
- **Notes**: Namespace-scoped.

### BOT-007
- **Priority**: P1
- **Statement**: The system MUST support deleting a bot and all associated data (recordings, transcripts, analytics).
- **Rationale**: Data lifecycle management; GDPR/compliance needs.
- **Acceptance criteria**:
  - DELETE /bots/:botId removes bot, recordings, transcripts from storage and DB.
  - Returns 409 BOT_STILL_ACTIVE if bot is not in terminal state.
  - Returns 200 with deleted: true on success.
- **Test vectors**: TV-BOT-008, TV-BOT-009
- **Notes**: Irreversible. Removes files from filefn/storage.

### BOT-008
- **Priority**: P0
- **Statement**: The bot MUST announce a consent message (configurable) when joining a meeting before recording begins.
- **Rationale**: Recording consent is a hard constraint.
- **Acceptance criteria**:
  - Bot sends consent message via chat (or audio, platform-dependent) after joining.
  - Bot does not transition to `recording` until consent message is sent.
  - Consent message text is configurable via BotConfig.consentMessage.
- **Test vectors**: TV-BOT-010
- **Notes**: Default message: "This meeting is being recorded."

### BOT-009
- **Priority**: P0
- **Statement**: The bot MUST join the meeting within the configured joinTimeout (default 30s); if join fails, bot MUST transition to `error` status.
- **Rationale**: Prevent bots from hanging indefinitely.
- **Acceptance criteria**:
  - Bot that cannot join within joinTimeout transitions to `error`.
  - errorMessage field is populated with failure reason.
- **Test vectors**: TV-BOT-011
- **Notes**: joinTimeout configurable per bot. Max 60s.

### BOT-010
- **Priority**: P0
- **Statement**: The system MUST support configuring bot behavior via BotConfig (displayName, joinTimeout, autoLeaveOnEmpty, consentMessage, enableRealTimeTranscript, asrProvider, recordingFormat, language).
- **Rationale**: Flexibility for different use cases.
- **Acceptance criteria**:
  - All BotConfig fields are optional with documented defaults.
  - Invalid asrProvider → BAD_REQUEST at creation time.
  - Unknown config keys are silently ignored.
- **Test vectors**: TV-BOT-012
- **Notes**: Defaults documented in SPEC.md.

---

## Recording capture and storage

### REC-001
- **Priority**: P0
- **Statement**: The system MUST capture meeting audio/video and produce a recording file in the configured format (MP4 or audio-only).
- **Rationale**: Core recording capability.
- **Acceptance criteria**:
  - After bot leaves, a Recording entity is created with valid format, duration, and size.
  - Recording file is stored in filefn/storage.
  - downloadUrl is a signed, time-limited URL.
- **Test vectors**: TV-REC-001
- **Notes**: MP4 is default. Audio-only produces WAV or OPUS.

### REC-002
- **Priority**: P1
- **Statement**: The system SHOULD capture separate audio tracks per participant where the platform allows.
- **Rationale**: Recall.ai feature parity; enables better diarization and per-participant analytics.
- **Acceptance criteria**:
  - For platforms supporting per-participant audio (Zoom), separate audio files are stored.
  - For platforms that don't support it, a single mixed audio track is stored.
  - Per-participant tracks are accessible via the recordings API.
- **Test vectors**: TV-REC-002
- **Notes**: Platform-dependent. Zoom supports separate tracks natively.

### REC-003
- **Priority**: P0
- **Statement**: Recordings MUST be uploaded to filefn/storage within 60 seconds of the bot leaving the meeting.
- **Rationale**: Performance constraint from requirements.
- **Acceptance criteria**:
  - Time from bot `left` to recording available (storageRef populated) is <60s for recordings up to 1 hour.
  - Longer recordings MAY take proportionally longer.
- **Test vectors**: TV-REC-003
- **Notes**: Upload is queued via flowfn for reliability.

### REC-004
- **Priority**: P0
- **Statement**: Recordings MUST be encrypted at rest via the storage adapter.
- **Rationale**: Security hard constraint.
- **Acceptance criteria**:
  - Storage adapter is configured with encryption (e.g., S3 server-side encryption).
  - Raw recording bytes are not stored in plaintext on disk (unless local dev mode with explicit opt-out).
- **Test vectors**: TV-SEC-003
- **Notes**: Encryption delegated to filefn/storage adapter.

### REC-005
- **Priority**: P0
- **Statement**: The system MUST support downloading recordings via signed, time-limited URLs.
- **Rationale**: Secure access to recording files.
- **Acceptance criteria**:
  - GET /recordings/:recordingId returns downloadUrl (signed, expires in 1 hour by default).
  - GET /recordings/:recordingId/download returns 302 redirect or streams binary.
  - Expired URLs return 403 from storage.
- **Test vectors**: TV-REC-004
- **Notes**: URL expiry configurable at server level.

### REC-006
- **Priority**: P1
- **Statement**: The system MUST support listing recordings for a bot.
- **Rationale**: Standard CRUD.
- **Acceptance criteria**:
  - GET /bots/:botId/recordings returns array of Recording entities.
  - Empty array if no recordings yet.
- **Test vectors**: TV-REC-005
- **Notes**: Namespace-scoped via botId.

---

## Transcription

### TRX-001
- **Priority**: P0
- **Statement**: The system MUST support real-time transcription via a streaming ASR adapter, delivering segments over WebSocket with <2s latency behind live audio.
- **Rationale**: Core real-time transcription capability.
- **Acceptance criteria**:
  - When enableRealTimeTranscript is true, segments appear on WS /ws/transcripts/:botId within 2s of utterance.
  - Segments include speakerId, startTime, endTime, text, confidence.
  - Speaker diarization is enabled by default.
- **Test vectors**: TV-TRX-001
- **Notes**: Latency measured from audio capture to WebSocket delivery.

### TRX-002
- **Priority**: P0
- **Statement**: The system MUST support asynchronous (batch) transcription of recordings with higher accuracy.
- **Rationale**: Post-meeting transcription produces better results than real-time.
- **Acceptance criteria**:
  - POST /recordings/:recordingId/transcribe triggers batch transcription.
  - Returns 202 with status "processing".
  - On completion, Transcript entity has status "ready" and segments are populated.
  - Webhook transcript.ready is fired.
- **Test vectors**: TV-TRX-002
- **Notes**: Can be triggered automatically after recording or manually via API.

### TRX-003
- **Priority**: P0
- **Statement**: The system MUST support speaker diarization in transcripts, associating each segment with a speakerId that maps to a Participant.
- **Rationale**: Speaker identification is essential for meeting transcripts.
- **Acceptance criteria**:
  - Transcript segments have speakerId fields.
  - speakerIds correlate with Participant entities where possible.
  - When correlation is not possible (e.g., ASR cannot match), speakerId is a generated identifier (e.g., "speaker_1").
- **Test vectors**: TV-TRX-003
- **Notes**: Correlation quality depends on platform and ASR adapter.

### TRX-004
- **Priority**: P0
- **Statement**: The system MUST return 409 TRANSCRIPTION_IN_PROGRESS if transcription is already running for a recording.
- **Rationale**: Prevent duplicate work and resource waste.
- **Acceptance criteria**:
  - Second POST /recordings/:recordingId/transcribe while first is processing returns 409.
  - After first completes, re-triggering starts a new transcription (re-transcription).
- **Test vectors**: TV-TRX-004
- **Notes**: Re-transcription overwrites previous transcript.

### TRX-005
- **Priority**: P0
- **Statement**: The system MUST retrieve transcripts via GET /recordings/:recordingId/transcript with support for format query param (json, srt, vtt, text).
- **Rationale**: Multiple export formats needed for different consumers.
- **Acceptance criteria**:
  - format=json returns Transcript JSON with Content-Type application/json.
  - format=srt returns SubRip text with Content-Type text/plain.
  - format=vtt returns WebVTT with Content-Type text/vtt.
  - format=text returns plain text with Content-Type text/plain.
  - Default format is json.
- **Test vectors**: TV-TRX-005, TV-EXP-001, TV-EXP-002
- **Notes**: SRT/VTT include speaker labels. Text includes timestamps.

### TRX-006
- **Priority**: P0
- **Statement**: Transcript segments MUST be ordered chronologically by startTime, with speakerId as tiebreaker.
- **Rationale**: Determinism invariant.
- **Acceptance criteria**:
  - Segments in returned transcript are sorted by startTime ascending, then speakerId ascending.
- **Test vectors**: TV-TRX-006
- **Notes**: Applies to both real-time and batch transcripts.

### TRX-007
- **Priority**: P1
- **Statement**: The system MUST support configuring ASR provider and language per bot.
- **Rationale**: Different meetings may need different ASR providers or languages.
- **Acceptance criteria**:
  - BotConfig.asrProvider selects the ASR adapter (validated at creation).
  - BotConfig.language is passed to the ASR adapter.
  - Unknown asrProvider → BAD_REQUEST.
- **Test vectors**: TV-TRX-007
- **Notes**: Default asrProvider: "whisper". Default language: "en-US".

### TRX-008
- **Priority**: P1
- **Statement**: The system SHOULD support PII redaction in exported transcripts when configured.
- **Rationale**: Privacy and compliance requirement.
- **Acceptance criteria**:
  - When redaction is enabled, participant names and emails in transcript text are replaced with placeholders.
  - Redaction is opt-in per transcript export request.
- **Test vectors**: TV-TRX-008
- **Notes**: Redaction applies to export only; stored transcript retains original text.

---

## Participant tracking

### PAR-001
- **Priority**: P0
- **Statement**: The system MUST track participants in a meeting: name, email (when available), role, join time, leave time.
- **Rationale**: Participant data is essential for diarization, analytics, and compliance.
- **Acceptance criteria**:
  - GET /bots/:botId/participants returns list of Participant entities.
  - Each participant has name, role, joinedAt. email and leftAt populated when available.
  - Participant events are captured in real-time.
- **Test vectors**: TV-PAR-001
- **Notes**: Email availability is platform-dependent.

### PAR-002
- **Priority**: P0
- **Statement**: The system MUST track participant consent status (granted, denied, pending, unknown).
- **Rationale**: Consent tracking is a hard constraint.
- **Acceptance criteria**:
  - Each Participant has a consent field.
  - Default is "pending" when bot joins, "unknown" for participants who never interact with consent mechanism.
  - Consent status is included in participant API responses.
- **Test vectors**: TV-PAR-002
- **Notes**: Consent enforcement is consumer's responsibility; recfn tracks status.

### PAR-003
- **Priority**: P0
- **Statement**: The system MUST fire webhook events when participants join or leave the meeting.
- **Rationale**: Real-time participant awareness for consumers.
- **Acceptance criteria**:
  - participant.joined event fired when a new participant is detected.
  - participant.left event fired when a participant leaves.
  - Events include participant data.
- **Test vectors**: TV-PAR-003
- **Notes**: Events delivered via plugfn.

---

## Chat message capture

### CHAT-001
- **Priority**: P0
- **Statement**: The system MUST capture chat messages sent during the meeting.
- **Rationale**: Recall.ai feature parity; chat context is valuable for meeting records.
- **Acceptance criteria**:
  - GET /bots/:botId/chat returns array of ChatMessage entities.
  - Each message has participantId, text, timestamp.
  - Messages captured in real-time as they are sent.
- **Test vectors**: TV-CHAT-001
- **Notes**: Platform-dependent; some platforms may restrict chat access.

### CHAT-002
- **Priority**: P1
- **Statement**: The system SHOULD support sending chat messages from the bot (e.g., consent announcement, status messages).
- **Rationale**: Bot communication with meeting participants.
- **Acceptance criteria**:
  - Platform adapter sendChatMessage method is implemented.
  - Consent message is sent via chat when joining.
- **Test vectors**: TV-CHAT-002
- **Notes**: Used for consent mechanism.

---

## Calendar integration

### CAL-001
- **Priority**: P1
- **Statement**: The system MUST support connecting Google Calendar and Outlook calendars via OAuth.
- **Rationale**: Calendar integration enables auto-scheduling of bots.
- **Acceptance criteria**:
  - POST /calendars with provider "google" or "outlook" and valid tokens creates a Calendar entity.
  - Invalid tokens → CALENDAR_AUTH_FAILED.
  - GET /calendars lists connected calendars.
  - DELETE /calendars/:calendarId removes integration.
- **Test vectors**: TV-CAL-001, TV-CAL-002
- **Notes**: OAuth tokens stored in secfn.

### CAL-002
- **Priority**: P1
- **Statement**: The system MUST discover upcoming meetings with video conference links from connected calendars.
- **Rationale**: Enables auto-scheduling.
- **Acceptance criteria**:
  - GET /calendars/:calendarId/events returns CalendarEvent entities with meetingUrl when available.
  - Events are fetched from calendar API (polling or push).
- **Test vectors**: TV-CAL-003
- **Notes**: Polling interval configurable (default 5 minutes).

### CAL-003
- **Priority**: P1
- **Statement**: The system MUST auto-schedule bots for upcoming calendar events when autoSchedule is enabled.
- **Rationale**: Automate bot deployment for scheduled meetings.
- **Acceptance criteria**:
  - When autoSchedule is true, bots are created automatically for events with meetingUrl.
  - Bot is created at configurable lead time before event start (default 1 minute).
  - CalendarEvent.botId is populated when a bot is auto-created.
- **Test vectors**: TV-CAL-004
- **Notes**: Only events with recognizable meeting URLs trigger bot creation.

### CAL-004
- **Priority**: P1
- **Statement**: The system MUST handle calendar token refresh for long-lived integrations.
- **Rationale**: OAuth tokens expire; integrations must remain functional.
- **Acceptance criteria**:
  - When an access token expires and a refresh token is available, system auto-refreshes.
  - If refresh fails, calendar status is set to "expired" and CALENDAR_AUTH_FAILED webhook is fired.
- **Test vectors**: TV-CAL-005
- **Notes**: Refresh tokens stored in secfn.

---

## Webhook events

### WH-001
- **Priority**: P0
- **Statement**: The system MUST support configuring webhook endpoints (URL + events + optional HMAC secret).
- **Rationale**: Event-driven integration for consumers.
- **Acceptance criteria**:
  - POST /webhooks creates webhook with url, events array, optional secret.
  - GET /webhooks lists configured webhooks.
  - DELETE /webhooks/:webhookId removes a webhook.
- **Test vectors**: TV-WH-001
- **Notes**: Max 20 webhooks per namespace.

### WH-002
- **Priority**: P0
- **Statement**: The system MUST deliver webhook events for: bot.joining, bot.joined, bot.left, bot.error, recording.ready, transcript.ready, participant.joined, participant.left.
- **Rationale**: Full event coverage per Recall.ai parity.
- **Acceptance criteria**:
  - Each listed event type is fired at the appropriate lifecycle point.
  - Payload includes event name, timestamp, and relevant entity data.
  - Events are delivered to all matching webhooks for the namespace.
- **Test vectors**: TV-WH-002, TV-WH-003
- **Notes**: Via plugfn for delivery and retry.

### WH-003
- **Priority**: P0
- **Statement**: Webhook payloads MUST be signed with HMAC-SHA256 when a secret is configured, with signature in X-RecFn-Signature header.
- **Rationale**: Security requirement; consumers verify webhook authenticity.
- **Acceptance criteria**:
  - When webhook has secret, X-RecFn-Signature header is present with valid HMAC.
  - When no secret, header is absent.
- **Test vectors**: TV-WH-004
- **Notes**: HMAC computed over raw JSON body.

### WH-004
- **Priority**: P0
- **Statement**: Webhook delivery MUST be at-least-once; failed deliveries MUST be retried.
- **Rationale**: Reliability requirement.
- **Acceptance criteria**:
  - Failed delivery (non-2xx response or timeout) triggers retry via plugfn retry policy.
  - Each event payload includes a unique eventId for consumer deduplication.
- **Test vectors**: TV-WH-005
- **Notes**: Retry count and backoff defined by plugfn configuration.

---

## REST API

### API-001
- **Priority**: P0
- **Statement**: All API responses MUST use the canonical envelope: `{ ok: true, data: T }` or `{ ok: false, error: { code, message, details? } }`.
- **Rationale**: Superfunctions convention; consistent error handling.
- **Acceptance criteria**:
  - Every successful response has ok: true and data field.
  - Every error response has ok: false and error.code from defined error codes.
  - HTTP status matches (200/201/202 for ok:true, 4xx/5xx for ok:false).
- **Test vectors**: TV-API-001, TV-API-002
- **Notes**: Exception: binary downloads and non-JSON transcript exports return raw content.

### API-002
- **Priority**: P0
- **Statement**: All API endpoints MUST require authentication via API key in Authorization header.
- **Rationale**: Security hard constraint.
- **Acceptance criteria**:
  - Request without Authorization header returns 401 UNAUTHORIZED.
  - Request with invalid API key returns 401 UNAUTHORIZED.
  - Valid API key grants access scoped to the key's namespace.
- **Test vectors**: TV-API-003
- **Notes**: API key validated via secfn.

### API-003
- **Priority**: P0
- **Statement**: All list endpoints MUST support pagination via limit + cursor query params.
- **Rationale**: Standard API design for large result sets.
- **Acceptance criteria**:
  - limit defaults to 20, max 100. limit > 100 → BAD_REQUEST or capped.
  - nextCursor present when more results exist.
  - cursor references the next page; invalid cursor → BAD_REQUEST.
- **Test vectors**: TV-API-004
- **Notes**: Order: createdAt descending.

### API-004
- **Priority**: P0
- **Statement**: API MUST enforce namespace isolation: requests see only entities belonging to their namespace.
- **Rationale**: Multi-tenant security.
- **Acceptance criteria**:
  - API key for namespace A cannot access entities in namespace B.
  - Attempting to access a bot in another namespace returns 404, not 403 (no information leakage).
- **Test vectors**: TV-API-005
- **Notes**: Namespace derived from API key.

### API-005
- **Priority**: P0
- **Statement**: The API server MUST use @superfunctions/http for route definition and framework adapters.
- **Rationale**: Ecosystem consistency; framework-agnostic.
- **Acceptance criteria**:
  - Server routes are defined using @superfunctions/http abstractions.
  - At least one framework adapter works (e.g., http-hono or http-express).
- **Test vectors**: N/A (architectural constraint)
- **Notes**: Similar to authfn and datafn server patterns.

### API-006
- **Priority**: P0
- **Statement**: The API server MUST use @superfunctions/db for persistence.
- **Rationale**: Ecosystem consistency; database-agnostic.
- **Acceptance criteria**:
  - Server uses @superfunctions/db adapter interface for storing bots, recordings, transcripts, etc.
  - At least one DB adapter works (e.g., Drizzle).
- **Test vectors**: N/A (architectural constraint)
- **Notes**: Similar to authfn and datafn patterns.

---

## WebSocket real-time streaming

### WS-001
- **Priority**: P0
- **Statement**: The system MUST provide a WebSocket endpoint (WS /ws/transcripts/:botId) for streaming real-time transcript segments.
- **Rationale**: Real-time transcription requires low-latency delivery.
- **Acceptance criteria**:
  - WebSocket connection established with valid auth and valid botId.
  - Server pushes segment frames as ASR produces them.
  - Connection closes when bot leaves or errors.
- **Test vectors**: TV-WS-001
- **Notes**: Auth via query param token or first message.

### WS-002
- **Priority**: P0
- **Statement**: WebSocket frames MUST include typed messages: segment, participant_joined, participant_left, status, error.
- **Rationale**: Structured real-time event stream.
- **Acceptance criteria**:
  - Each frame has `type` field and `data` field.
  - segment data matches Segment shape.
  - participant_joined data matches Participant shape.
- **Test vectors**: TV-WS-002
- **Notes**: Client can send ping; server responds with pong.

### WS-003
- **Priority**: P1
- **Statement**: The system MUST support up to 50 concurrent WebSocket connections per bot.
- **Rationale**: Multiple consumers may listen to the same bot's transcript.
- **Acceptance criteria**:
  - 50 concurrent connections to same botId work.
  - Connection 51 is rejected with error frame.
- **Test vectors**: TV-WS-003
- **Notes**: Limit configurable at server level.

---

## Platform adapters

### PLAT-001
- **Priority**: P0
- **Statement**: The system MUST define a PlatformAdapter interface that all platform implementations conform to.
- **Rationale**: Modularity hard constraint; add/remove platforms independently.
- **Acceptance criteria**:
  - PlatformAdapter interface defined in recfn/core with join, leave, getAudioStream, getParticipants, getChatMessages, getMetadata, event callbacks.
  - Interface is exported and documented.
- **Test vectors**: N/A (interface definition)
- **Notes**: See SPEC.md for full interface.

### PLAT-002
- **Priority**: P0
- **Statement**: The system MUST implement a Zoom platform adapter using the Zoom Meeting SDK.
- **Rationale**: Zoom has the most mature bot API; primary platform.
- **Acceptance criteria**:
  - Zoom adapter implements PlatformAdapter interface.
  - Bot can join a Zoom meeting via URL, capture audio/video, track participants, capture chat.
  - Supports per-participant audio tracks.
- **Test vectors**: TV-PLAT-001
- **Notes**: Requires Zoom Meeting SDK credentials configured via secfn.

### PLAT-003
- **Priority**: P0
- **Statement**: The system MUST implement a Google Meet platform adapter using a headless browser approach.
- **Rationale**: Google Meet does not offer a native bot SDK; headless browser is the standard approach.
- **Acceptance criteria**:
  - Meet adapter implements PlatformAdapter interface.
  - Bot can join a Google Meet meeting via URL, capture audio (system audio or WebRTC), track participants, capture chat.
  - Uses Puppeteer or Playwright for browser automation.
- **Test vectors**: TV-PLAT-002
- **Notes**: May require Chrome/Chromium installed. Audio capture via WebRTC or virtual audio device.

### PLAT-004
- **Priority**: P0
- **Statement**: The system MUST implement a Microsoft Teams platform adapter using Microsoft Graph API and/or headless browser.
- **Rationale**: Teams is a major platform; feature parity with Recall.ai.
- **Acceptance criteria**:
  - Teams adapter implements PlatformAdapter interface.
  - Bot can join a Teams meeting via URL, capture audio, track participants, capture chat.
- **Test vectors**: TV-PLAT-003
- **Notes**: May use Graph Communications API for native bot support or headless browser as fallback.

---

## ASR adapters

### ASR-001
- **Priority**: P0
- **Statement**: The system MUST define an AsrAdapter interface with transcribeStream (real-time) and transcribeBatch (async) methods.
- **Rationale**: Pluggable ASR is a hard constraint.
- **Acceptance criteria**:
  - AsrAdapter interface defined in recfn/core.
  - Interface includes name, transcribeStream, transcribeBatch, supportedLanguages.
- **Test vectors**: N/A (interface definition)
- **Notes**: See SPEC.md for full interface.

### ASR-002
- **Priority**: P0
- **Statement**: The system MUST implement a Whisper ASR adapter for local (offline) transcription.
- **Rationale**: Self-hosted requirement; no external API dependency for basic operation.
- **Acceptance criteria**:
  - Whisper adapter implements AsrAdapter interface.
  - Works without GPU (CPU mode, potentially slower).
  - Supports batch transcription. Real-time streaming MAY have higher latency on CPU.
- **Test vectors**: TV-ASR-001
- **Notes**: Uses whisper.cpp or openai-whisper Python package via child process or WASM. GPU optional for performance.

### ASR-003
- **Priority**: P1
- **Statement**: The system MUST implement a Deepgram ASR adapter for cloud transcription.
- **Rationale**: Deepgram offers real-time streaming ASR with excellent diarization.
- **Acceptance criteria**:
  - Deepgram adapter implements AsrAdapter interface.
  - Supports both streaming and batch modes.
  - API key stored in secfn.
- **Test vectors**: TV-ASR-002
- **Notes**: Requires Deepgram API key.

### ASR-004
- **Priority**: P1
- **Statement**: The system MUST implement an AssemblyAI ASR adapter for cloud transcription.
- **Rationale**: AssemblyAI offers high-accuracy batch transcription with diarization.
- **Acceptance criteria**:
  - AssemblyAI adapter implements AsrAdapter interface.
  - Supports batch mode. Real-time via AssemblyAI's real-time API.
  - API key stored in secfn.
- **Test vectors**: TV-ASR-003
- **Notes**: Requires AssemblyAI API key.

### ASR-005
- **Priority**: P2
- **Statement**: The system MUST implement a Google Speech-to-Text ASR adapter.
- **Rationale**: Google STT is widely used and supports many languages.
- **Acceptance criteria**:
  - Google STT adapter implements AsrAdapter interface.
  - Supports streaming and batch modes.
  - Credentials stored in secfn.
- **Test vectors**: TV-ASR-004
- **Notes**: Requires Google Cloud credentials.

---

## Analytics

### ANA-001
- **Priority**: P1
- **Statement**: The system MUST compute talk time per participant from transcript segments.
- **Rationale**: Meeting analytics feature parity.
- **Acceptance criteria**:
  - GET /recordings/:recordingId/analytics returns talkTime object with participantId → milliseconds.
  - Sum of segment durations per speaker matches talkTime values.
- **Test vectors**: TV-ANA-001
- **Notes**: Requires transcript to be ready; returns 422 ANALYTICS_NOT_READY otherwise.

### ANA-002
- **Priority**: P1
- **Statement**: The system MUST compute silence percentage from transcript segments.
- **Rationale**: Useful metric for meeting quality analysis.
- **Acceptance criteria**:
  - silencePercentage = (totalDuration - sum of all segment durations) / totalDuration.
  - Value between 0.0 and 1.0.
- **Test vectors**: TV-ANA-002
- **Notes**: Overlapping segments (multiple speakers) count once toward total talk time for silence calculation.

### ANA-003
- **Priority**: P2
- **Statement**: The system SHOULD compute topic segmentation from transcript segments.
- **Rationale**: Useful for navigation and summarization. Does NOT require an LLM.
- **Acceptance criteria**:
  - topicSegments is an optional array in Analytics response.
  - Each TopicSegment has topic (keyword or phrase), startTime, endTime, keywords.
  - Topics detected via keyword frequency clustering (TF-IDF or similar).
- **Test vectors**: TV-ANA-003
- **Notes**: Simple keyword-based approach; no LLM required.

---

## Export formats

### EXP-001
- **Priority**: P0
- **Statement**: The system MUST support exporting transcripts in SRT, VTT, JSON, and plain text formats.
- **Rationale**: Multiple consumer needs (video players, editors, logs).
- **Acceptance criteria**:
  - format=srt produces valid SubRip with sequence numbers, timestamps (HH:MM:SS,mmm), speaker-prefixed text.
  - format=vtt produces valid WebVTT with `<v Speaker>` tags.
  - format=json produces Transcript entity JSON.
  - format=text produces `[Speaker] (HH:MM:SS): text` per line.
- **Test vectors**: TV-EXP-001, TV-EXP-002
- **Notes**: Speaker names from Participant entity where available, else speakerId.

### EXP-002
- **Priority**: P1
- **Statement**: The system SHOULD support PII redaction in exported transcripts (names, emails replaced with placeholders).
- **Rationale**: Privacy/compliance support.
- **Acceptance criteria**:
  - When redact=true query param is set on transcript export, participant names and emails are replaced with "[REDACTED]".
  - Stored transcript is unmodified.
- **Test vectors**: TV-EXP-003
- **Notes**: Same as TRX-008.

---

## Desktop capture SDK

### DSK-001
- **Priority**: P2
- **Statement**: The system MUST provide a desktop capture SDK that records system audio + screen without a visible bot joining the meeting.
- **Rationale**: Alternative to bot-based recording for scenarios where bot presence is undesirable.
- **Acceptance criteria**:
  - SDK captures system audio and screen on macOS and Linux.
  - Produces recording file compatible with recfn server (can be uploaded and transcribed).
  - No visible bot appears in the meeting.
- **Test vectors**: TV-DSK-001
- **Notes**: Implemented via Electron or Tauri. Windows support is Undefined.

### DSK-002
- **Priority**: P2
- **Statement**: The desktop SDK MUST upload captured recordings to recfn server for processing.
- **Rationale**: Integration with the server pipeline for transcription and storage.
- **Acceptance criteria**:
  - SDK calls server API to upload recording.
  - Server creates Recording entity and processes as if from a bot.
- **Test vectors**: TV-DSK-002
- **Notes**: Requires server to accept direct recording uploads (POST /recordings/upload endpoint).

### DSK-003
- **Priority**: P2
- **Statement**: The desktop SDK MUST support local transcription via Whisper without server dependency.
- **Rationale**: Fully offline workflow for privacy-sensitive use cases.
- **Acceptance criteria**:
  - SDK can invoke Whisper ASR adapter locally.
  - Produces transcript in JSON format.
  - No network required.
- **Test vectors**: TV-DSK-003
- **Notes**: Uses same ASR adapter interface as server.

---

## CLI

### CLI-001
- **Priority**: P1
- **Statement**: The system MUST provide a CLI tool (`recfn`) for bot management, recording access, transcript retrieval, analytics, and calendar management.
- **Rationale**: Developer ergonomics; standard for superfunctions.
- **Acceptance criteria**:
  - recfn bot create, bot status, bot leave, bot list commands work.
  - recfn recording list, recording download commands work.
  - recfn transcript get, transcript search commands work.
  - recfn analytics command works.
  - recfn calendar add, calendar list commands work.
- **Test vectors**: TV-CLI-001
- **Notes**: Calls server REST API. Configured via env vars or config file.

### CLI-002
- **Priority**: P1
- **Statement**: CLI output MUST support both human-readable and machine-readable (JSON) formats via --format flag.
- **Rationale**: Developer and automation needs.
- **Acceptance criteria**:
  - --format json outputs raw API response JSON.
  - Default output is human-readable formatted text.
- **Test vectors**: TV-CLI-002
- **Notes**: Exit 0 on success, non-zero on error.

### CLI-003
- **Priority**: P1
- **Statement**: CLI MUST NOT output API keys, secrets, or PII in its output.
- **Rationale**: Security requirement.
- **Acceptance criteria**:
  - API key used for auth never appears in stdout/stderr.
  - Participant emails not shown unless --show-email flag is used.
- **Test vectors**: TV-CLI-003
- **Notes**: API key read from RECFN_API_KEY env var or config file.

### CLI-004
- **Priority**: P1
- **Statement**: CLI MUST be published as a standalone npm package and installable globally.
- **Rationale**: Distribution requirement.
- **Acceptance criteria**:
  - npm install -g recfn-cli installs the CLI.
  - recfn command is available after install.
- **Test vectors**: N/A (packaging)
- **Notes**: Package name TBD; may be scoped.

---

## Client SDKs

### SDK-001
- **Priority**: P0
- **Statement**: The system MUST provide a TypeScript client SDK that wraps all REST API and WebSocket endpoints.
- **Rationale**: Primary consumption interface for TypeScript/JS developers.
- **Acceptance criteria**:
  - RecFn class with namespaced methods: bots, recordings, transcripts, participants, chat, analytics, calendars, webhooks.
  - All methods return typed responses matching API envelope.
  - WebSocket streaming via transcripts.stream(botId) method.
- **Test vectors**: TV-SDK-001
- **Notes**: Published as `recfn` npm package.

### SDK-002
- **Priority**: P1
- **Statement**: The system MUST provide a Python client SDK with feature parity to the TypeScript SDK.
- **Rationale**: Python SDK explicitly required in intent.
- **Acceptance criteria**:
  - RecFn class with namespaced methods matching TypeScript SDK.
  - Async WebSocket streaming via async iterator.
  - Published to PyPI as `recfn`.
- **Test vectors**: TV-SDK-002
- **Notes**: Uses httpx or requests for HTTP, websockets for WS.

### SDK-003
- **Priority**: P0
- **Statement**: Client SDKs MUST handle API errors by returning typed error objects, not throwing exceptions for expected errors.
- **Rationale**: Consistent with superfunctions envelope pattern.
- **Acceptance criteria**:
  - SDK methods return `{ ok: true, data }` or `{ ok: false, error }` matching envelope.
  - Network errors (unreachable server) MAY throw/raise exceptions.
- **Test vectors**: TV-SDK-003
- **Notes**: TypeScript: return type is `Result<T>`. Python: similar pattern.

---

## Security

### SEC-001
- **Priority**: P0
- **Statement**: All API requests MUST be authenticated via API key (Bearer token) validated by secfn.
- **Rationale**: Security hard constraint.
- **Acceptance criteria**:
  - Missing Authorization header → 401 UNAUTHORIZED.
  - Invalid API key → 401 UNAUTHORIZED.
  - Valid API key → request proceeds with namespace context.
- **Test vectors**: TV-SEC-001
- **Notes**: Same auth pattern as authfn/datafn.

### SEC-002
- **Priority**: P0
- **Statement**: All entities MUST be scoped to a namespace; cross-namespace access MUST be impossible.
- **Rationale**: Multi-tenant isolation.
- **Acceptance criteria**:
  - Entities from namespace A are not visible to requests authenticated as namespace B.
  - Cross-namespace access attempts return 404, not 403.
- **Test vectors**: TV-SEC-002
- **Notes**: Namespace derived from API key.

### SEC-003
- **Priority**: P0
- **Statement**: Recordings MUST be encrypted at rest.
- **Rationale**: Security hard constraint for sensitive meeting data.
- **Acceptance criteria**:
  - Storage adapter is configured with encryption.
  - filefn/storage adapter handles encryption transparently.
- **Test vectors**: TV-SEC-003
- **Notes**: Delegated to storage adapter.

### SEC-004
- **Priority**: P0
- **Statement**: API keys, OAuth tokens, and ASR API keys MUST be stored in secfn and MUST NOT appear in logs, API responses, or webhook payloads.
- **Rationale**: Secret leakage prevention.
- **Acceptance criteria**:
  - Log output does not contain any secret values.
  - API responses do not include tokens in any field.
  - Webhook payloads do not contain secrets.
- **Test vectors**: TV-SEC-004
- **Notes**: Applies to all observability outputs.

### SEC-005
- **Priority**: P0
- **Statement**: Webhook payloads MUST be signed with HMAC-SHA256 when a secret is configured.
- **Rationale**: Webhook authenticity verification.
- **Acceptance criteria**:
  - X-RecFn-Signature header present and valid when secret is set.
  - Absent when no secret.
- **Test vectors**: TV-WH-004
- **Notes**: Same as WH-003.

### SEC-006
- **Priority**: P0
- **Statement**: The bot MUST announce its presence and purpose (consent message) before recording begins.
- **Rationale**: Consent mechanism is a hard constraint.
- **Acceptance criteria**:
  - Bot sends configurable consent message after joining.
  - Recording does not start until consent message is sent.
  - Consent message delivery is logged.
- **Test vectors**: TV-BOT-010
- **Notes**: Same as BOT-008.

---

## Ecosystem integrations

### INT-001
- **Priority**: P0
- **Statement**: The system MUST use flowfn for job queues (bot lifecycle management, transcription pipeline, recording upload).
- **Rationale**: Ecosystem consistency; reliable async processing.
- **Acceptance criteria**:
  - Bot join, recording upload, transcription are enqueued as flowfn jobs.
  - Job failures are retried per flowfn policy.
- **Test vectors**: TV-INT-001
- **Notes**: flowfn adapters (memory for dev, Redis for prod).

### INT-002
- **Priority**: P0
- **Statement**: The system MUST use filefn/storage for recording storage.
- **Rationale**: Ecosystem consistency; pluggable storage backends.
- **Acceptance criteria**:
  - Recordings stored via filefn storage adapter.
  - Signed download URLs generated via filefn.
- **Test vectors**: TV-INT-002
- **Notes**: @superfunctions/storage adapters (local, S3, GCS).

### INT-003
- **Priority**: P1
- **Statement**: The system MUST use searchfn for transcript full-text indexing and search.
- **Rationale**: Transcript search feature.
- **Acceptance criteria**:
  - On transcript completion, segments are indexed in searchfn.
  - GET /transcripts/search queries searchfn.
- **Test vectors**: TV-SRCH-001
- **Notes**: Index updated within 60s of transcript completion.

### INT-004
- **Priority**: P0
- **Statement**: The system MUST use plugfn for webhook event delivery.
- **Rationale**: Reliable event delivery with retry.
- **Acceptance criteria**:
  - Webhook events sent via plugfn webhook delivery mechanism.
  - Retry policy handled by plugfn.
- **Test vectors**: TV-INT-003
- **Notes**: plugfn handles signing, retry, delivery confirmation.

### INT-005
- **Priority**: P0
- **Statement**: The system MUST use secfn for API key validation, OAuth token storage, and ASR API key storage.
- **Rationale**: Centralized secret management.
- **Acceptance criteria**:
  - API keys validated via secfn.
  - OAuth and ASR tokens stored in secfn vault.
- **Test vectors**: TV-INT-004
- **Notes**: Same pattern as authfn.

### INT-006
- **Priority**: P0
- **Statement**: The system MUST use logfn for structured logging of bot lifecycle, API events, and errors.
- **Rationale**: Observability requirement.
- **Acceptance criteria**:
  - Key lifecycle events logged via logfn.
  - Logs include structured context (botId, recordingId, etc.) but no secrets.
- **Test vectors**: TV-INT-005
- **Notes**: Similar to datafn/cifn logging.

---

## Limits

### LIMIT-001
- **Priority**: P0
- **Statement**: The system MUST enforce configurable limits: max concurrent bots (100), max recording duration (8h), max transcript segments (100,000), max WebSocket connections per bot (50), max webhooks per namespace (20), max calendars per namespace (10).
- **Rationale**: Resource protection and predictable behavior.
- **Acceptance criteria**:
  - Exceeding a limit returns appropriate error (e.g., 429 or 422).
  - Limits are configurable via server configuration.
- **Test vectors**: TV-LIMIT-001
- **Notes**: Defaults listed; all configurable.

### LIMIT-002
- **Priority**: P0
- **Statement**: API pagination limit MUST be max 100 per request.
- **Rationale**: API consistency.
- **Acceptance criteria**:
  - limit > 100 → BAD_REQUEST or capped to 100.
- **Test vectors**: TV-LIMIT-002
- **Notes**: Default 20.

### LIMIT-003
- **Priority**: P1
- **Statement**: API rate limiting SHOULD be enforced at 100 req/s per namespace.
- **Rationale**: Abuse prevention.
- **Acceptance criteria**:
  - Requests exceeding rate limit return 429 Too Many Requests.
  - Rate configurable.
- **Test vectors**: TV-LIMIT-003
- **Notes**: May use @superfunctions/middleware rate limiter.

---

## Observability

### OBS-001
- **Priority**: P0
- **Statement**: The system MUST log bot lifecycle events, API errors, recording events, and transcription events via logfn.
- **Rationale**: Operational visibility.
- **Acceptance criteria**:
  - Log entries for: bot created, status transitions, recording started/completed, transcript processing started/completed, webhook delivery, API errors.
  - Logs include structured fields (botId, recordingId, etc.).
  - No secrets in logs.
- **Test vectors**: TV-OBS-001
- **Notes**: Same as INT-006.

### OBS-002
- **Priority**: P1
- **Statement**: The system SHOULD emit metrics for: active bot count, recording count, ASR latency, webhook delivery rate, API request rate.
- **Rationale**: Monitoring and alerting.
- **Acceptance criteria**:
  - Metrics emitted to watchfn or similar.
  - No PII in metrics.
- **Test vectors**: TV-OBS-002
- **Notes**: Optional integration.

### OBS-003
- **Priority**: P0
- **Statement**: The system MUST log bot join latency (time from creation to joined status).
- **Rationale**: Performance monitoring for <10s target.
- **Acceptance criteria**:
  - Log entry includes creation timestamp and joined timestamp.
  - Metric emitted if watchfn available.
- **Test vectors**: TV-OBS-003
- **Notes**: Used to verify <10s performance constraint.

---

## Transcript search

### SRCH-001
- **Priority**: P1
- **Statement**: The system MUST index transcript segments in searchfn on transcript completion, within 60s.
- **Rationale**: Transcript search feature.
- **Acceptance criteria**:
  - After transcript status becomes "ready", segments are indexed in searchfn within 60s.
  - Index includes text, botId, recordingId, participantId, timestamps.
- **Test vectors**: TV-SRCH-001
- **Notes**: Uses searchfn indexing API.

### SRCH-002
- **Priority**: P1
- **Statement**: GET /transcripts/search MUST return matching segments with context (surrounding segments, recording reference, participant info).
- **Rationale**: Useful search results.
- **Acceptance criteria**:
  - Search results include matched segment, surrounding context, botId, recordingId.
  - Results ranked by relevance (searchfn scoring).
  - Pagination via limit + cursor.
- **Test vectors**: TV-SRCH-002
- **Notes**: Empty query → BAD_REQUEST.
