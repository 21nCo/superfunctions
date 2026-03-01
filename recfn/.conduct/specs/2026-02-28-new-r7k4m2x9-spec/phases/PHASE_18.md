# Phase 18: Desktop capture SDK

## Phase goal
Implement the desktop capture SDK for recording system audio and screen without a visible bot, with local Whisper transcription and server upload capability.

## In scope
- Desktop capture via Electron or Tauri.
- System audio capture (macOS, Linux).
- Screen capture.
- Local recording to file (MP4 or audio-only).
- Local transcription via Whisper ASR adapter (no network required).
- Upload to recfn server for processing.
- POST /recordings/upload server endpoint for direct recording upload.

## Out of scope
- Windows support (Undefined). Mobile.

## Deliverables
- `recfn/desktop/package.json`
- `recfn/desktop/src/capture.ts` — system audio + screen capture
- `recfn/desktop/src/recorder.ts` — media encoder (audio/video → file)
- `recfn/desktop/src/transcriber.ts` — local Whisper transcription wrapper
- `recfn/desktop/src/uploader.ts` — server upload client
- `recfn/desktop/src/index.ts` — main API entry point
- `recfn/desktop/__tests__/recorder.test.ts`
- `recfn/desktop/__tests__/transcriber.test.ts`
- `recfn/server/src/routes/upload.ts` — POST /recordings/upload endpoint

## Requirements covered
- DSK-001, DSK-002, DSK-003

## Implementation tasks
1. Create `recfn/desktop/` with package.json (deps: electron or @tauri-apps/api, recfn-core, recfn-client).
2. Implement capture.ts: use Electron desktopCapturer or Tauri equivalent to get system audio + screen streams.
3. Implement recorder.ts: pipe captured streams to MediaRecorder or ffmpeg for file output.
4. Implement transcriber.ts: invoke Whisper ASR adapter locally on captured audio file. Return Transcript JSON.
5. Implement uploader.ts: use recfn client SDK to upload recording file to server (POST /recordings/upload).
6. Implement POST /recordings/upload on server: accept multipart file upload, store in filefn, create Recording entity, optionally trigger transcription.
7. Write unit tests: mock capture streams, verify file output, verify local transcription, verify upload.

## Verification steps
- `cd recfn/desktop && npm install && npm run build` — builds.
- `cd recfn/desktop && npx vitest run` — tests pass.
- Manual test: run desktop capture for 10s, verify recording file produced, verify local transcription produces JSON.
- Tests cover: TV-DSK-001, TV-DSK-002, TV-DSK-003.

## Stop condition
- Desktop SDK captures audio/screen, produces recording file, transcribes locally, uploads to server. Tests pass. Report: "Phase 18 complete; Desktop SDK ready for Phase 19."
