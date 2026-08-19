# @probefn/admin

Private, self-hosted ProbeFn administration capability for Super Console.

This workspace package depends on ProbeFn's private local runtime packages
(`@probefn/core`, `@probefn/contracts`, and `@probefn/storage`) and is not a
standalone npm publication. A self-hosted Super Console mounts it in-process and
provides exact environment bindings with an absolute repository root, a
repository-relative artifact root, and an already-authorized checkpoint source.

The manifest exposes only domain-backed session, event-delta, checkpoint,
report, and storage-path operations. It intentionally omits cloud, baseline,
flow, auth-profile, browser-control, and session-enumeration claims until ProbeFn
has matching scoped administration APIs.
