# Native session ownership prerequisite

`SessionOwnership.acquire` establishes exclusive native SQLite writer locks for both the session identity and run identity. It resolves the repository/artifact directory canonically, respects the actual volume's case aliases, acquires the two identities in sorted order, and immediately rejects SQLite busy without waiting or stealing by elapsed time. Partial acquisition closes acquired connections in reverse order. Releasing closes connections but never unlinks lock databases. A killed process loses its native locks immediately.

A separate short-transaction registry pins every registered lock slot's filesystem device/inode. Removing or replacing a slot fails both the current owner's `assertOwned` and a new acquisition. A missing registry with existing slots also fails closed. This protects cooperating writers and detects slot replacement; it does not defend against arbitrary external replacement of the entire authority directory or modification of its registry. The registry and slots are persistent authority, not disposable cache files.

Metadata has a separate bounded budget: the registry has a 32MiB SQLite pager ceiling and each slot an 8KiB ceiling. `storageCaps.maxOwnershipSlots` accepts integers 2..65536, default256 (normally two new slots per new session/run pair). The selected limit persists, implicit reopen preserves it, and an explicit larger configuration permits capacity growth. Reducing below existing allocated slots fails. Orphan files left by interrupted admission count toward the slot budget. Busy ownership, capacity exhaustion, and broken authority have distinct structured errors. Journal, directory metadata, and filesystem allocation are not represented as a hard OS quota.

There is no live slot-deletion or expiry mechanism. For offline metadata maintenance/recovery, stop **all** Probe writers and their browser/dev-server children first, verify the processes are gone, and retain a backup of the whole authority directory before replacing it as a unit. Never remove individual slot databases while a writer could retain a connection. Prefer increasing the configured capacity for normal continued use. Removing the registry to bypass a busy owner is unsupported and unsafe.

Native evidence:

- Independent child acquires session+run locks; second process, second session sharing the run, and repository-path alias all reject.
- SIGKILL of that owned child is followed by immediate successful acquisition, without any lease timeout.
- Slot unlink and replacement fail closed before and after original owner release.
- Partial acquisition failure releases the newly acquired run lock; another independent session can then acquire it.
- Configured two-slot exhaustion, explicit expansion to four slots, persistent implicit reopen, invalid settings, and invalid lowering all behave deterministically.
- Five focused tests pass; scoped build/typecheck15tasks pass. Logs `/tmp/probe-ownership-tests2.log` and `/tmp/probe-ownership-types.log`. Temporary roots and owned child removed.

This is a prerequisite API checkpoint. Runtime command/transport fencing and resident browser integration are still being implemented; these tests alone do not establish that existing CLI/MCP mutations are fenced.
