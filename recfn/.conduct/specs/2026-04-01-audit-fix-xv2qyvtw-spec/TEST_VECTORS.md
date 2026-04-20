# RecFn Audit-Fix Test Vectors

## TV-PROD-001

- **Description**: Supported platform combinations are admitted; unsupported platforms or unsupported capabilities fail deterministically.
- **Input**:
```json
POST /api/v1/bots
Authorization: Bearer sk_ns_a

{
  "meetingUrl": "https://zoom.us/j/1234567890",
  "config": {
    "enableRealTimeTranscript": false
  }
}
```
- **Expected output**:
```json
{
  "ok": true,
  "data": {
    "platform": "zoom",
    "status": "creating"
  }
}
```
- **Negative variant(s)**:
  - `POST /api/v1/bots` with `platform: "webex"` returns `UNSUPPORTED_PLATFORM`.
  - `POST /api/v1/bots` with `enableRealTimeTranscript: true` on a non-streaming capability pair returns `REALTIME_TRANSCRIPT_UNSUPPORTED`.

## TV-ARCH-001

- **Description**: Durable state survives process restart through the shared DB layer.
- **Input**:
```text
1. Start server with a sqlite-backed @superfunctions/db adapter.
2. Create a bot and persist related participant and metadata rows.
3. Restart the server process and fetch the bot aggregate.
```
- **Expected output**:
```text
The aggregate bot view still contains the bot, participants, recordings, metadata, and chat rows after restart.
```
- **Negative variant(s)**:
  - Starting production mode without a durable DB adapter fails fast with configuration error.

## TV-ARCH-002

- **Description**: Recording storage runs through the shared storage package.
- **Input**:
```text
1. Configure recfn-server with @superfunctions/storage-local.
2. Finalize a bot session into a recording.
3. Request GET /api/v1/recordings/:recordingId.
```
- **Expected output**:
```json
{
  "ok": true,
  "data": {
    "storageRef": "recordings/ns_a/rec_123.mp4",
    "downloadUrl": "https://..."
  }
}
```
- **Negative variant(s)**:
  - Missing or invalid storage configuration fails server boot rather than silently falling back to the bespoke local adapter.

## TV-ARCH-003

- **Description**: Meet and Teams share the browser-core lifecycle while preserving provider-specific selectors.
- **Input**:
```text
Inspect the meet and teams adapters plus the shared browser-core package.
```
- **Expected output**:
```text
Common session bootstrap, observer lifecycle, and capture orchestration live in browser-core; only provider-specific selectors and auth logic remain in platform packages.
```
- **Negative variant(s)**:
  - Introducing a new common behavior change requires touching browser-core, not duplicating edits separately in both platform adapters.

## TV-ARCH-004

- **Description**: Cloud ASR adapters consume shared transport/polling helpers.
- **Input**:
```text
Run provider adapter unit tests for Deepgram, AssemblyAI, and Google STT.
```
- **Expected output**:
```text
All three adapters pass while shared helper modules handle upload, timeout, and polling orchestration.
```
- **Negative variant(s)**:
  - A transport timeout raised by the shared helper propagates as a deterministic adapter error instead of provider-specific ad hoc behavior.

## TV-API-001

- **Description**: Aggregate bot detail returns related records in one namespace-scoped response.
- **Input**:
```json
GET /api/v1/bots/bot_123
Authorization: Bearer sk_ns_a
```
- **Expected output**:
```json
{
  "ok": true,
  "data": {
    "id": "bot_123",
    "participants": [],
    "recordings": [],
    "metadata": null,
    "chatMessages": []
  }
}
```
- **Negative variant(s)**:
  - `GET /api/v1/bots/bot_123` with a token from another namespace returns `BOT_NOT_FOUND` or equivalent namespace-safe denial.

## TV-API-002

- **Description**: List endpoints paginate consistently and raw success bodies still return JSON errors on failure.
- **Input**:
```json
GET /api/v1/webhooks?limit=2&cursor=wh_002
Authorization: Bearer sk_ns_a
```
- **Expected output**:
```json
{
  "ok": true,
  "data": {
    "items": [],
    "nextCursor": null
  }
}
```
- **Negative variant(s)**:
  - `GET /api/v1/webhooks?limit=9999` returns `BAD_REQUEST`.
  - `GET /api/v1/recordings/rec_missing/transcript?format=srt` returns a JSON error envelope with `TRANSCRIPT_NOT_FOUND`.

## TV-DATA-001

- **Description**: Chat and metadata are persisted and exposed through both dedicated and aggregate endpoints.
- **Input**:
```text
1. Bot joins a meeting.
2. Two chat messages arrive.
3. Platform metadata title and timestamps are captured.
4. Fetch /bots/:botId, /bots/:botId/chat, and /bots/:botId/metadata.
```
- **Expected output**:
```text
All three responses reflect the same persisted chat and metadata state.
```
- **Negative variant(s)**:
  - No endpoint returns placeholder empty metadata for an existing bot once metadata persistence is configured.

## TV-BOT-001

- **Description**: Leaving a bot session automatically finalizes and uploads a recording.
- **Input**:
```text
1. Create a bot.
2. Let it reach recording state.
3. Trigger leave.
4. Wait for finalization workflow.
```
- **Expected output**:
```text
The bot transitions through finalizing to done, a recording row exists, and recording.ready is emitted.
```
- **Negative variant(s)**:
  - Storage upload failure produces `RECORDING_FINALIZATION_FAILED` and an observable failure state instead of silently dropping the recording.

## TV-BOT-002

- **Description**: Related entities preserve the correct botId and namespace.
- **Input**:
```text
Run one bot in namespace A and one bot in namespace B on different meetings; capture participant and metadata events in both.
```
- **Expected output**:
```text
Each persisted participant, recording, metadata row, and chat message resolves back to the correct bot and namespace.
```
- **Negative variant(s)**:
  - No participant or metadata row contains an empty botId or crosses namespaces.

## TV-PLAT-001

- **Description**: Zoom supports the full end-to-end production path.
- **Input**:
```text
1. Start a Zoom bot session with recording enabled.
2. Let participants join and send chat.
3. Leave the meeting.
```
- **Expected output**:
```text
Recording, metadata, participant rows, and chat rows all persist; aggregate bot view reflects them.
```
- **Negative variant(s)**:
  - If Zoom media capture cannot start, the bot transitions to error with a deterministic platform capture failure code.

## TV-PLAT-002

- **Description**: Google Meet emits real audio frames on the production path.
- **Input**:
```text
Start a Meet bot session in an environment with the required capture prerequisites.
```
- **Expected output**:
```text
The capture stream yields non-empty audio chunks and can finalize into a recording.
```
- **Negative variant(s)**:
  - Running without the required capture prerequisites fails with `PLATFORM_CAPTURE_UNAVAILABLE` rather than returning zero-byte chunks.

## TV-PLAT-003

- **Description**: Microsoft Teams emits real audio frames on the production path.
- **Input**:
```text
Start a Teams bot session in an environment with the required capture prerequisites.
```
- **Expected output**:
```text
The capture stream yields non-empty audio chunks and can finalize into a recording.
```
- **Negative variant(s)**:
  - Running without the required capture prerequisites fails with `PLATFORM_CAPTURE_UNAVAILABLE` rather than returning zero-byte chunks.

## TV-TRX-001

- **Description**: Real-time transcription is allowed only for supported streaming pairs.
- **Input**:
```json
POST /api/v1/bots
Authorization: Bearer sk_ns_a

{
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "config": {
    "enableRealTimeTranscript": true,
    "asrProvider": "deepgram"
  }
}
```
- **Expected output**:
```json
{
  "ok": true,
  "data": {
    "status": "creating"
  }
}
```
- **Negative variant(s)**:
  - The same request with a non-streaming provider returns `REALTIME_TRANSCRIPT_UNSUPPORTED`.
  - A runtime that falls below the declared latency threshold disables the capability in the support matrix and rejects new requests.

## TV-TRX-002

- **Description**: Batch transcripts remain deterministically ordered and drive stable indexing.
- **Input**:
```text
Submit a recording whose ASR output contains same-start-time segments from two speakers.
```
- **Expected output**:
```text
Stored transcript segments are sorted by startTime, then speakerId, then stable tiebreaker; search and analytics use the same order.
```
- **Negative variant(s)**:
  - Re-indexing the same transcript does not scramble segment order or participant mapping.

## TV-WS-001

- **Description**: Cross-namespace WebSocket subscription is forbidden.
- **Input**:
```text
Open WS /ws/transcripts/bot_ns_b using a valid token from namespace A.
```
- **Expected output**:
```text
The connection is rejected with WS_NAMESPACE_FORBIDDEN or equivalent unauthorized close behavior.
```
- **Negative variant(s)**:
  - A valid token for the correct namespace is admitted and receives frames normally.

## TV-WS-002

- **Description**: Canonical WS schemas are shared across server and both SDKs.
- **Input**:
```json
{ "type": "status", "data": { "botStatus": "recording" } }
```
- **Expected output**:
```text
Server tests, TypeScript SDK tests, and Python SDK tests all deserialize the frame successfully.
```
- **Negative variant(s)**:
  - `{ "type": "status", "data": { "status": "recording" } }` is rejected by canonical schema validation and is not emitted by the server.

## TV-LIMIT-001

- **Description**: HTTP and WS limits are enforced from shared config.
- **Input**:
```text
Set maxWebSocketConnectionsPerBot=2 and open three WS connections for the same bot.
```
- **Expected output**:
```text
The first two connections succeed and the third is rejected by the configured limit.
```
- **Negative variant(s)**:
  - Changing the config value changes runtime behavior without requiring code edits.

## TV-SEC-001

- **Description**: Secrets resolve through secfn-backed references and never leak outward.
- **Input**:
```text
Configure an ASR provider and a calendar connection using secret references.
```
- **Expected output**:
```text
Requests succeed, logs contain only safe identifiers, and API/webhook outputs contain no raw secrets.
```
- **Negative variant(s)**:
  - An invalid secret reference returns SECRET_NOT_FOUND.

## TV-INT-001

- **Description**: Production recfn consumes shared Superfunctions packages rather than bespoke infrastructure seams.
- **Input**:
```text
Inspect recfn server dependencies and integration modules after implementation.
```
- **Expected output**:
```text
Shared DB, storage, queue, auth, and webhook packages back the production path; bespoke seams are removed or reduced to thin wrappers.
```
- **Negative variant(s)**:
  - A production build that still depends on the old bespoke storage contract fails the architectural conformance check.

## TV-SEARCH-001

- **Description**: Transcript search returns participant info and stable context.
- **Input**:
```json
GET /api/v1/transcripts/search?q=budget&limit=1
Authorization: Bearer sk_ns_a
```
- **Expected output**:
```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "participant": {
          "id": "par_123",
          "name": "Alex"
        },
        "context": [
          { "text": "previous segment" },
          { "text": "budget discussion" },
          { "text": "next segment" }
        ]
      }
    ]
  }
}
```
- **Negative variant(s)**:
  - A search query from another namespace never returns hits outside that namespace.

## TV-SDK-001

- **Description**: Python SDK reaches audited parity with the TypeScript SDK.
- **Input**:
```python
await recfn.recordings.upload(file_bytes, {"bot_id": "bot_123", "transcribe": True})
```
- **Expected output**:
```python
{"ok": True, "data": {...}}
```
- **Negative variant(s)**:
  - Python transcript stream parsing a legacy `status` payload without `botStatus` fails canonical schema validation in tests.

## TV-CLI-001

- **Description**: CLI transcript output is redacted by default.
- **Input**:
```text
recfn transcript get rec_123 --format text
```
- **Expected output**:
```text
Transcript content is redacted unless an explicit include-pii flag is present.
```
- **Negative variant(s)**:
  - Raw unredacted transcript output requires an explicit opt-in flag and is not emitted by default.

## TV-CAL-001

- **Description**: Calendar auto-scheduling and token refresh run as production services.
- **Input**:
```text
1. Connect a calendar with autoSchedule=true.
2. Advance scheduler clock into the lead window of an upcoming meeting.
3. Simulate token expiry before the poll.
```
- **Expected output**:
```text
The service refreshes the token, discovers the event, and queues a bot join for the namespace.
```
- **Negative variant(s)**:
  - Refresh failure is logged and observed; the scheduler does not create a bot with stale or missing credentials.

## TV-DSK-001

- **Description**: Desktop SDK supports controlled recording duration.
- **Input**:
```text
Start a desktop capture session, wait 45 seconds, then stop it explicitly.
```
- **Expected output**:
```text
The resulting recording duration reflects the real stop event instead of a fixed 2-second timer.
```
- **Negative variant(s)**:
  - No production path auto-stops strictly at 2 seconds unless the caller explicitly configured that timeout.

## TV-OBS-001

- **Description**: Production observability covers the critical lifecycle events and failures.
- **Input**:
```text
Run one successful bot session and one failed Meet capture session.
```
- **Expected output**:
```text
Structured logs and metrics exist for join latency, upload latency, ASR latency, and the platform capture failure, without exposing secrets or transcript bodies.
```
- **Negative variant(s)**:
  - Missing metrics for a critical lifecycle step fails the release conformance suite.

## TV-BUILD-001

- **Description**: Repo-root build, typecheck, and test gates pass for the recfn packages.
- **Input**:
```text
npx turbo run build test --filter=recfn --filter=recfn-server --filter=recfn-client --filter=recfn-cli --filter=recfn-desktop --filter=recfn-zoom --filter=recfn-meet --filter=recfn-teams --filter=recfn-whisper --filter=recfn-deepgram --filter=recfn-assemblyai --filter=recfn-google-stt
```
- **Expected output**:
```text
All targeted packages pass build and test gates from repo root.
```
- **Negative variant(s)**:
  - Missing browser or Node globals in tsconfig cause the gate to fail until corrected.

## TV-COMPAT-001

- **Description**: Public compatibility is preserved and migrations are documented when behavior is corrected.
- **Input**:
```text
Run compatibility tests against the previous recfn-client and recfn-python call patterns plus the current HTTP routes.
```
- **Expected output**:
```text
Existing route paths and package entry points remain usable, and migration notes document any required caller changes.
```
- **Negative variant(s)**:
  - A behavior change without migration notes fails the release gate.

