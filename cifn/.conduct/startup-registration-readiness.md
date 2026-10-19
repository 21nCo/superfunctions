# Startup registration token wiring

2026-10-19 UTC. The memory-secret bootstrap wrote `cifn.runner.registration_token`, but the registration service reads `CIFN_RUNNER_REGISTRATION_TOKEN`. The configured environment token therefore failed with HTTP 401 through the actual server entrypoint. Bootstrap now uses the service's canonical key.

`npm run test:startup --workspace=./cifn/typescript/control-plane` builds and launches `dist/server.js` in a child process with explicit memory adapters, a disposable registration token and an ephemeral port. It verifies that an incorrect token returns 401, the configured token registers a runner, and the returned runner secret authenticates a heartbeat. The child process is terminated and awaited in cleanup. Startup logs now report the actual assigned port when PORT=0.

The regression was first run before changing the token key and failed with 401 instead of 200. It passes after the fix. Package lint/typecheck and ESM/CJS/declaration builds pass. This is a local built-process acceptance test, not deployment or real secret-provider evidence. Original durable store, recovery, notification delivery, external providers, runner execution and broader CiFn gates remain open as recorded in request-boundary-readiness.md.
