# Intent Audit: Intent Inventory → Spec Coverage

## Intent Inventory (from user-provided context and Recall.ai feature parity targets)

1. **Meeting Bot API**: Send bots to join Zoom, Google Meet, Microsoft Teams meetings via URL.
2. **Bot lifecycle management**: Create, join, leave, status polling, automatic leave on empty.
3. **Real-time transcription**: Live transcript streaming via WebSocket with speaker diarization, <2s latency.
4. **Asynchronous transcription**: Post-meeting batch transcription with higher accuracy.
5. **Recording capture**: MP4 video, separate audio tracks per participant (where platform allows).
6. **Participant tracking**: Names, emails, join/leave times, roles.
7. **Chat message capture**: Read meeting chat messages.
8. **Calendar integration**: Connect calendars to auto-schedule bots for upcoming meetings.
9. **Webhook events**: bot.joining, bot.joined, bot.left, recording.ready, transcript.ready, participant.joined, participant.left.
10. **REST API**: Full CRUD for bots, recordings, transcripts, participants, calendars, webhooks.
11. **Multiple ASR provider support**: Whisper (local), Deepgram, AssemblyAI, Google Speech-to-Text.
12. **Desktop Recording SDK**: Capture system audio + screen without visible bot (Electron/Tauri).
13. **Recording storage**: Configurable storage backends via filefn/storage adapters.
14. **Transcript search and indexing**: Via searchfn integration.
15. **Meeting analytics**: Talk time per participant, silence detection, topic segmentation.
16. **Export formats**: SRT, VTT, JSON, plain text for transcripts.
17. **CLI**: recfn bot create, recfn bot status, recfn transcript get, etc.
18. **Python SDK**: Feature parity with TypeScript SDK.
19. **Self-hosted**: All data stays on user's infrastructure; no external data egress required.
20. **Consent mechanism**: Bot announces itself; consent tracked per participant.
21. **API key authentication**: Via secfn.
22. **Namespace isolation**: Per-namespace data scoping.
23. **Recording encryption at rest**: Via filefn/storage.
24. **PII handling**: Redaction capability.
25. **Bot join latency <10s**: Performance constraint.
26. **Real-time transcript <2s latency**: Performance constraint.
27. **100+ concurrent bots**: Scale constraint.
28. **Recording upload within 60s**: Performance constraint.
29. **flowfn integration**: Job queues for bot lifecycle, transcription.
30. **filefn integration**: Recording storage.
31. **searchfn integration**: Transcript indexing.
32. **memoryfn integration**: AI agent memory (consumers use directly).
33. **logfn integration**: Observability.
34. **secfn integration**: API keys, secrets.
35. **plugfn integration**: Webhook delivery.
36. **sendfn integration**: Notifications (optional).
37. **No GPU required**: Basic operation without GPU; GPU optional for Whisper.
38. **Platform adapters modular**: Add/remove platforms independently.
39. **ASR adapters pluggable**: Adapter pattern.
40. **Envelope pattern**: { ok, data/error } for all API responses.
41. **TypeScript client SDK**: Wraps all API and WebSocket endpoints.
42. **Bot config**: displayName, joinTimeout, autoLeaveOnEmpty, consentMessage, enableRealTimeTranscript, asrProvider, recordingFormat, language.
43. **Webhook HMAC signing**: X-RecFn-Signature header.
44. **At-least-once webhook delivery**: Retry on failure.
45. **Bot auto-detect platform from URL**: zoom.us, meet.google.com, teams.microsoft.com.

---

## Coverage matrix

| # | Intent item | SPEC.md section | Requirement IDs | Test vectors | Phase(s) |
|---|-------------|-----------------|-----------------|--------------|----------|
| 1 | Meeting Bot API | Overview, Public API (POST /bots) | BOT-001, PLAT-002, PLAT-003, PLAT-004 | TV-BOT-001, TV-PLAT-001–003 | 01, 03, 10, 11 |
| 2 | Bot lifecycle management | Semantics (Bot lifecycle), Data formats (Bot status transitions) | BOT-002, BOT-003, BOT-004, BOT-009 | TV-BOT-003, TV-BOT-004–006, TV-BOT-011 | 02 |
| 3 | Real-time transcription | Public API (WebSocket), Semantics (Transcription pipeline) | TRX-001, WS-001, WS-002 | TV-TRX-001, TV-WS-001, TV-WS-002 | 06 |
| 4 | Async transcription | Public API (POST /transcribe), Semantics | TRX-002, TRX-004 | TV-TRX-002, TV-TRX-004 | 05 |
| 5 | Recording capture | Public API (Recordings), Semantics (Recording storage) | REC-001, REC-002 | TV-REC-001, TV-REC-002 | 04 |
| 6 | Participant tracking | Public API (Participants), Data formats (Participant) | PAR-001, PAR-003 | TV-PAR-001, TV-PAR-003 | 03, 09 |
| 7 | Chat message capture | Public API (Chat), Data formats (ChatMessage) | CHAT-001, CHAT-002 | TV-CHAT-001, TV-CHAT-002 | 03, 09 |
| 8 | Calendar integration | Public API (Calendars), Semantics (Calendar integration) | CAL-001, CAL-002, CAL-003, CAL-004 | TV-CAL-001–005 | 15 |
| 9 | Webhook events | Public API (Webhooks), Data formats (Webhook event payloads) | WH-001, WH-002, WH-003, WH-004 | TV-WH-001–005 | 08 |
| 10 | REST API CRUD | Public API (all endpoints) | API-001, API-002, API-003, API-004, BOT-005, BOT-006, BOT-007, REC-006 | TV-API-001–005, TV-BOT-007–009 | 01 |
| 11 | Multiple ASR providers | Semantics (Transcription pipeline), Glossary (ASR Adapter) | ASR-001, ASR-002, ASR-003, ASR-004, ASR-005 | TV-ASR-001–004 | 05, 16 |
| 12 | Desktop Recording SDK | SPEC (Desktop Capture glossary) | DSK-001, DSK-002, DSK-003 | TV-DSK-001–003 | 18 |
| 13 | Recording storage | Semantics (Recording storage) | REC-003, REC-004, REC-005, INT-002 | TV-REC-003, TV-REC-004, TV-INT-002 | 04 |
| 14 | Transcript search | Semantics (Transcript search) | SRCH-001, SRCH-002, INT-003 | TV-SRCH-001, TV-SRCH-002 | 14 |
| 15 | Meeting analytics | Semantics (Analytics computation) | ANA-001, ANA-002, ANA-003 | TV-ANA-001–003 | 14 |
| 16 | Export formats | Public API (Transcripts), Data formats (Transcript export formats) | TRX-005, EXP-001, EXP-002 | TV-TRX-005, TV-EXP-001–003 | 07 |
| 17 | CLI | Public API (CLI) | CLI-001, CLI-002, CLI-003, CLI-004 | TV-CLI-001–003 | 13 |
| 18 | Python SDK | Public API (Python Client SDK) | SDK-002 | TV-SDK-002 | 17 |
| 19 | Self-hosted | Overview (Hard constraints), Invariants | All SEC-*, all REC-* | TV-SEC-003 | 04, 19 |
| 20 | Consent mechanism | Semantics (Bot lifecycle step 6), Invariants, Security | BOT-008, PAR-002, SEC-006 | TV-BOT-010, TV-PAR-002 | 09 |
| 21 | API key auth | Security, Public API | SEC-001, API-002, INT-005 | TV-API-003, TV-SEC-001, TV-INT-004 | 01 |
| 22 | Namespace isolation | Security, Invariants | SEC-002, API-004 | TV-API-005, TV-SEC-002 | 01 |
| 23 | Recording encryption | Security | SEC-003, REC-004 | TV-SEC-003 | 04, 19 |
| 24 | PII handling | Security, Semantics | TRX-008, EXP-002 | TV-TRX-008, TV-EXP-003 | 07, 19 |
| 25 | Bot join latency <10s | Performance constraints, Observability | OBS-003 | TV-OBS-003 | 20 |
| 26 | Real-time <2s latency | Performance constraints, Semantics | TRX-001 | TV-TRX-001 | 06 |
| 27 | 100+ concurrent bots | Limits/caps | LIMIT-001 | TV-LIMIT-001 | 19 |
| 28 | Recording upload <60s | Performance constraints | REC-003 | TV-REC-003 | 04 |
| 29 | flowfn integration | Semantics (Bot lifecycle), Existing systems | INT-001 | TV-INT-001 | 02 |
| 30 | filefn integration | Semantics (Recording storage), Existing systems | INT-002 | TV-INT-002 | 04 |
| 31 | searchfn integration | Semantics (Transcript search), Existing systems | INT-003, SRCH-001 | TV-SRCH-001 | 14 |
| 32 | memoryfn integration | Overview (Existing systems) | N/A (consumer responsibility) | N/A | N/A |
| 33 | logfn integration | Observability | INT-006, OBS-001 | TV-INT-005, TV-OBS-001 | 02, 20 |
| 34 | secfn integration | Security | INT-005, SEC-001, SEC-004 | TV-INT-004, TV-SEC-001, TV-SEC-004 | 01, 19 |
| 35 | plugfn integration | Webhooks | INT-004, WH-001–004 | TV-INT-003, TV-WH-001–005 | 08 |
| 36 | sendfn integration | Observability (MAY emit) | N/A (optional, not required) | N/A | N/A |
| 37 | No GPU required | Overview (Hard constraints) | ASR-002 | TV-ASR-001 | 05 |
| 38 | Platform adapters modular | Glossary, Goals | PLAT-001 | N/A (interface definition) | 00 |
| 39 | ASR adapters pluggable | Glossary, Goals | ASR-001 | N/A (interface definition) | 00 |
| 40 | Envelope pattern | Data formats (Response envelope) | API-001 | TV-API-001, TV-API-002 | 01 |
| 41 | TypeScript client SDK | Public API (TypeScript Client SDK) | SDK-001, SDK-003 | TV-SDK-001, TV-SDK-003 | 12 |
| 42 | Bot config | Public API (BotConfig), Data formats | BOT-010 | TV-BOT-012 | 00, 01 |
| 43 | Webhook HMAC signing | Data formats (Webhook event payloads), Security | WH-003, SEC-005 | TV-WH-004 | 08 |
| 44 | At-least-once delivery | Invariants, Semantics | WH-004 | TV-WH-005 | 08 |
| 45 | Platform auto-detect from URL | Public API (POST /bots), Semantics | BOT-001 | TV-BOT-001 | 00, 01 |

---

## Missing items analysis

- **Item 32 (memoryfn integration)**: memoryfn is listed as an existing system to integrate with, but the intent specifies consumers use memoryfn directly (not recfn wrapping it). This is correctly handled as consumer-side integration, not a recfn requirement. No spec change needed.
- **Item 36 (sendfn integration)**: sendfn for notifications is described as optional in the intent. The SPEC.md observability section notes "MAY emit" for optional integrations. No MUST requirement created (correct per intent).

**No missing intent items.** All 45 inventory items are covered in SPEC.md, REQUIREMENTS.md, TEST_VECTORS.md, and PLAN.md. Items 32 and 36 are explicitly consumer-side or optional per the original intent and are not missing.
