# RecFn Specification

## Metadata

- **timestamp**: 2026-02-28T14:00:00Z (UTC)
- **agent_name**: unknown-agent
- **model**: claude-opus-4-6
- **launcher**: VS Code
- **workspace path**: /Users/serro/Documents/dev/n/superfunctions (project: superfunctions/recfn)
- **project root**: /Users/serro/Documents/dev/n/superfunctions/recfn
- **OS**: darwin 25.3.0
- **shell**: zsh
- **repo**:
  - **git repo**: yes (parent superfunctions repo)
  - **branch**: next
  - **commit**: ea87d7e
  - **dirty**: yes
- **spec_folder**: 2026-02-28-new-r7k4m2x9-spec
- **spec_folder full path**: recfn/.conduct/specs/2026-02-28-new-r7k4m2x9-spec
- **spec_type**: new
- **spec_id**: r7k4m2x9
- **input paths**:
  - conversation context (user-provided intent, Recall.ai feature parity targets, architecture recommendations)
  - superfunctions/AGENTS.md
  - superfunctions/pop.md

---

## Overview

RecFn is a self-hosted meeting recording SDK in the superfunctions ecosystem. It sends bots into video conferencing meetings (Zoom, Google Meet, Microsoft Teams), captures audio/video/screen, produces transcripts with speaker diarization, tracks participants, captures chat messages, and exposes all data via a unified REST API and real-time WebSocket streams. It is similar to Recall.ai but fully self-hosted: all recordings, transcripts, and metadata stay on the user's infrastructure.

**One-sentence goal**: A self-hosted meeting recording SDK that captures audio/video from video conferencing platforms, produces transcripts with speaker diarization, and exposes recordings/transcripts/metadata via a unified API — similar to Recall.ai but self-hosted and composable with the superfunctions ecosystem.

**Target users**: Developers building meeting-aware applications (AI note-takers, coaching tools, compliance recording, CRM enrichment) who need self-hosted recording infrastructure.

**Target environments**: Server (Node.js 18+), Python 3.10+. Bot orchestration runs on Linux (VM or container). Client SDK runs in Node.js/browser. Desktop SDK (Electron/Tauri) for local capture. Offline transcription via local Whisper.

**Languages/packages**: TypeScript (server, SDK, CLI), Python (SDK). Reuse @superfunctions/http, @superfunctions/db, @superfunctions/storage adapters.

**Existing systems**: MUST integrate with flowfn (job queues for bot lifecycle, transcription pipelines), filefn (recording storage), searchfn (transcript indexing), memoryfn (AI agent memory), logfn (observability), secfn (API keys, secrets), plugfn (webhook delivery for events), sendfn (notifications).

**Data model**: Bot (id, meetingUrl, platform, status, config, createdAt, updatedAt); Recording (id, botId, format, duration, storageRef, size, createdAt); Transcript (id, recordingId, language, segments[]); Segment (speakerId, startTime, endTime, text, confidence); Participant (id, botId, name, email, role, joinedAt, leftAt); MeetingMetadata (id, botId, title, startTime, endTime, platform, chatMessages[]); ChatMessage (participantId, text, timestamp).

**Security model**: API key authentication (secfn), per-namespace isolation, recording encryption at rest (filefn/storage), consent tracking per participant, PII handling (redaction capability).

**Performance constraints**: Bot join latency <10s from API call; real-time transcript delivery <2s behind live audio; support 100+ concurrent bots per deployment; recording upload within 60s of meeting end.

**Non-goals**: SaaS offering (self-hosted only). Mobile SDK. Phone/PSTN recording. Video editing/compositing. Built-in AI summarization (consumers use memoryfn/their own LLM).

**Hard constraints**: All recordings MUST stay on user's infrastructure (self-hosted). ASR provider MUST be pluggable (adapter pattern). Platform integrations MUST be modular (add/remove platforms independently). MUST NOT require GPU for basic operation (GPU optional for local Whisper). Consent mechanism MUST be built into bot behavior. All API responses use superfunctions envelope pattern `{ ok, data/error }`.

---

## Glossary

- **Bot**: A headless process that joins a video conferencing meeting on behalf of the user. Each bot targets one meeting URL on one platform. Lifecycle: `creating` → `joining` → `joined` → `recording` → `leaving` → `left` → `done` | `error`.
- **Platform**: A video conferencing service: `zoom`, `meet`, `teams`. Each platform has a separate adapter module.
- **Platform Adapter**: A module implementing the `PlatformAdapter` interface for a specific platform. Handles join/leave/capture mechanics.
- **Recording**: A captured audio/video artifact from a bot's session. Stored via filefn/storage. Formats: MP4 (video), WAV/OPUS (audio), per-participant audio tracks (where platform allows).
- **Transcript**: The textual representation of a recording's audio. Composed of ordered Segments. Produced by an ASR adapter (real-time or batch).
- **Segment**: A single utterance within a transcript: speakerId, startTime (ms), endTime (ms), text, confidence (0–1).
- **ASR Adapter**: A module implementing the `AsrAdapter` interface. Converts audio to transcript segments. Pluggable: Whisper (local), Deepgram, AssemblyAI, Google Speech-to-Text.
- **Participant**: A person in the meeting as detected by the bot. Has name, email (if available), role (host/attendee/bot), join/leave timestamps.
- **MeetingMetadata**: Platform-reported meeting information: title, scheduled start/end, actual start/end, chat messages.
- **ChatMessage**: A text message sent in the meeting chat, captured by the bot. Has participantId, text, timestamp.
- **Consent**: An acknowledgment (or lack thereof) that a participant consents to recording. The bot MUST announce its presence and purpose. Consent status per participant: `granted`, `denied`, `pending`, `unknown`.
- **Namespace**: A logical tenant boundary. All entities (bots, recordings, transcripts) are scoped to a namespace. Namespace isolation is enforced by the server.
- **Webhook Event**: An event delivered to a user-configured URL via plugfn when something happens (bot.joined, recording.ready, etc.).
- **Real-time Transcript Stream**: A WebSocket connection delivering transcript segments as they are produced during a live meeting.
- **Desktop Capture**: Recording system audio + screen locally without a visible bot joining the meeting. Implemented via Electron or Tauri.
- **Calendar Integration**: Connecting a calendar (Google Calendar, Outlook) to automatically schedule bots for upcoming meetings.
- **Analytics**: Computed metrics from a transcript: talk time per participant, silence percentage, topic segments.
- **Envelope**: Canonical response shape for API: `{ ok: true, data: T }` | `{ ok: false, error: { code, message, details? } }`.

---

## Goals

1. **Meeting Bot API**: Send bots to join Zoom, Google Meet, Microsoft Teams meetings via URL.
2. **Bot lifecycle management**: Create, join, leave, status polling, automatic leave on empty room, error recovery.
3. **Real-time transcription**: Live transcript streaming via WebSocket with speaker diarization, <2s latency.
4. **Asynchronous transcription**: Post-meeting batch transcription with higher accuracy.
5. **Recording capture**: MP4 video, separate audio tracks per participant (where platform allows).
6. **Participant tracking**: Names, emails, join/leave times, roles.
7. **Chat message capture**: Read meeting chat messages.
8. **Calendar integration**: Connect calendars to auto-schedule bots for upcoming meetings.
9. **Webhook events**: bot.joining, bot.joined, bot.left, recording.ready, transcript.ready, participant.joined, participant.left.
10. **REST API**: Full CRUD for bots, recordings, transcripts, participants, calendars.
11. **Multiple ASR providers**: Whisper (local), Deepgram, AssemblyAI, Google Speech-to-Text via adapter pattern.
12. **Desktop Recording SDK**: Capture system audio + screen without visible bot (Electron/Tauri).
13. **Recording storage**: Configurable storage backends via filefn/storage adapters.
14. **Transcript search and indexing**: via searchfn integration.
15. **Meeting analytics**: Talk time per participant, silence detection, topic segmentation.
16. **Export formats**: SRT, VTT, JSON, plain text for transcripts.
17. **CLI**: recfn bot create, recfn bot status, recfn transcript get, etc.
18. **Python SDK**: Feature parity with TypeScript SDK.
19. **Consent mechanism**: Bot announces itself; consent tracked per participant.
20. **Self-hosted**: All data stays on user's infrastructure; no external data egress required.
21. **Ecosystem integration**: flowfn, filefn, searchfn, memoryfn, logfn, secfn, plugfn, sendfn.

## Non-goals

- SaaS offering (self-hosted only).
- Mobile SDK.
- Phone/PSTN recording.
- Video editing/compositing.
- Built-in AI summarization (consumers use memoryfn or their own LLM).

---

## Public API

### Server HTTP API

Base path: `/api/v1`. All responses MUST use the canonical envelope. Authentication: API key via `Authorization: Bearer <key>` header (validated via secfn). Namespace derived from API key.

#### Bots

**POST /bots**
- Body: `{ meetingUrl: string, platform?: "zoom" | "meet" | "teams", config?: BotConfig }`
- `platform` auto-detected from URL if omitted.
- `BotConfig`: `{ displayName?: string, joinTimeout?: number, autoLeaveOnEmpty?: boolean, autoLeaveEmptyTimeout?: number, consentMessage?: string, enableRealTimeTranscript?: boolean, asrProvider?: string, recordingFormat?: "mp4" | "audio_only", language?: string }`
- Response (201): `{ ok: true, data: Bot }`
- Errors: 400 BAD_REQUEST (invalid URL/body), 422 BOT_CREATE_FAILED.

**GET /bots**
- Query: `limit` (default 20, max 100), `cursor?`, `status?`, `platform?`
- Response (200): `{ ok: true, data: { bots: Bot[], nextCursor?: string } }`

**GET /bots/:botId**
- Response (200): `{ ok: true, data: Bot }` with participants, recordings, metadata.
- Errors: 404 BOT_NOT_FOUND.

**POST /bots/:botId/leave**
- Response (200): `{ ok: true, data: { botId, status: "leaving" } }`
- Errors: 404 BOT_NOT_FOUND, 409 BOT_ALREADY_LEFT.

**DELETE /bots/:botId**
- Deletes bot and associated data (recordings, transcripts). Irreversible.
- Response (200): `{ ok: true, data: { botId, deleted: true } }`
- Errors: 404 BOT_NOT_FOUND, 409 BOT_STILL_ACTIVE (must leave first).

#### Recordings

**GET /bots/:botId/recordings**
- Response (200): `{ ok: true, data: { recordings: Recording[] } }`

**GET /recordings/:recordingId**
- Response (200): `{ ok: true, data: Recording }` with `downloadUrl` (signed URL from filefn/storage).
- Errors: 404 RECORDING_NOT_FOUND.

**GET /recordings/:recordingId/download**
- Response: 302 redirect to signed storage URL, or streaming binary with Content-Type.
- Errors: 404 RECORDING_NOT_FOUND.

#### Transcripts

**GET /recordings/:recordingId/transcript**
- Query: `format?` ("json" | "srt" | "vtt" | "text", default "json")
- Response (200): `{ ok: true, data: Transcript }` (for JSON) or raw text (for srt/vtt/text with appropriate Content-Type).
- Errors: 404 TRANSCRIPT_NOT_FOUND.

**POST /recordings/:recordingId/transcribe**
- Triggers async transcription (or re-transcription) of a recording.
- Body: `{ asrProvider?: string, language?: string }`
- Response (202): `{ ok: true, data: { transcriptId, status: "processing" } }`
- Errors: 404 RECORDING_NOT_FOUND, 409 TRANSCRIPTION_IN_PROGRESS.

**GET /transcripts/search**
- Query: `q` (search text), `botId?`, `limit?`, `cursor?`
- Response (200): `{ ok: true, data: { results: TranscriptSearchResult[], nextCursor?: string } }`
- Uses searchfn for full-text search across indexed transcripts.

#### Participants

**GET /bots/:botId/participants**
- Response (200): `{ ok: true, data: { participants: Participant[] } }`

#### Chat Messages

**GET /bots/:botId/chat**
- Response (200): `{ ok: true, data: { messages: ChatMessage[] } }`

#### Meeting Metadata

**GET /bots/:botId/metadata**
- Response (200): `{ ok: true, data: MeetingMetadata }`

#### Analytics

**GET /recordings/:recordingId/analytics**
- Response (200): `{ ok: true, data: Analytics }`
- Analytics: `{ talkTime: { [participantId]: number }, silencePercentage: number, totalDuration: number, topicSegments?: TopicSegment[] }`
- Errors: 404 RECORDING_NOT_FOUND, 422 ANALYTICS_NOT_READY (transcript required).

#### Calendar Integration

**POST /calendars**
- Body: `{ provider: "google" | "outlook", accessToken: string, refreshToken?: string, autoSchedule?: boolean }`
- Response (201): `{ ok: true, data: Calendar }`
- Errors: 400 BAD_REQUEST, 401 CALENDAR_AUTH_FAILED.

**GET /calendars**
- Response (200): `{ ok: true, data: { calendars: Calendar[] } }`

**DELETE /calendars/:calendarId**
- Response (200): `{ ok: true, data: { calendarId, deleted: true } }`

**GET /calendars/:calendarId/events**
- Query: `from?` (ISO 8601), `to?` (ISO 8601)
- Response (200): `{ ok: true, data: { events: CalendarEvent[] } }`

#### Webhooks

**POST /webhooks**
- Body: `{ url: string, events: string[], secret?: string }`
- Response (201): `{ ok: true, data: Webhook }`

**GET /webhooks**
- Response (200): `{ ok: true, data: { webhooks: Webhook[] } }`

**DELETE /webhooks/:webhookId**
- Response (200): `{ ok: true, data: { webhookId, deleted: true } }`

### WebSocket API

**WS /ws/transcripts/:botId**
- Authentication: API key as query param `?token=<key>` or in first message.
- Server sends frames: `{ type: "segment", data: Segment }`, `{ type: "participant_joined", data: Participant }`, `{ type: "participant_left", data: { participantId } }`, `{ type: "status", data: { botStatus } }`, `{ type: "error", data: { code, message } }`.
- Client may send: `{ type: "ping" }` → server responds `{ type: "pong" }`.
- Connection closes when bot leaves or errors.

### CLI

- **recfn bot create <meetingUrl> [--platform zoom|meet|teams] [--name "Bot Name"] [--asr whisper|deepgram|assemblyai|google-stt]**
  Creates a bot and prints botId. Calls POST /bots.

- **recfn bot status <botId>**
  Shows bot status, participants, recording status. Calls GET /bots/:botId.

- **recfn bot leave <botId>**
  Sends leave command. Calls POST /bots/:botId/leave.

- **recfn bot list [--status joining|joined|recording|left|done|error] [--limit N]**
  Lists bots. Calls GET /bots.

- **recfn recording list <botId>**
  Lists recordings for a bot. Calls GET /bots/:botId/recordings.

- **recfn recording download <recordingId> [--output path]**
  Downloads recording to local file. Calls GET /recordings/:recordingId/download.

- **recfn transcript get <recordingId> [--format json|srt|vtt|text] [--output path]**
  Gets transcript. Calls GET /recordings/:recordingId/transcript.

- **recfn transcript search <query> [--bot-id botId] [--limit N]**
  Searches transcripts. Calls GET /transcripts/search.

- **recfn analytics <recordingId>**
  Shows analytics. Calls GET /recordings/:recordingId/analytics.

- **recfn calendar add <provider> --token <accessToken>**
  Adds calendar integration. Calls POST /calendars.

- **recfn calendar list**
  Lists calendar integrations. Calls GET /calendars.

### TypeScript Client SDK

```typescript
import { RecFn } from 'recfn';

const client = new RecFn({ baseUrl: 'http://localhost:3000', apiKey: 'sk-...' });

// Bots
const bot = await client.bots.create({ meetingUrl: 'https://zoom.us/j/123' });
const status = await client.bots.get(bot.data.id);
await client.bots.leave(bot.data.id);
const bots = await client.bots.list({ status: 'recording' });

// Recordings
const recordings = await client.recordings.list(botId);
const recording = await client.recordings.get(recordingId);
const downloadUrl = await client.recordings.downloadUrl(recordingId);

// Transcripts
const transcript = await client.transcripts.get(recordingId, { format: 'json' });
const srt = await client.transcripts.get(recordingId, { format: 'srt' });
await client.transcripts.transcribe(recordingId, { asrProvider: 'whisper' });
const results = await client.transcripts.search({ q: 'action items' });

// Real-time
const ws = client.transcripts.stream(botId);
ws.on('segment', (seg) => console.log(seg.text));
ws.on('participant_joined', (p) => console.log(p.name));

// Participants
const participants = await client.participants.list(botId);

// Chat
const chat = await client.chat.list(botId);

// Analytics
const analytics = await client.analytics.get(recordingId);

// Calendars
await client.calendars.create({ provider: 'google', accessToken: '...' });
const calendars = await client.calendars.list();

// Webhooks
await client.webhooks.create({ url: 'https://...', events: ['recording.ready'] });
```

### Python Client SDK

```python
from recfn import RecFn

client = RecFn(base_url="http://localhost:3000", api_key="sk-...")

# Bots
bot = client.bots.create(meeting_url="https://zoom.us/j/123")
status = client.bots.get(bot.data.id)
client.bots.leave(bot.data.id)
bots = client.bots.list(status="recording")

# Recordings
recordings = client.recordings.list(bot_id)
recording = client.recordings.get(recording_id)

# Transcripts
transcript = client.transcripts.get(recording_id, format="json")
srt = client.transcripts.get(recording_id, format="srt")
client.transcripts.transcribe(recording_id, asr_provider="whisper")
results = client.transcripts.search(q="action items")

# Real-time (async)
async for segment in client.transcripts.stream(bot_id):
    print(segment.text)

# Participants
participants = client.participants.list(bot_id)

# Chat
messages = client.chat.list(bot_id)

# Analytics
analytics = client.analytics.get(recording_id)

# Calendars
client.calendars.create(provider="google", access_token="...")

# Webhooks
client.webhooks.create(url="https://...", events=["recording.ready"])
```

---

## Data formats / protocol

### Entity shapes

```typescript
interface Bot {
  id: string;
  namespace: string;
  meetingUrl: string;
  platform: "zoom" | "meet" | "teams";
  status: "creating" | "joining" | "joined" | "recording" | "leaving" | "left" | "done" | "error";
  config: BotConfig;
  errorMessage?: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

interface BotConfig {
  displayName?: string;           // Bot's display name in meeting, default "RecFn Bot"
  joinTimeout?: number;           // ms, default 30000
  autoLeaveOnEmpty?: boolean;     // default true
  autoLeaveEmptyTimeout?: number; // ms after last non-bot participant leaves, default 30000
  consentMessage?: string;        // message announced on join, default "This meeting is being recorded"
  enableRealTimeTranscript?: boolean; // default false
  asrProvider?: string;           // adapter name, default "whisper"
  recordingFormat?: "mp4" | "audio_only"; // default "mp4"
  language?: string;              // BCP 47, default "en-US"
}

interface Recording {
  id: string;
  botId: string;
  format: "mp4" | "wav" | "opus" | "webm";
  duration: number;   // ms
  storageRef: string; // filefn storage reference
  size: number;       // bytes
  downloadUrl?: string; // signed URL, ephemeral
  createdAt: string;
}

interface Transcript {
  id: string;
  recordingId: string;
  language: string;
  status: "processing" | "ready" | "error";
  segments: Segment[];
  createdAt: string;
}

interface Segment {
  speakerId: string;
  startTime: number;  // ms from recording start
  endTime: number;    // ms
  text: string;
  confidence: number; // 0.0–1.0
}

interface Participant {
  id: string;
  botId: string;
  name: string;
  email?: string;
  role: "host" | "attendee" | "bot";
  joinedAt: string;
  leftAt?: string;
  consent: "granted" | "denied" | "pending" | "unknown";
}

interface MeetingMetadata {
  id: string;
  botId: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  platform: "zoom" | "meet" | "teams";
  chatMessages: ChatMessage[];
}

interface ChatMessage {
  participantId: string;
  text: string;
  timestamp: string;
}

interface Analytics {
  recordingId: string;
  totalDuration: number;       // ms
  talkTime: Record<string, number>; // participantId → ms
  silencePercentage: number;   // 0.0–1.0
  topicSegments?: TopicSegment[];
}

interface TopicSegment {
  topic: string;
  startTime: number;
  endTime: number;
  keywords: string[];
}

interface Calendar {
  id: string;
  provider: "google" | "outlook";
  autoSchedule: boolean;
  createdAt: string;
}

interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  startTime: string;
  endTime: string;
  meetingUrl?: string;
  botId?: string; // if bot auto-scheduled
}

interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret?: string; // HMAC signing secret
  createdAt: string;
}
```

### Response envelope (canonical)

```json
{ "ok": true, "data": "<T>" }
```
or
```json
{ "ok": false, "error": { "code": "<RECFN_CODE>", "message": "<human string>", "details": {} } }
```

HTTP status: 200/201/202 for ok:true; 4xx/5xx for ok:false. Body MUST always be JSON (except transcript download in non-JSON format and recording binary download).

### Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| BAD_REQUEST | 400 | Malformed body, invalid URL, missing required field |
| UNAUTHORIZED | 401 | Missing or invalid API key |
| BOT_NOT_FOUND | 404 | botId does not exist in namespace |
| RECORDING_NOT_FOUND | 404 | recordingId does not exist |
| TRANSCRIPT_NOT_FOUND | 404 | No transcript for this recording |
| WEBHOOK_NOT_FOUND | 404 | webhookId does not exist |
| CALENDAR_NOT_FOUND | 404 | calendarId does not exist |
| BOT_ALREADY_LEFT | 409 | Leave called but bot already left/done |
| BOT_STILL_ACTIVE | 409 | Delete called but bot hasn't left yet |
| TRANSCRIPTION_IN_PROGRESS | 409 | Transcription already running for this recording |
| BOT_CREATE_FAILED | 422 | Bot creation failed (invalid meeting URL, platform error) |
| ANALYTICS_NOT_READY | 422 | Analytics requested but transcript not ready |
| CALENDAR_AUTH_FAILED | 401 | Calendar OAuth token invalid or expired |
| PLATFORM_ERROR | 502 | Platform-specific error (Zoom/Meet/Teams API failure) |
| ASR_ERROR | 502 | ASR adapter returned an error |
| INTERNAL_ERROR | 500 | Unspecified server error |

### Bot status transitions

```
creating → joining → joined → recording → leaving → left → done
     ↓         ↓        ↓         ↓          ↓
   error     error    error     error      error
```

- `creating`: Bot object created, platform adapter initializing.
- `joining`: Bot attempting to join the meeting.
- `joined`: Bot is in the meeting but not yet recording (consent announcement phase).
- `recording`: Bot is actively capturing audio/video.
- `leaving`: Bot is leaving the meeting (cleanup in progress).
- `left`: Bot has left the meeting; recording upload in progress.
- `done`: All processing complete (recording uploaded, transcript ready if requested).
- `error`: Any unrecoverable error; `errorMessage` field populated.

### Webhook event payloads

All webhook payloads are POST requests with JSON body and HMAC-SHA256 signature in `X-RecFn-Signature` header (if secret configured).

```json
{
  "event": "bot.joined",
  "timestamp": "2026-02-28T14:30:00Z",
  "data": { "botId": "bot_abc123", "meetingUrl": "https://zoom.us/j/123", "platform": "zoom" }
}
```

Events:
- `bot.joining` — bot is attempting to join
- `bot.joined` — bot has joined the meeting
- `bot.left` — bot has left the meeting
- `bot.error` — bot encountered an error
- `recording.ready` — recording uploaded and available
- `transcript.ready` — transcript processing complete
- `participant.joined` — a participant joined the meeting
- `participant.left` — a participant left the meeting

### Transcript export formats

- **JSON**: Full Transcript object as defined above.
- **SRT**: SubRip subtitle format with sequence numbers, timestamps (HH:MM:SS,mmm), speaker labels prefixed to text.
- **VTT**: WebVTT format with timestamps, speaker labels as `<v Speaker Name>` tags.
- **Text**: Plain text with `[Speaker Name] (HH:MM:SS): text` per line.

---

## Semantics

### Bot lifecycle

1. Client calls POST /bots with meetingUrl.
2. Server validates URL, detects platform (or uses explicit platform), creates Bot record with status `creating`.
3. Server enqueues bot-join job to flowfn.
4. Bot worker picks up job: initializes platform adapter, transitions to `joining`.
5. Platform adapter joins meeting. On success: `joined`. On timeout/failure: `error`.
6. Bot announces consent message (configurable). Transitions to `recording`.
7. Bot captures audio/video via platform adapter. If `enableRealTimeTranscript`, audio is streamed to ASR adapter and segments are pushed via WebSocket.
8. When meeting ends, host kicks bot, or client calls POST /bots/:botId/leave: bot transitions to `leaving`.
9. `autoLeaveOnEmpty`: if all non-bot participants leave, bot waits `autoLeaveEmptyTimeout` ms, then auto-leaves.
10. Bot leaves meeting, uploads recording to filefn/storage, transitions to `left`.
11. If batch transcription configured, server enqueues transcription job to flowfn. On completion: transcript stored, `done`.
12. Webhook events fired at each transition via plugfn.

### Transcription pipeline

- **Real-time**: Audio stream → ASR adapter (streaming mode) → segments pushed to WebSocket clients. Segments are buffered and stored as interim transcript. Latency target: <2s behind live audio.
- **Batch (async)**: Recording file → ASR adapter (batch mode) → complete transcript with higher accuracy. Triggered automatically post-meeting or via POST /recordings/:recordingId/transcribe.
- ASR adapter interface:
  ```typescript
  interface AsrAdapter {
    readonly name: string;
    transcribeStream(audio: ReadableStream, opts: AsrOpts): AsyncIterable<Segment>;
    transcribeBatch(audioRef: string, opts: AsrOpts): Promise<Segment[]>;
    supportedLanguages(): string[];
  }
  interface AsrOpts {
    language: string;
    speakerDiarization: boolean;
    maxSpeakers?: number;
  }
  ```

### Platform adapter interface

```typescript
interface PlatformAdapter {
  readonly platform: "zoom" | "meet" | "teams";
  join(meetingUrl: string, config: BotConfig): Promise<void>;
  leave(): Promise<void>;
  getAudioStream(): ReadableStream<AudioChunk>;
  getVideoStream?(): ReadableStream<VideoChunk>;
  getParticipants(): Promise<Participant[]>;
  onParticipantJoin(cb: (p: Participant) => void): void;
  onParticipantLeave(cb: (id: string) => void): void;
  getChatMessages(): Promise<ChatMessage[]>;
  onChatMessage(cb: (msg: ChatMessage) => void): void;
  sendChatMessage(text: string): Promise<void>;
  getMetadata(): Promise<MeetingMetadata>;
  isConnected(): boolean;
}
```

### Recording storage

- Recordings are uploaded to filefn/storage immediately after the bot leaves.
- Storage reference is an opaque string returned by filefn (e.g., S3 key, local path).
- Download URLs are signed, time-limited (default 1 hour), generated on demand via filefn.
- Encryption at rest: delegated to the storage adapter (filefn/storage-s3 supports server-side encryption).

### Calendar integration

- User connects a calendar via OAuth (Google Calendar API, Microsoft Graph API).
- Server polls or uses push notifications to discover upcoming meetings with video conference links.
- If `autoSchedule` is true, server automatically creates bots for discovered meetings at configured lead time (default 1 minute before start).
- Calendar events are stored locally; tokens stored via secfn.

### Transcript search

- On transcript completion, segments are indexed in searchfn with metadata (botId, recordingId, participantId, timestamp).
- Search API (`GET /transcripts/search`) queries searchfn and returns matching segments with context.

### Analytics computation

- Computed from transcript segments after transcription is complete.
- Talk time: sum of (endTime - startTime) per speakerId.
- Silence: total duration minus sum of all segment durations, divided by total duration.
- Topic segmentation: grouping consecutive segments by detected topic shifts (keyword clustering). MAY use a simple keyword-frequency approach; does NOT require an LLM.

### Paging

- All list endpoints use `limit` + `cursor` pagination.
- Default limit: 20. Max limit: 100.
- `nextCursor` is present when more results exist.
- Order: `createdAt` descending by default.

---

## Invariants

- A bot MUST NOT transition backward in its lifecycle (e.g., `recording` → `joined` is invalid).
- A bot MUST NOT transition from terminal states (`done`, `error`) to any other state.
- A recording MUST NOT be deleted while its bot is still active (status not in `left`, `done`, `error`).
- Namespace isolation: a request authenticated with namespace A MUST NOT see or modify entities in namespace B.
- Consent message MUST be sent before recording begins. If consent mechanism is enabled and a participant denies consent, the bot SHOULD still record but MUST mark that participant's consent as `denied` (legal handling is the consumer's responsibility; the SDK tracks consent status, not enforces legal policy).
- ASR adapter selection MUST be validated at bot creation time; unknown adapter name → BAD_REQUEST.
- Real-time transcript segments MUST be delivered in chronological order (by startTime) on the WebSocket.
- Webhook delivery MUST be at-least-once; failed deliveries MUST be retried (via plugfn retry policy).
- Recording upload to storage MUST complete before bot status transitions to `done`.
- Transcript search index MUST be updated within 60s of transcript completion.
- Bot ID, recording ID, transcript ID generation MUST produce globally unique values (UUIDv7 or similar).
- API key MUST NOT appear in logs, webhook payloads, or WebSocket frames.

### Determinism

- Bot status transitions MUST follow the defined state machine; same inputs (meetingUrl, config) produce the same sequence of transitions (modulo platform-specific timing).
- Transcript segment ordering MUST be deterministic: ordered by startTime, then by speakerId for ties.
- Analytics MUST be deterministic given the same transcript segments.
- IDs MAY be non-deterministic (UUID-based).

### Idempotency

- POST /bots is NOT idempotent (each call creates a new bot).
- POST /bots/:botId/leave is idempotent for a bot already in `leaving`/`left`/`done` state (returns current status, no error).
- POST /recordings/:recordingId/transcribe returns 409 if transcription already in progress (prevents duplicate work).
- Webhook delivery is at-least-once; consumers MUST handle duplicate events (event payloads include unique event ID).

---

## Security

- **Authn**: API key (Bearer token) validated via secfn. Every request MUST include a valid API key. WebSocket auth via query param or first-message token.
- **Authz**: Namespace-scoped. API key maps to a namespace. All queries are filtered by namespace. No cross-namespace access.
- **Secrets**: Calendar OAuth tokens stored in secfn vault, encrypted at rest. ASR API keys (for cloud providers) stored in secfn. MUST NOT appear in logs, API responses, or webhook payloads.
- **Recording encryption**: Recordings MUST be encrypted at rest via storage adapter. Encryption key management delegated to filefn/storage.
- **Consent**: Bot MUST announce recording via chat message or audio announcement (platform-dependent). Consent status tracked per participant. PII (participant emails) MUST NOT appear in logs.
- **Webhook signing**: Webhook payloads MUST be signed with HMAC-SHA256 using the webhook's secret. Signature in `X-RecFn-Signature` header. Consumer MUST verify signature.
- **Input validation**: Meeting URLs MUST be validated against known platform URL patterns before bot creation. Config values MUST be validated (e.g., timeout ranges, valid ASR provider names).
- **PII redaction**: Transcripts MAY contain PII. The system MUST provide a redaction API or configuration to mask participant names/emails in exported transcripts. Redaction is opt-in.

---

## Limits/caps

- Max concurrent bots per namespace: 100 (configurable).
- Bot join timeout: 60s max.
- Recording max duration: 8 hours (28,800,000 ms).
- Recording max file size: bounded by filefn/storage limits.
- Transcript max segments: 100,000 per recording.
- WebSocket max concurrent connections per bot: 50.
- Webhook max endpoints per namespace: 20.
- Calendar integrations per namespace: 10.
- API request rate: bounded by server middleware (suggested 100 req/s per namespace).
- Search query max length: 500 characters.
- Chat message max length: 4,096 characters.
- Paging limit max: 100 per request.

---

## Observability

- **MUST log** (to logfn): bot created, bot status transitions, recording started/completed, transcript processing started/completed, webhook delivery attempts, API errors (with code, no secrets), ASR adapter errors, calendar sync events.
- **MUST NOT log**: API keys, OAuth tokens, participant emails, recording content, transcript text (unless debug mode explicitly enabled by operator).
- **MAY emit** metrics (to watchfn or equivalent): active bot count, recording count, transcript processing time, ASR latency, webhook delivery success/failure rate, API request rate. Metrics MUST NOT include PII.
- **SHOULD log** bot join latency (time from creation to `joined` status).

---

## Compatibility / versioning

- API version in path: `/api/v1`. Breaking changes require new version path.
- Entity shapes: new optional fields are backward compatible. New required fields require API version bump.
- ASR adapter interface: versioned. New optional methods can be added; existing method signatures MUST NOT change without major version.
- Platform adapter interface: versioned. Same rules as ASR adapter.
- CLI: backward compatible with at least one previous minor version of server API.
- Python SDK: version-locked to TypeScript SDK releases (same version number, same API surface).

---

## Undefined / Explicitly user-deferred only

- **SaaS offering**: Not in scope; self-hosted only.
- **Mobile SDK**: Not in scope.
- **Phone/PSTN recording**: Not in scope.
- **Video editing/compositing**: Not in scope.
- **Built-in AI summarization**: Not in scope; consumers use memoryfn or their own LLM.
