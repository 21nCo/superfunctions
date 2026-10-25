# Native Safari acceptance attempt

CMS baseline fe5ed4839 has installed Chromium acceptance. An additive native Safari
runner now reuses the full packed Studio application, real ContentFn/CMS HTTP setup,
schemas and storage. It uses an isolated safaridriver session and does not modify Safari
settings itself. Run with `python3 cmsfn/.conduct/studio-packed-acceptance.py
--native-safari --producer-root <built matching ContentFn checkout>`.

The intended native matrix covers boot, save/conflict, history revocation, canonical
references, media with array reordering, richtext preservation and limits, workflow
publication and dataset isolation. **This matrix has not executed successfully.** It
must not replace the broader Chromium matrix or imply native readiness.

## October 25 attempt

- CMS worktree was clean at fe5ed4839 before fixture edits.
- First normal packed install omitted the built producer override and failed importing
  missing ContentFn dist, before opening any automated browser session.
- Corrected normal installation packed 32 packages using the built ContentFn checkout.
  Production-only and tooling installations each reported zero vulnerabilities.
- Native Safari 27.0 (22625.1.29.11.27) POST `/session` timed out at 25 seconds.
  A bounded retry with the Settings window closed reached the same timeout. Neither
  attempt reached a Studio assertion. Both owned safaridriver processes terminated.
- Original `Show features for web developers` and `Allow remote automation and external
  agents` were both OFF, captured through native UI. They were temporarily enabled under
  the user's authorization and both restored OFF with UI readbacks after the attempts.
  The owned Settings window closed; the original Start Page window 10931 remained.
- Exact owned consumers `/tmp/cms-studio-packed-1em6wi53` and
  `/tmp/cms-studio-packed-lwsbd5x2` were removed and absence verified. No accounts,
  deployments, external services, unrelated browser sessions or global Safari data changed.

Receipts: `/tmp/cms-native-safari-packed.log`,
`/tmp/cms-native-safari-packed-retry.log`, `/tmp/cms-native-safari-session-retry.log`,
`/tmp/cms-safari-settings-before.json`, `/tmp/cms-safari-automation-before.json`,
`/tmp/cms-safari-automation-restored-final.json`,
`/tmp/cms-safari-developer-restored-final.json`, `/tmp/cms-safari-windows-final.json`.
The native runner passes JavaScript syntax checks only. The shared harness subsequently passed the Chromium matrix recorded in `literal-save-readiness.md`; its native branch did not. Native behavior and
the new native assertions remain unverified; deployed auth/CORS/storage and the wider
native operational/preview matrix remain open.
