# Phase 07: Transcript export formats (SRT, VTT, text)

## Phase goal
Wire the core formatters into the transcript API endpoint so transcripts can be exported in SRT, VTT, JSON, and plain text formats, with optional PII redaction.

## In scope
- GET /recordings/:recordingId/transcript?format=srt|vtt|text|json
- Content-Type headers per format.
- PII redaction (redact=true query param): replace participant names/emails with [REDACTED].
- Integration of core formatters (from Phase 00) into server routes.

## Out of scope
- New formatters. ASR. WebSocket. Webhooks.

## Deliverables
- `recfn/server/src/routes/transcripts.ts` — update to support format + redact params
- `recfn/server/src/transcription/redact.ts` — PII redaction logic
- `recfn/server/__tests__/api-transcript-export.test.ts`
- `recfn/server/__tests__/redaction.test.ts`

## Requirements covered
- TRX-005, TRX-008, EXP-001, EXP-002

## Implementation tasks
1. Update GET /recordings/:recordingId/transcript route to accept format query param.
2. For format=json: return Transcript entity as JSON with envelope (current behavior).
3. For format=srt: invoke core SRT formatter, return with Content-Type text/plain.
4. For format=vtt: invoke core VTT formatter, return with Content-Type text/vtt.
5. For format=text: invoke core text formatter, return with Content-Type text/plain.
6. Implement redact.ts: given segments and participant map, replace names/emails with "[REDACTED]".
7. When redact=true, apply redaction before formatting.
8. Write tests: each format produces correct output, redaction replaces names, default format is json.

## Verification steps
- `cd recfn/server && npx vitest run` — all export and redaction tests pass.
- Tests cover: TV-TRX-005, TV-TRX-008, TV-EXP-001, TV-EXP-002, TV-EXP-003.

## Stop condition
- All four export formats work. Redaction replaces PII. Content-Types correct. All tests pass. Report: "Phase 07 complete; transcript export formats ready for Phase 08."
