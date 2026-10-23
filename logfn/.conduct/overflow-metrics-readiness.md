# HTTP queue overflow metrics

The original sink contract requires oldest-record eviction with a metric when the
queue exceeds its configured capacity. Memory enqueue, failed-send requeue and
IndexedDB transactions previously removed those records without exposing a count.

TypeScript `HttpSink.overflowEvictions` and Python
`SinkHttp.overflow_evictions` now expose a read-only cumulative per-instance count.
They include failed/cancelled-send requeue eviction. IndexedDB reports only after
transaction commit; abort/rollback and normal delivery acknowledgements do not
increment it. Each cooperating instance counts its own committed writes, including
records originally enqueued by another instance. Reading the metric does not send
another log or invoke user callbacks in the overflow path.

Counts reset on recreation; TypeScript saturates at Number.MAX_SAFE_INTEGER.
They are not persisted or globally aggregated. In-flight records can already have
reached the receiver, so eviction count is not proof of remote data loss. Existing
newest-record retention and at-least-once delivery contracts remain in effect.

Validation on 2026-10-23:

- Normal scoped npm ci completed without lock changes. 243 TypeScript tests,
  strict typecheck and build pass. Deterministic regressions hold a failing send
  while new events fill the queue, then verify requeue eviction counts and actual
  surviving payloads. IndexedDB tests cover separate instances and rollback.
- Actual isolated Chrome154.0.8037.58 persistent-profile acceptance passes real
  IndexedDB overflow, two connections, clone-failure rollback, HTTP delivery and
  unchanged counters after acknowledgement. Existing privacy-before-persistence,
  failed delivery, browser process restart and acknowledged-record deletion checks
  pass. Browser/profile/server resources are closed/deleted by the fixture.
- Fresh installed core tarball passes actual HTTP overflow/redaction/shutdown on
  Node18.17.0,20.19.0 and22.23.4, dynamic CommonJS imports and strict Node16/NodeNext
  declarations including the metric. Production dependency audit reports zero
  vulnerabilities; the temporary consumer is removed.
- Python3.9 isolated noneditable package install:44 passed,1 existing unsupported
  interpreter conversion-limit test skipped; strict mypy passes7 source modules.
  Python3.11 isolated install:45 passed. Normal Python3.11 repository CI passes
  wheel/sdist build, Ruff, strict mypy and45 tests. Initial CI wrapper lacked pip
  in its temporary uv environment; adding pip/build to that environment allowed
  the unchanged normal runner to complete.

Receipts: /tmp/log-overflow-{install,ts-tests,ts-types,ts-build,browser,packed,
py39-tests,py39-types,py311-tests,python-ci}.log. Source/browser/package acceptance
scripts remain reproducible in the repository. This closes the queue metric gap;
Safari/Firefox native coverage, broader specification acceptance and deployment
remain open. No release, hosted provider or deployment is claimed.
