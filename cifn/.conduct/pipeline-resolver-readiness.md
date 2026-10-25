# Supervised pipeline resolver prerequisite

Original 2026-02-07 PIPE-006 requires repository pipeline resolution with the documented fallback paths; original 2026-02-05 INT-005/RUN-007 require consistent repository/ref checkout. The prior resolver used shell-interpolated `git clone --branch`, did not support commit SHA resolution and read config paths without containment/byte limits. Pinning webhook identities alone would therefore leave the real pipeline path broken.

The existing Ci-owned process supervisor and Git checkout implementation now live in lower-level control-plane modules. Runner wrappers preserve the existing helper API and use the same `ProcessGroupUncertainError` class through the package dependency. No shared dependency, root lock, provider or unrelated implementation was introduced.

`resolvePipelineDoc` is now exported with trusted `ResolveOptions`. Its real Git path awaits the same supervised checkout used by the runner, accepting explicit SHA/branch/tag/HEAD and retaining the HTTPS/local-policy/credential boundaries from the checkout checkpoint. It searches `.ci/pipeline.yml`, `.ci/pipeline.yaml`, `cifn.yml`, `cifn.yaml` in order, or the explicit relative config path. Before reading, it resolves containment, opens without following the final symlink, checks regular-file identity and reads at most 500 KiB + 1 byte. Oversize multibyte data, escaping symlinks, directories and traversal fail. Internal symlinks are permitted when their canonical target remains inside the owned workspace.

Signal cancellation joins owned process-group cleanup before deleting the normal resolver workspace/helper; uncertain group termination retains them and propagates the unchanged error class. A surviving process can retain its environment, and host intervention may be needed. This is not hostile-process filesystem isolation or a repository disk quota. Custom fetchers are trusted host I/O: returned bytes are bounded and late cancelled results reject, but arbitrary callback execution is not forcibly stopped.

The helper remains injected through `createApp({pipelineResolver})`. The existing built server has no resolver configured; actual signed webhook normalization/gating and explicit built-server Git policy remain the next separate slice. No claim of complete PR-trigger or hosted private-repository readiness is made here.

## Validation

Actual local bare repositories cover differing pinned SHA/branch content, fallback config, internal/escaping symlinks, directory rejection, exact 500 KiB/multibyte overflow and missing configs. Malformed paths/cancelled requests do not call fetchers. Active cancellation uses an owned executable and independently checks process disappearance plus resolver/helper deletion. A late custom-fetcher result cannot be accepted after cancellation.

The actual built and fresh installed HTTP/SQLite fixture now invokes the real exported resolver against its owned bare repository/SHA before remote checkout, lost acknowledgement and restart acceptance. The installed CJS consumer additionally checks that runner and control-plane checkout exports share implementation identity; public declaration consumers include resolver options. No external clone/provider sends occur.

Final validation completed successfully:

- Control-plane full suite: 222 tests (`/tmp/cifn-resolver-control-full.log`), including five resolver cases.
- Selected runner regression suite: 75 tests across remote execution, checkout, logs, step journals, artifacts/cache and TestFn integration (`/tmp/cifn-resolver-runner-full.log`). Legacy tests that clone public repositories were not run; this is not a claim of the entire runner suite passing.
- Control-plane durable typecheck and control-plane/runner builds plus runner typecheck passed (`/tmp/cifn-resolver-types-final.log`, `/tmp/cifn-resolver-control-build-final.log`, `/tmp/cifn-resolver-runner-build-final.log`, `/tmp/cifn-resolver-runner-types.log`).
- Built Node 20 native acceptance passed with `actualPinnedPipelineResolution: true`, alongside existing checkout/replay and explicitly attested execution reconciliation (`/tmp/cifn-resolver-native.log`).
- Fresh Node 22.22.0 consumer passed with 11 packed packages, actual HTTP/SQLite/local Git execution, ESM/CJS imports, strict declarations and production audit 0 (`/tmp/cifn-resolver-packed.log`). npm 11 ran with Node 22 on PATH; source/native workspace checks used Node 20 for the installed native ABI.

Owned temporary repositories, resolver workspaces, HTTP/SQLite consumer resources and installed-consumer directory were cleaned by the fixtures. Both validation command sessions exited 0. No external Git repositories or provider endpoints were contacted. The optional trusted-fetcher cancellation limit, uncertain process retention, repository disk quota, built-server resolver wiring and webhook trigger policy remain as described above.
