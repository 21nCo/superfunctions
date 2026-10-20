# Upload stream finalization

The shared-storage upload integration now closes only after a successful write,
tries abort on a failed write/finalization, preserves the original storage error,
and releases the acquired writer in every terminal path. Native WritableStream
regressions reproduced two baseline defects: a rejected write was masked by an
invalid-state close error, and successful/failed uploads retained the writer lock.
Native streams already disallow close after a failed write; this does not establish
that the baseline committed partial data.

Validation: all 216 server tests across 39 files passed and the server TypeScript
build passed. Tests use actual native WritableStream instances for rejected write,
rejected finalization and successful close, alongside the existing local filesystem
upload/download integration. This does not establish atomic cloud-provider upload,
rollback of a remotely committed object, provider deadlines or orphan cleanup.
