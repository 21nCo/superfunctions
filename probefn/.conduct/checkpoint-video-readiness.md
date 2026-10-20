# Requested checkpoint playback video

`checkpoint create --include-video` and MCP `probefn_checkpoint_create` with
`includeVideo: true` record the requested checkpoint playback as WebM. Recording
starts when that command creates its browser page and ends after screenshot,
DOM, accessibility, layout and optional style capture. Its duration follows that
navigation and capture operation; there is no fixed-duration recording window.
The runtime currently opens a fresh browser playback for each command, so this
file does not contain previous actions or continuous historical session footage.
Unrequested checkpoints do not enable video recording.

The recording page closes before Playwright finalizes and saves the video. Its
context remains alive long enough to persist browser storage state, then normal
browser cleanup closes it. The artifact store writes the completed nonempty file
under the checkpoint directory as `video.webm`, and its SHA-256 is included in the
checkpoint manifest. Video capture or persistence failure rejects the checkpoint
with `E_CHECKPOINT_CAPTURE_FAILED`; the manifest is committed only after required
artifacts exist. Temporary recording files are removed on browser cleanup.

Local verification uses actual Chromium to capture and decode a finalized WebM,
check its manifest hash, exercise finalization failure without a committed
manifest, and verify temporary recording cleanup. A separate actual Chromium
check exercises both CLI and MCP argument propagation, successful playback
cleanup and persisted video references. Existing browser lifecycle and core
checkpoint tests also pass. This is not Firefox/WebKit video or hosted deployment
evidence.
