# Changelog

## 0.1.x

- Production-hardening remediation completed for `nucleus` rollout.
- Existing HTTP route paths remain stable, including `/api/v1/bots`, `/api/v1/recordings/*`, `/api/v1/transcripts/search`, `/api/v1/calendars/*`, and `/api/v1/webhooks`.
- WebSocket status frames are now canonicalized to `status.data.botStatus`.
- `GET /api/v1/bots/:botId` returns the aggregate bot view with nested `participants`, `recordings`, `metadata`, and `chatMessages`.
- Calendar token refresh orchestration now runs through shared OAuth flow packages and explicit runtime services.
- CLI transcript retrieval is PII-safe by default; raw transcript stdout now requires `--include-pii`.
- Python SDK now supports `recordings.upload(...)` and aggregate bot detail parsing in parity with the TypeScript SDK for the audited surfaces.
- Desktop recording no longer hard-stops at 2 seconds; recording lifecycle is caller-controlled.
- Shared packages now back persistence, storage, queueing, envelope handling, errors, metrics, and OAuth token flows.

## Migration Notes

- Compatibility wrappers retained only as needed for one minor release.
- Calendar compatibility wrappers remain time-bounded and are documented in `recfn/server/src/calendar/MIGRATION.md`.
- WebSocket consumers must read `status.data.botStatus` instead of the legacy `status` field.
- CLI automation or scripts that expect raw transcript text on stdout must pass `--include-pii`.
