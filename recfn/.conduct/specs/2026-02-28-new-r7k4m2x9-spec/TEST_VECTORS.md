# RecFn Test Vectors

Golden inputs/outputs and negative variants. All JSON is canonical.

---

## Bot (BOT)

### TV-BOT-001 Positive: Create bot with valid Zoom URL
- **Description**: POST /bots with a valid Zoom meeting URL creates a bot with status "creating".
- **Input**:
```json
POST /api/v1/bots
Authorization: Bearer sk-valid-key
Content-Type: application/json

{
  "meetingUrl": "https://zoom.us/j/1234567890?pwd=abc123"
}
```
- **Expected output**:
```json
HTTP 201
{
  "ok": true,
  "data": {
    "id": "<uuid>",
    "namespace": "ns_test",
    "meetingUrl": "https://zoom.us/j/1234567890?pwd=abc123",
    "platform": "zoom",
    "status": "creating",
    "config": {
      "displayName": "RecFn Bot",
      "joinTimeout": 30000,
      "autoLeaveOnEmpty": true,
      "autoLeaveEmptyTimeout": 30000,
      "consentMessage": "This meeting is being recorded",
      "enableRealTimeTranscript": false,
      "asrProvider": "whisper",
      "recordingFormat": "mp4",
      "language": "en-US"
    },
    "createdAt": "<ISO 8601>",
    "updatedAt": "<ISO 8601>"
  }
}
```
- **Negative**: TV-BOT-002

### TV-BOT-002 Negative: Create bot with invalid URL
- **Description**: POST /bots with an unrecognized meeting URL fails.
- **Input**:
```json
POST /api/v1/bots
Authorization: Bearer sk-valid-key
Content-Type: application/json

{
  "meetingUrl": "https://example.com/not-a-meeting"
}
```
- **Expected output**:
```json
HTTP 422
{
  "ok": false,
  "error": {
    "code": "BOT_CREATE_FAILED",
    "message": "Unrecognized meeting URL. Supported platforms: zoom, meet, teams.",
    "details": {}
  }
}
```

### TV-BOT-003 Positive: Bot lifecycle state machine
- **Description**: Bot transitions through the full lifecycle.
- **Input**: Create bot → (internal) adapter joins → consent sent → recording starts → leave called → recording uploaded → done.
- **Expected output**: Status transitions: creating → joining → joined → recording → leaving → left → done. Each transition logged. Terminal state is `done`.
- **Negative**: Transition from `done` to any state returns error; transition backward (e.g., `recording` → `joined`) is rejected.

### TV-BOT-004 Positive: Leave bot
- **Description**: POST /bots/:botId/leave for a bot in "recording" state.
- **Input**:
```json
POST /api/v1/bots/bot_abc123/leave
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 200
{
  "ok": true,
  "data": {
    "botId": "bot_abc123",
    "status": "leaving"
  }
}
```
- **Negative**: TV-BOT-005

### TV-BOT-005 Negative: Leave bot already left
- **Description**: POST /bots/:botId/leave for a bot in "done" state.
- **Input**:
```json
POST /api/v1/bots/bot_done123/leave
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 409
{
  "ok": false,
  "error": {
    "code": "BOT_ALREADY_LEFT",
    "message": "Bot has already left the meeting.",
    "details": {}
  }
}
```

### TV-BOT-006 Positive: Auto-leave on empty
- **Description**: When all non-bot participants leave and autoLeaveOnEmpty is true, bot auto-leaves after timeout.
- **Input**: Bot in "recording" state. Last non-bot participant leaves. autoLeaveEmptyTimeout = 5000ms.
- **Expected output**: After 5s, bot transitions to "leaving" → "left". bot.left webhook fired.
- **Negative**: When autoLeaveOnEmpty is false, bot stays in "recording" indefinitely until explicit leave.

### TV-BOT-007 Positive: Get bot with details
- **Description**: GET /bots/:botId returns full bot with participants and recordings.
- **Input**:
```json
GET /api/v1/bots/bot_abc123
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 200
{
  "ok": true,
  "data": {
    "id": "bot_abc123",
    "meetingUrl": "https://zoom.us/j/123",
    "platform": "zoom",
    "status": "done",
    "config": { "..." },
    "createdAt": "2026-02-28T14:00:00Z",
    "updatedAt": "2026-02-28T15:00:00Z"
  }
}
```
- **Negative**: GET /bots/nonexistent → 404 BOT_NOT_FOUND.

### TV-BOT-008 Positive: Delete bot
- **Description**: DELETE /bots/:botId for a bot in "done" state removes bot and data.
- **Input**:
```json
DELETE /api/v1/bots/bot_done123
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 200
{
  "ok": true,
  "data": {
    "botId": "bot_done123",
    "deleted": true
  }
}
```

### TV-BOT-009 Negative: Delete active bot
- **Description**: DELETE /bots/:botId for a bot in "recording" state fails.
- **Input**:
```json
DELETE /api/v1/bots/bot_active123
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 409
{
  "ok": false,
  "error": {
    "code": "BOT_STILL_ACTIVE",
    "message": "Cannot delete bot while it is active. Call leave first.",
    "details": {}
  }
}
```

### TV-BOT-010 Positive: Consent message sent before recording
- **Description**: Bot sends consent message after joining, before transitioning to "recording".
- **Input**: Bot joins meeting with consentMessage = "Recording in progress".
- **Expected output**: Chat message "Recording in progress" sent by bot. Bot transitions to "recording" only after consent message delivery. Log entry confirms consent message sent.
- **Negative**: If consent message delivery fails, bot SHOULD still proceed to recording (log warning) — consent message failure is non-fatal.

### TV-BOT-011 Negative: Bot join timeout
- **Description**: Bot cannot join meeting within joinTimeout.
- **Input**: Bot created with joinTimeout = 5000ms. Meeting URL is unreachable or requires auth the bot doesn't have.
- **Expected output**: After 5s, bot transitions to "error". errorMessage populated (e.g., "Join timeout exceeded"). bot.error webhook fired.

### TV-BOT-012 Positive: Bot with custom config
- **Description**: POST /bots with full BotConfig.
- **Input**:
```json
POST /api/v1/bots
Authorization: Bearer sk-valid-key
Content-Type: application/json

{
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "config": {
    "displayName": "My Recorder",
    "joinTimeout": 15000,
    "autoLeaveOnEmpty": false,
    "consentMessage": "This session is being recorded for compliance.",
    "enableRealTimeTranscript": true,
    "asrProvider": "deepgram",
    "recordingFormat": "audio_only",
    "language": "es-ES"
  }
}
```
- **Expected output**:
```json
HTTP 201
{
  "ok": true,
  "data": {
    "id": "<uuid>",
    "platform": "meet",
    "status": "creating",
    "config": {
      "displayName": "My Recorder",
      "joinTimeout": 15000,
      "autoLeaveOnEmpty": false,
      "autoLeaveEmptyTimeout": 30000,
      "consentMessage": "This session is being recorded for compliance.",
      "enableRealTimeTranscript": true,
      "asrProvider": "deepgram",
      "recordingFormat": "audio_only",
      "language": "es-ES"
    },
    "..."
  }
}
```
- **Negative**: `"asrProvider": "nonexistent"` → 400 BAD_REQUEST with message "Unknown ASR provider: nonexistent".

---

## Recording (REC)

### TV-REC-001 Positive: Recording created after bot leaves
- **Description**: After bot transitions to "left", a recording is available.
- **Input**: GET /bots/:botId/recordings after bot status is "done".
- **Expected output**:
```json
HTTP 200
{
  "ok": true,
  "data": {
    "recordings": [
      {
        "id": "rec_xyz789",
        "botId": "bot_abc123",
        "format": "mp4",
        "duration": 1800000,
        "storageRef": "recordings/ns_test/rec_xyz789.mp4",
        "size": 52428800,
        "createdAt": "2026-02-28T15:00:00Z"
      }
    ]
  }
}
```

### TV-REC-002 Positive: Per-participant audio tracks (Zoom)
- **Description**: Zoom recording includes separate audio tracks.
- **Input**: GET /bots/:botId/recordings for a Zoom bot with 2 participants.
- **Expected output**: recordings array includes the main recording plus per-participant audio tracks (format "wav" or "opus", one per participant).
- **Negative**: For Google Meet bot, only single mixed recording is returned.

### TV-REC-003 Positive: Recording upload within 60s
- **Description**: Recording upload completes within 60s of bot leaving.
- **Input**: Bot leaves at T. Check recording at T+60s.
- **Expected output**: Recording entity has storageRef populated and downloadUrl available.
- **Negative**: If upload fails, recording status would indicate error (edge case).

### TV-REC-004 Positive: Download recording via signed URL
- **Description**: GET /recordings/:recordingId returns downloadUrl.
- **Input**:
```json
GET /api/v1/recordings/rec_xyz789
Authorization: Bearer sk-valid-key
```
- **Expected output**: Response includes `downloadUrl` field with a signed URL (expires in 1 hour). Fetching the URL returns the recording binary.
- **Negative**: GET /recordings/nonexistent → 404 RECORDING_NOT_FOUND.

### TV-REC-005 Positive: List recordings for bot
- **Input**:
```json
GET /api/v1/bots/bot_abc123/recordings
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 200
{
  "ok": true,
  "data": {
    "recordings": [ { "id": "rec_xyz789", "..." } ]
  }
}
```
- **Negative**: Bot with no recordings returns empty array.

---

## Transcript (TRX)

### TV-TRX-001 Positive: Real-time transcript segments via WebSocket
- **Description**: With enableRealTimeTranscript=true, segments arrive on WebSocket during meeting.
- **Input**: Connect WS /ws/transcripts/bot_abc123?token=sk-valid-key. Someone speaks "Hello everyone".
- **Expected output**: WebSocket frame within 2s:
```json
{
  "type": "segment",
  "data": {
    "speakerId": "participant_1",
    "startTime": 5000,
    "endTime": 6500,
    "text": "Hello everyone",
    "confidence": 0.95
  }
}
```

### TV-TRX-002 Positive: Batch transcription
- **Description**: POST /recordings/:recordingId/transcribe triggers batch transcription.
- **Input**:
```json
POST /api/v1/recordings/rec_xyz789/transcribe
Authorization: Bearer sk-valid-key
Content-Type: application/json

{
  "asrProvider": "whisper",
  "language": "en-US"
}
```
- **Expected output**:
```json
HTTP 202
{
  "ok": true,
  "data": {
    "transcriptId": "trx_abc456",
    "status": "processing"
  }
}
```
After processing completes, GET /recordings/rec_xyz789/transcript returns full transcript with segments. transcript.ready webhook fired.

### TV-TRX-003 Positive: Speaker diarization in transcript
- **Description**: Transcript segments have distinct speakerIds mapping to participants.
- **Input**: GET /recordings/rec_xyz789/transcript after transcription of a 2-speaker meeting.
- **Expected output**: Segments alternate between speakerId values (e.g., "participant_1", "participant_2"). Each speakerId maps to a Participant entity.
- **Negative**: When ASR cannot correlate speakers to participants, speakerIds are generated (e.g., "speaker_0", "speaker_1").

### TV-TRX-004 Negative: Duplicate transcription request
- **Description**: POST /recordings/:recordingId/transcribe while transcription is in progress.
- **Input**: Two sequential POST /recordings/rec_xyz789/transcribe calls.
- **Expected output**: First call → 202. Second call (while first is processing) → 409 TRANSCRIPTION_IN_PROGRESS.

### TV-TRX-005 Positive: Get transcript as JSON
- **Input**:
```json
GET /api/v1/recordings/rec_xyz789/transcript?format=json
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 200
{
  "ok": true,
  "data": {
    "id": "trx_abc456",
    "recordingId": "rec_xyz789",
    "language": "en-US",
    "status": "ready",
    "segments": [
      {
        "speakerId": "participant_1",
        "startTime": 5000,
        "endTime": 7000,
        "text": "Hello everyone, let's get started.",
        "confidence": 0.96
      },
      {
        "speakerId": "participant_2",
        "startTime": 7500,
        "endTime": 9000,
        "text": "Sounds good. I have the agenda here.",
        "confidence": 0.93
      }
    ],
    "createdAt": "2026-02-28T15:05:00Z"
  }
}
```

### TV-TRX-006 Positive: Segment ordering
- **Description**: Segments are ordered by startTime ascending, then speakerId for ties.
- **Input**: Transcript with overlapping speakers:
```json
[
  { "speakerId": "b", "startTime": 1000, "endTime": 2000, "text": "...", "confidence": 0.9 },
  { "speakerId": "a", "startTime": 1000, "endTime": 1500, "text": "...", "confidence": 0.9 },
  { "speakerId": "a", "startTime": 500, "endTime": 1000, "text": "...", "confidence": 0.9 }
]
```
- **Expected output**: Sorted order: startTime=500 (a), startTime=1000 (a), startTime=1000 (b).

### TV-TRX-007 Positive: Custom ASR provider per bot
- **Input**: Create bot with `asrProvider: "deepgram"`. Transcription uses Deepgram adapter.
- **Expected output**: Transcript produced by Deepgram adapter. Segments have Deepgram-quality confidence scores.
- **Negative**: `asrProvider: "invalid"` → 400 BAD_REQUEST at bot creation.

### TV-TRX-008 Positive: PII redaction in transcript export
- **Input**:
```json
GET /api/v1/recordings/rec_xyz789/transcript?format=text&redact=true
Authorization: Bearer sk-valid-key
```
- **Expected output**: Participant names replaced with "[REDACTED]". Emails replaced with "[REDACTED]". Content-Type: text/plain.
- **Negative**: Without redact=true, names and emails appear normally.

---

## Export (EXP)

### TV-EXP-001 Positive: SRT export format
- **Input**: GET /recordings/rec_xyz789/transcript?format=srt
- **Expected output**: Content-Type: text/plain. Body:
```
1
00:00:05,000 --> 00:00:07,000
[participant_1] Hello everyone, let's get started.

2
00:00:07,500 --> 00:00:09,000
[participant_2] Sounds good. I have the agenda here.
```

### TV-EXP-002 Positive: VTT export format
- **Input**: GET /recordings/rec_xyz789/transcript?format=vtt
- **Expected output**: Content-Type: text/vtt. Body:
```
WEBVTT

00:00:05.000 --> 00:00:07.000
<v participant_1>Hello everyone, let's get started.

00:00:07.500 --> 00:00:09.000
<v participant_2>Sounds good. I have the agenda here.
```

### TV-EXP-003 Positive: Redacted export
- **Input**: GET /recordings/rec_xyz789/transcript?format=text&redact=true (where participant_1 name is "John Smith")
- **Expected output**:
```
[[REDACTED]] (00:00:05): Hello everyone, let's get started.
[[REDACTED]] (00:00:07): Sounds good. I have the agenda here.
```

---

## Participant (PAR)

### TV-PAR-001 Positive: List participants
- **Input**:
```json
GET /api/v1/bots/bot_abc123/participants
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 200
{
  "ok": true,
  "data": {
    "participants": [
      {
        "id": "par_001",
        "botId": "bot_abc123",
        "name": "John Smith",
        "email": "john@example.com",
        "role": "host",
        "joinedAt": "2026-02-28T14:00:00Z",
        "leftAt": "2026-02-28T15:00:00Z",
        "consent": "granted"
      },
      {
        "id": "par_002",
        "botId": "bot_abc123",
        "name": "Jane Doe",
        "email": null,
        "role": "attendee",
        "joinedAt": "2026-02-28T14:01:00Z",
        "leftAt": "2026-02-28T14:50:00Z",
        "consent": "unknown"
      }
    ]
  }
}
```

### TV-PAR-002 Positive: Consent tracking
- **Description**: Participant consent status is tracked and returned.
- **Input**: Bot with consent mechanism. One participant interacts with consent → "granted". Another does not → "unknown".
- **Expected output**: Participants list shows consent: "granted" for the first, consent: "unknown" for the second.

### TV-PAR-003 Positive: Participant join/leave webhooks
- **Description**: Webhook events fired for participant join and leave.
- **Input**: Participant "Alice" joins meeting where bot is recording.
- **Expected output**: Webhook POST to configured URL:
```json
{
  "event": "participant.joined",
  "timestamp": "2026-02-28T14:05:00Z",
  "data": {
    "botId": "bot_abc123",
    "participant": {
      "id": "par_003",
      "name": "Alice",
      "role": "attendee",
      "joinedAt": "2026-02-28T14:05:00Z"
    }
  }
}
```

---

## Chat (CHAT)

### TV-CHAT-001 Positive: List chat messages
- **Input**:
```json
GET /api/v1/bots/bot_abc123/chat
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 200
{
  "ok": true,
  "data": {
    "messages": [
      {
        "participantId": "par_001",
        "text": "Can everyone see my screen?",
        "timestamp": "2026-02-28T14:10:00Z"
      }
    ]
  }
}
```

### TV-CHAT-002 Positive: Bot sends consent chat message
- **Description**: Bot sends consent message via chat when joining.
- **Input**: Bot joins with consentMessage = "This meeting is being recorded".
- **Expected output**: Chat message with bot's participantId and text "This meeting is being recorded" appears in chat messages list.

---

## Calendar (CAL)

### TV-CAL-001 Positive: Add calendar integration
- **Input**:
```json
POST /api/v1/calendars
Authorization: Bearer sk-valid-key
Content-Type: application/json

{
  "provider": "google",
  "accessToken": "ya29.valid-token",
  "refreshToken": "1//valid-refresh",
  "autoSchedule": true
}
```
- **Expected output**:
```json
HTTP 201
{
  "ok": true,
  "data": {
    "id": "cal_001",
    "provider": "google",
    "autoSchedule": true,
    "createdAt": "2026-02-28T14:00:00Z"
  }
}
```

### TV-CAL-002 Negative: Invalid calendar token
- **Input**: POST /calendars with invalid accessToken.
- **Expected output**: HTTP 401, error code CALENDAR_AUTH_FAILED.

### TV-CAL-003 Positive: List calendar events
- **Input**:
```json
GET /api/v1/calendars/cal_001/events?from=2026-03-01T00:00:00Z&to=2026-03-02T00:00:00Z
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 200
{
  "ok": true,
  "data": {
    "events": [
      {
        "id": "evt_001",
        "calendarId": "cal_001",
        "title": "Team Standup",
        "startTime": "2026-03-01T09:00:00Z",
        "endTime": "2026-03-01T09:30:00Z",
        "meetingUrl": "https://zoom.us/j/999",
        "botId": "bot_auto_001"
      }
    ]
  }
}
```

### TV-CAL-004 Positive: Auto-scheduled bot
- **Description**: Bot auto-created for upcoming calendar event.
- **Input**: Calendar with autoSchedule=true. Event with meetingUrl starts in 2 minutes.
- **Expected output**: Bot created automatically 1 minute before event start. CalendarEvent.botId populated. Bot joins meeting at scheduled time.

### TV-CAL-005 Negative: Calendar token refresh failure
- **Description**: Access token expired, refresh fails.
- **Input**: Calendar with expired access token and invalid refresh token.
- **Expected output**: Calendar sync fails. Log entry indicates auth failure. Webhook event (if configured) for calendar error.

---

## Webhook (WH)

### TV-WH-001 Positive: Create webhook
- **Input**:
```json
POST /api/v1/webhooks
Authorization: Bearer sk-valid-key
Content-Type: application/json

{
  "url": "https://my-app.com/hooks/recfn",
  "events": ["bot.joined", "recording.ready", "transcript.ready"],
  "secret": "whsec_myverysecretkey"
}
```
- **Expected output**:
```json
HTTP 201
{
  "ok": true,
  "data": {
    "id": "wh_001",
    "url": "https://my-app.com/hooks/recfn",
    "events": ["bot.joined", "recording.ready", "transcript.ready"],
    "createdAt": "2026-02-28T14:00:00Z"
  }
}
```
- **Negative**: Note: secret is NOT returned in response (stored securely).

### TV-WH-002 Positive: Webhook event delivery
- **Description**: bot.joined event delivered to configured webhook.
- **Input**: Bot joins meeting. Webhook configured for bot.joined.
- **Expected output**: POST to webhook URL with body:
```json
{
  "event": "bot.joined",
  "eventId": "evt_unique_id",
  "timestamp": "2026-02-28T14:05:00Z",
  "data": {
    "botId": "bot_abc123",
    "meetingUrl": "https://zoom.us/j/123",
    "platform": "zoom"
  }
}
```
With X-RecFn-Signature header (HMAC-SHA256 of body using webhook secret).

### TV-WH-003 Positive: All event types delivered
- **Description**: Each event type fires at the correct lifecycle point.
- **Input**: Full bot lifecycle with webhook subscribed to all events.
- **Expected output**: Events received in order: bot.joining, bot.joined, participant.joined (for each participant), recording.ready, transcript.ready, participant.left, bot.left.

### TV-WH-004 Positive: HMAC signature verification
- **Description**: Webhook payload is signed with HMAC-SHA256.
- **Input**: Webhook with secret "whsec_test". Payload body: `{"event":"bot.joined","timestamp":"2026-02-28T14:05:00Z","data":{"botId":"bot_abc123"}}`.
- **Expected output**: X-RecFn-Signature = HMAC-SHA256(secret, body). Consumer can verify by computing same HMAC and comparing.
- **Negative**: Webhook without secret has no X-RecFn-Signature header.

### TV-WH-005 Positive: Webhook retry on failure
- **Description**: Failed webhook delivery is retried.
- **Input**: Webhook endpoint returns 500 on first attempt.
- **Expected output**: Event is retried (per plugfn retry policy). Same eventId on retry (for consumer deduplication).

---

## API (API)

### TV-API-001 Positive: List bots with pagination
- **Input**:
```json
GET /api/v1/bots?limit=2
Authorization: Bearer sk-valid-key
```
- **Expected output** (3 bots exist):
```json
HTTP 200
{
  "ok": true,
  "data": {
    "bots": [ { "id": "bot_3", "..." }, { "id": "bot_2", "..." } ],
    "nextCursor": "cursor_token_123"
  }
}
```

### TV-API-002 Negative: Error response envelope
- **Input**: GET /api/v1/bots/nonexistent-id
- **Expected output**:
```json
HTTP 404
{
  "ok": false,
  "error": {
    "code": "BOT_NOT_FOUND",
    "message": "Bot not found.",
    "details": {}
  }
}
```

### TV-API-003 Negative: Unauthorized request
- **Input**: GET /api/v1/bots (no Authorization header)
- **Expected output**:
```json
HTTP 401
{
  "ok": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or invalid API key.",
    "details": {}
  }
}
```

### TV-API-004 Positive: Pagination defaults and limits
- **Input**: GET /api/v1/bots (no limit param).
- **Expected output**: Returns up to 20 bots (default limit).
- **Negative**: GET /api/v1/bots?limit=101 → 400 BAD_REQUEST or capped to 100.

### TV-API-005 Positive: Namespace isolation
- **Description**: API key for namespace A cannot see bots in namespace B.
- **Input**: Create bot with API key for ns_A. Try to GET that bot with API key for ns_B.
- **Expected output**: GET returns 404 BOT_NOT_FOUND (not 403).

---

## WebSocket (WS)

### TV-WS-001 Positive: WebSocket connection and streaming
- **Description**: Connect to WS /ws/transcripts/:botId and receive segments.
- **Input**: Connect WS /ws/transcripts/bot_abc123?token=sk-valid-key. Bot is recording with enableRealTimeTranscript=true.
- **Expected output**: Connection established. Server sends segment frames as ASR produces them. Connection closes when bot leaves.
- **Negative**: Invalid token → error frame and connection close. Invalid botId → error frame and close. Bot not in recording state → error frame.

### TV-WS-002 Positive: WebSocket frame types
- **Description**: Server sends typed frames.
- **Input**: Listen on WS during active meeting.
- **Expected output**: Frames with types: "segment", "participant_joined", "participant_left", "status". Client sends `{"type":"ping"}` → server responds `{"type":"pong"}`.

### TV-WS-003 Negative: Exceed max WebSocket connections
- **Description**: 51st connection to same botId is rejected.
- **Input**: 50 active WS connections to bot_abc123. 51st connection attempt.
- **Expected output**: 51st connection receives error frame `{"type":"error","data":{"code":"WS_LIMIT_EXCEEDED","message":"Maximum concurrent connections reached."}}` and is closed.

---

## ASR (ASR)

### TV-ASR-001 Positive: Whisper local transcription
- **Description**: Whisper adapter produces transcript from audio file.
- **Input**: WAV file with 2 speakers, 30 seconds, English.
- **Expected output**: Array of Segment objects with text, speakerId, startTime, endTime, confidence. No GPU required (CPU mode).
- **Negative**: Unsupported audio format → ASR_ERROR.

### TV-ASR-002 Positive: Deepgram cloud transcription
- **Description**: Deepgram adapter transcribes audio via API.
- **Input**: Audio stream or file, valid Deepgram API key in secfn.
- **Expected output**: Segments with diarization. Streaming mode delivers segments in real-time.
- **Negative**: Invalid API key → ASR_ERROR.

### TV-ASR-003 Positive: AssemblyAI cloud transcription
- **Description**: AssemblyAI adapter transcribes audio via API.
- **Input**: Audio file, valid AssemblyAI API key.
- **Expected output**: Segments with diarization. Batch mode with webhook or polling for completion.
- **Negative**: Invalid API key → ASR_ERROR.

### TV-ASR-004 Positive: Google STT transcription
- **Description**: Google Speech-to-Text adapter transcribes audio.
- **Input**: Audio stream or file, valid Google Cloud credentials.
- **Expected output**: Segments with diarization.
- **Negative**: Invalid credentials → ASR_ERROR.

---

## Analytics (ANA)

### TV-ANA-001 Positive: Talk time analytics
- **Input**: Recording with transcript: participant_1 spoke for 60s, participant_2 spoke for 30s. Total duration 120s.
- **Expected output**:
```json
{
  "ok": true,
  "data": {
    "recordingId": "rec_xyz789",
    "totalDuration": 120000,
    "talkTime": {
      "participant_1": 60000,
      "participant_2": 30000
    },
    "silencePercentage": 0.25
  }
}
```

### TV-ANA-002 Positive: Silence percentage
- **Input**: 120s recording, 90s total talk time.
- **Expected output**: silencePercentage = 0.25 (30s silence / 120s total).

### TV-ANA-003 Positive: Topic segmentation
- **Input**: Transcript with distinct topic shifts (budget discussion → timeline → next steps).
- **Expected output**: topicSegments array with 3 entries, each with topic label, startTime, endTime, keywords.
- **Negative**: Short transcripts (<30s) MAY return empty topicSegments.

---

## Security (SEC)

### TV-SEC-001 Positive: Valid API key grants access
- **Input**: GET /api/v1/bots with valid API key.
- **Expected output**: HTTP 200, list of bots for the key's namespace.

### TV-SEC-002 Positive: Namespace isolation enforced
- **Input**: API key for namespace A tries to access bot in namespace B.
- **Expected output**: 404 BOT_NOT_FOUND (not 403).

### TV-SEC-003 Positive: Recording encrypted at rest
- **Description**: Recordings stored via filefn are encrypted.
- **Input**: Upload recording to storage adapter with encryption enabled.
- **Expected output**: Stored file is encrypted. Readable only via signed URL or storage adapter decrypt.

### TV-SEC-004 Negative: No secrets in logs
- **Description**: Log output does not contain API keys, tokens, or PII emails.
- **Input**: Full bot lifecycle with logging enabled.
- **Expected output**: grep through all log entries for API key value, OAuth tokens — no matches found. Participant emails not in log entries.

---

## Integration (INT)

### TV-INT-001 Positive: flowfn job queue
- **Description**: Bot creation enqueues a job in flowfn.
- **Input**: POST /bots creates bot.
- **Expected output**: flowfn queue contains a bot-join job with botId. Job is picked up and processed.

### TV-INT-002 Positive: filefn recording storage
- **Description**: Recording uploaded via filefn storage adapter.
- **Input**: Bot completes recording.
- **Expected output**: filefn.upload called with recording bytes. storageRef stored in Recording entity.

### TV-INT-003 Positive: plugfn webhook delivery
- **Description**: Webhook events delivered via plugfn.
- **Input**: bot.joined event fires.
- **Expected output**: plugfn.send called with webhook URL, payload, and signing secret.

### TV-INT-004 Positive: secfn secret storage
- **Description**: API keys and OAuth tokens stored in secfn.
- **Input**: Calendar created with OAuth tokens.
- **Expected output**: Tokens stored in secfn vault, retrievable by server, not exposed in API responses.

### TV-INT-005 Positive: logfn structured logging
- **Description**: Bot lifecycle logged via logfn.
- **Input**: Bot transitions to "joined".
- **Expected output**: logfn.info called with structured data: { event: "bot.status_change", botId, from: "joining", to: "joined" }.

---

## Search (SRCH)

### TV-SRCH-001 Positive: Transcript indexed in searchfn
- **Description**: After transcript completion, segments are indexed.
- **Input**: Transcript becomes "ready".
- **Expected output**: searchfn.index called with segments. Search query matches indexed text.

### TV-SRCH-002 Positive: Transcript search returns results
- **Input**:
```json
GET /api/v1/transcripts/search?q=action+items&limit=5
Authorization: Bearer sk-valid-key
```
- **Expected output**:
```json
HTTP 200
{
  "ok": true,
  "data": {
    "results": [
      {
        "recordingId": "rec_xyz789",
        "botId": "bot_abc123",
        "segment": {
          "speakerId": "participant_1",
          "startTime": 45000,
          "endTime": 48000,
          "text": "Let me summarize the action items.",
          "confidence": 0.94
        },
        "context": [ "..." ]
      }
    ],
    "nextCursor": null
  }
}
```

---

## Limits (LIMIT)

### TV-LIMIT-001 Negative: Exceed max concurrent bots
- **Input**: 100 bots active. POST /bots for 101st.
- **Expected output**: 422 or 429 with error indicating max concurrent bots exceeded.

### TV-LIMIT-002 Negative: Pagination limit exceeded
- **Input**: GET /api/v1/bots?limit=200
- **Expected output**: 400 BAD_REQUEST or limit capped to 100.

### TV-LIMIT-003 Negative: Rate limit exceeded
- **Input**: 101 requests in 1 second from same namespace.
- **Expected output**: 429 Too Many Requests.

---

## Observability (OBS)

### TV-OBS-001 Positive: Bot lifecycle logging
- **Description**: Key lifecycle events are logged.
- **Input**: Full bot lifecycle.
- **Expected output**: Log entries for: bot created, joining, joined, recording, leaving, left, done. Each includes botId and timestamp.

### TV-OBS-002 Positive: Metrics emitted
- **Description**: Active bot count metric emitted.
- **Input**: 3 bots active.
- **Expected output**: Metric: { name: "recfn.bots.active", value: 3 }.

### TV-OBS-003 Positive: Bot join latency logged
- **Description**: Time from creation to joined is logged.
- **Input**: Bot created at T, joined at T+8s.
- **Expected output**: Log entry: { event: "bot.join_latency", botId, latencyMs: 8000 }.

---

## CLI (CLI)

### TV-CLI-001 Positive: CLI bot create
- **Description**: `recfn bot create` creates a bot.
- **Input**: `recfn bot create "https://zoom.us/j/123" --name "Test Bot"`
- **Expected output**: stdout: `Bot created: bot_abc123 (status: creating)`. Exit 0.
- **Negative**: Invalid URL → error message, exit 1.

### TV-CLI-002 Positive: CLI JSON output
- **Input**: `recfn bot list --format json`
- **Expected output**: Raw JSON API response to stdout. Exit 0.

### TV-CLI-003 Negative: CLI does not leak API key
- **Input**: `recfn bot list` with RECFN_API_KEY set.
- **Expected output**: stdout and stderr do not contain the API key value.

---

## SDK (SDK)

### TV-SDK-001 Positive: TypeScript SDK CRUD
- **Description**: TypeScript SDK wraps API correctly.
- **Input**:
```typescript
const client = new RecFn({ baseUrl: 'http://localhost:3000', apiKey: 'sk-test' });
const bot = await client.bots.create({ meetingUrl: 'https://zoom.us/j/123' });
```
- **Expected output**: `bot.ok === true`, `bot.data.id` is a string, `bot.data.status === 'creating'`.

### TV-SDK-002 Positive: Python SDK CRUD
- **Description**: Python SDK wraps API correctly.
- **Input**:
```python
client = RecFn(base_url="http://localhost:3000", api_key="sk-test")
bot = client.bots.create(meeting_url="https://zoom.us/j/123")
```
- **Expected output**: `bot.ok == True`, `bot.data.id` is a string, `bot.data.status == "creating"`.

### TV-SDK-003 Positive: SDK error handling
- **Description**: SDK returns error envelope, does not throw.
- **Input**: `client.bots.get("nonexistent")`.
- **Expected output**: `result.ok === false`, `result.error.code === 'BOT_NOT_FOUND'`. No exception thrown.

---

## Desktop (DSK)

### TV-DSK-001 Positive: Desktop capture produces recording
- **Description**: Desktop SDK captures system audio + screen.
- **Input**: Start desktop capture. Audio plays for 10s. Stop capture.
- **Expected output**: Recording file produced (MP4 or audio-only). Duration ~10s. File is valid media.

### TV-DSK-002 Positive: Desktop capture upload to server
- **Input**: Desktop SDK captures recording, uploads to server.
- **Expected output**: Server creates Recording entity. Transcription can be triggered.

### TV-DSK-003 Positive: Desktop local transcription
- **Input**: Desktop SDK captures audio. Transcribes locally with Whisper.
- **Expected output**: Transcript JSON produced locally. No network calls made during transcription.
