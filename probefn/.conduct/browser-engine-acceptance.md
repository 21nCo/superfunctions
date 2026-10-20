# Browser engine acceptance gate

2026-10-20 UTC. Run `npm run test:browsers --workspace=@probefn/workspace` after installing the matching Playwright Firefox and WebKit binaries. This separate acceptance command requires both engines; it does not silently skip an unavailable or failing engine. The regular suite continues to exercise Chromium and does not establish engine parity.

The matrix launches each engine through BrowserRunner, loads a real loopback HTTP fixture, executes an action, verifies persisted console/HTTP500 deltas, validates a PNG screenshot and finalized trace archive, and checks browser disconnection. Each test cleans its owned server, browser and temporary artifacts.

Local WebKit 2227 passed this smoke flow. Firefox 1497 failed before page creation: direct Playwright launch independently reproduced a 10000 ms timeout with `sandbox_extension_issue_file_to_process failed ... Operation not permitted` and `RenderCompositorSWGL failed mapping default framebuffer`. The test forwards the real engine launch with an explicit 10000 ms deadline. The final gate finishes in 11.7 seconds with one failure and one pass; diagnostics prove Firefox fails during launch before a context exists, and Playwright kills its process and removes its temporary profile. Nested cleanup always closes the fixture server and removes its artifacts. No production launch implementation was changed. No browser sandbox settings were disabled. Both installed paths matched Playwright 1.57.0.

Firefox acceptance remains FAILED on this host. WebKit smoke success does not establish its full lifecycle/fault/action/video/accessibility suite. This gate remains part of the full production-readiness objective, alongside the outstanding platform and deployment requirements.
