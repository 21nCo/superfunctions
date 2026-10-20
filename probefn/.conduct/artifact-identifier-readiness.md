# Artifact identifier containment

Session IDs previously accepted parent path segments: reading `../../package` through SessionManager could read the repository package.json. Dot-only run/checkpoint/profile identifiers also collapsed path components. Event sink names were joined directly into output paths.

Identifiers now remain a single non-reserved path segment. Session state access, browser and dev-server startup, event sinks, admin operations, and MCP startup reject invalid identifiers before the corresponding I/O. Checkpoint/profile display names retain their existing normalization, then reject reserved dot segments. Auth profile imports require repository-relative source paths, and destination identifiers are validated before source access or profile copying.

The admin dependency now resolves to the existing shared admin0.1.5 workspace package; stale nested0.1.0 lock entries are removed. A clean scoped install and actual shared MCP/admin builds completed. Probe admin passed four tests, typecheck and ESM/declaration build without source aliases.

## Validation

The baseline session traversal reproduced a read of a sentinel package.json. New regressions cover rejected reads/writes, dot identifiers, browser/dev-server pre-I/O validation and outside-repository auth imports. The final Node22 combined suite passed124 tests across29 files, including18 new identifier regressions, and the unified TypeScript check passed. Existing Chromium auth-profile, CLI/MCP video, process lifecycle and storage concurrency coverage passed with the guards enabled. The unfiltered vector harness also passed28/28 with no warnings.

## Limits

These are lexical path and identifier boundaries. This change does not implement a filesystem sandbox against malicious symlinks or concurrent filesystem replacement. Existing Firefox host-launch, broader browser fault-matrix, distribution, global disk quota, Windows/process recovery, performance and hosted deployment gates remain open.
