# Phase 00: Core types, interfaces, and validators

## Phase goal
Deliver the foundational types, adapter interfaces, error codes, URL validators, and transcript formatters that all other modules depend on.

## In scope
- TypeScript types: Bot, BotConfig, Recording, Transcript, Segment, Participant, MeetingMetadata, ChatMessage, Analytics, TopicSegment, Calendar, CalendarEvent, Webhook.
- AsrAdapter interface (transcribeStream, transcribeBatch, supportedLanguages).
- PlatformAdapter interface (join, leave, getAudioStream, getParticipants, getChatMessages, etc.).
- Error codes enum/constants.
- Meeting URL validator (detect platform from URL).
- Transcript export formatters: toSRT, toVTT, toText, toJSON.
- Bot status state machine validator.

## Out of scope
- Server, platform implementations, ASR implementations, storage, database.

## Deliverables
- `recfn/core/src/types.ts` — all entity types and interfaces
- `recfn/core/src/errors.ts` — error codes and error factory
- `recfn/core/src/adapters/asr.ts` — AsrAdapter interface + AsrOpts
- `recfn/core/src/adapters/platform.ts` — PlatformAdapter interface
- `recfn/core/src/validators/url.ts` — meeting URL validator (detect platform)
- `recfn/core/src/validators/bot-config.ts` — BotConfig validator (defaults, ranges)
- `recfn/core/src/validators/state-machine.ts` — bot status transition validator
- `recfn/core/src/formatters/srt.ts` — SRT formatter
- `recfn/core/src/formatters/vtt.ts` — VTT formatter
- `recfn/core/src/formatters/text.ts` — plain text formatter
- `recfn/core/src/formatters/index.ts` — formatter entry point
- `recfn/core/src/index.ts` — barrel export
- `recfn/core/package.json` — package config
- `recfn/core/tsconfig.json` — TypeScript config
- `recfn/core/vitest.config.ts` — test config
- `recfn/core/__tests__/url-validator.test.ts`
- `recfn/core/__tests__/state-machine.test.ts`
- `recfn/core/__tests__/formatters.test.ts`
- `recfn/core/__tests__/bot-config.test.ts`

## Requirements covered
- PLAT-001, ASR-001, EXP-001, BOT-002 (state machine), BOT-010 (config validation)

## Implementation tasks
1. Create `recfn/core/` directory structure with package.json, tsconfig.json, vitest.config.ts.
2. Define all entity types in `types.ts`.
3. Define AsrAdapter and AsrOpts interfaces in `adapters/asr.ts`.
4. Define PlatformAdapter interface in `adapters/platform.ts`.
5. Define error codes enum and error factory in `errors.ts`.
6. Implement meeting URL validator: parse URL, detect zoom.us/meet.google.com/teams.microsoft.com patterns, return platform or error.
7. Implement BotConfig validator: apply defaults, validate ranges (joinTimeout ≤ 60000), validate asrProvider against registry.
8. Implement bot status state machine: define valid transitions map, `canTransition(from, to): boolean`, `assertTransition(from, to): void`.
9. Implement SRT formatter: segments → SRT string with sequence numbers, timestamps, speaker labels.
10. Implement VTT formatter: segments → WebVTT string with `<v>` tags.
11. Implement plain text formatter: segments → `[Speaker] (HH:MM:SS): text` lines.
12. Write unit tests for URL validator (valid Zoom/Meet/Teams URLs, invalid URLs).
13. Write unit tests for state machine (valid transitions, invalid transitions).
14. Write unit tests for formatters (SRT, VTT, text output against golden strings).
15. Write unit tests for BotConfig validator (defaults applied, invalid values rejected).

## Verification steps
- `cd recfn/core && npm install && npm run build` — builds without errors.
- `cd recfn/core && npx vitest run` — all tests pass.
- Tests cover: TV-BOT-002 (state machine), TV-BOT-012 (config validation), TV-EXP-001, TV-EXP-002.

## Stop condition
- All types exported from `recfn/core`. URL validator correctly identifies zoom/meet/teams URLs. State machine rejects invalid transitions. Formatters produce correct SRT/VTT/text. All tests pass. Report: "Phase 00 complete; core types and interfaces ready for Phase 01."
