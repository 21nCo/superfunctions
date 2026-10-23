# Owned recording scratch cleanup

This extends encrypted capture scratch with bounded, ownership-aware reclamation.
It preserves the original recording/privacy/resource-lifecycle requirements; it
is not recovery of a crashed recording or a deployment-wide disk quota.

## Host configuration and lifecycle

`createRecordingScratch({ directory, cleanup? })` creates a new private root or
opens an existing root bearing its exact immutable marker. The parent must exist;
pass its canonical absolute path (for example, resolve macOS `/tmp` aliases with
`realpath`). An existing unmarked directory is deliberately not adopted. Root and
capture directories must be owned by the effective UID, with no group/other access.
Metadata files are exclusively created, synced, read-only, bounded to 4096 bytes,
and opened without following symlinks; hard-linked metadata/media is rejected.
The root marker pins its canonical path and random identity. Each manager also
pins root device/inode and rechecks them before managed mutation.

The factory performs one bounded cleanup sweep. Retain the manager and pass it to
`createBotWorker({ captureOptions: { scratch }, environment: 'production', ... })`.
Production workers require managed scratch with supported host identity; the check
also runs at capture startup. Development keeps the existing unmanaged
`temporaryDirectory` compatibility path, and direct capture can use managed scratch
without cleanup support. Neither path is labeled production-safe automatically.
The HTTP-only `createRecFnServer` does not create workers or own capture scratch.

```ts
const scratch = await createRecordingScratch({
  directory: '/var/lib/recfn/recording-scratch', // canonical, dedicated, host-local
  cleanup: { maxEntries: 128, maxBytes: 8 * 1024 ** 3, maxDurationMs: 1000 },
});
const worker = createBotWorker({ ...workerConfig, environment: 'production',
  captureOptions: { scratch } });
// Report scratch.lastCleanup; retry incomplete scans using the same manager.
const report = await scratch.cleanup();
// On shutdown, stop dequeuing first, then:
await worker.cancelCaptures();
await scratch.close();
```

The host owns scheduling further cleanup calls and reporting skipped/incomplete
results. A manager keeps an unfinished directory scan open across calls, so a
prefix of live or unknown entries cannot starve later remnants. `close()` releases
that handle and refuses subsequent allocation/cleanup; retained artifacts still
have their own disposal. Concurrent cleanup calls fail explicitly rather than
sharing/corrupting an iterator. Await an active cleanup before closing. Repeatedly
constructing new managers restarts their scans; reuse one manager to finish a sweep.

## Ownership and deletion

Before media writes, each fresh UUID capture directory receives a synced immutable
manifest containing a random owner token, root identity, PID, and hashed host/boot
identity. Linux additionally records the PID namespace. macOS uses platform UUID
and kernel boot time; Linux uses machine ID, kernel boot ID, and `/proc` namespace.
Identity lookup failure or unsupported platforms yield no cleanup authority;
ordinary capture remains available, while production worker construction fails
with a configuration error. This requires a dedicated **host-local filesystem**
and trusted cooperating processes sharing its UID. It does not authenticate a
hostile same-UID process, duplicated machine identities, or remote/network mounts.

A matching current boot/namespace is reclaimable only after process probing
returns ESRCH. Live or reused PIDs, permission-ambiguous probes, different hosts,
and different current-boot PID namespaces remain untouched. A verified same-host
older boot is dead by definition. No age threshold or missed heartbeat revokes
ownership. This favors retained bytes over deleting a possible live recording.

Only recognized capture/retired UUID directories containing exactly managed
`owner.json` and optional `recording.enc` files qualify. Unexpected entries,
symlinks, hard links, unsafe permissions, and missing/invalid owner metadata are
reported and retained. Before deletion the manager revalidates root, token and
directory identity, then atomically renames to a new quarantine UUID. Names are
never reused: concurrent cleaners cannot accidentally move a successor capture
into quarantine after inspecting an earlier owner. Failed cleanup is reported;
quarantined remnants remain discoverable. The manifest is removed last. A crash
between removing the manifest and removing the empty directory can leave an
unattributed empty directory, which is conservatively retained for offline repair.

The initial design considered reusable admission slots. Source analysis identified
an ABA race between two cleaners and a new slot owner; that design was removed
before acceptance. This implementation does not infer an atomic global admission
cap by counting files. Per-artifact encoded limits, encryption overhead, capture
and upload deadlines remain unchanged. Deployment-wide resource admission, total physical disk limits, and offline repair
of unknown remnants remain operational concerns. Original LIMIT-001 specifically
requires a per-namespace bot limit; its admission successor is documented in
`bot-admission-readiness.md`. A global OS scratch quota is not explicitly required
by the original specification.

## Bounds

A call defaults to at most 128 examined entries, 8 GiB of eligible file bytes, and
a 1000 ms scheduling budget. Entry limit is configurable through 4096; time budget
through 60 seconds. Time is checked **between filesystem operations** and is not
a hard deadline on an unresponsive filesystem syscall. Byte accounting includes
managed metadata and ciphertext logical lengths, not filesystem allocation. A file
larger than the byte budget remains with an explicit `byte-budget` report; configure
a sufficient budget or perform an authorized offline cleanup. An incomplete scan
continues at its actual directory position on the next call. New directory entries
may be seen on the next full sweep, consistent with host filesystem iteration.

## Validation

Local macOS / Node 20.20.0 / FFmpeg 9.0.2 validation:

- Server build and configured typecheck pass.
- Focused native tests: 25 pass across scratch, encrypted crash lifecycle, and bot
  lifecycle suites. The full server suite then passes 266 tests across 47 files.
- Two additional destructive-cleanup refusal tests were added afterward; the final
  nine-test scratch file passes. Product source did not change after the full run.
- Actual SIGKILL of an encoding worker leaves encrypted media without its key;
  the encoder PID disappears, a fresh manager reclaims exactly that dead capture,
  and only the root marker remains. Owned process handles are awaited, then all
  fixture roots are removed.
- Actual independent owner and cleaner processes establish live-owner retention,
  dead-owner reclamation, and two-cleaner behavior while a new UUID owner survives.
- A 130-entry retained prefix with a three-entry scan budget reaches and reclaims
  the dead capture through repeated bounded calls; all retained entries are visited
  and the scan handle closes explicitly. Concurrent cleanup and closed-manager
  operations reject deterministically.
- Unknown entries, symlinks, writable/hard-linked metadata, root permission changes,
  foreign/unsupported identity, and incomplete manifests are retained. PID reuse is
  treated like a live PID. Previous-boot and foreign-namespace branches use explicitly
  simulated manifest values; no host reboot or Linux/container acceptance occurred.
- The existing bot join/record/leave/upload scenario additionally runs with the real
  managed scratch manager and production worker configuration, retaining its ready
  recording/storage assertions and verifying the capture directory is disposed.
  Missing/unmanaged and closed-manager production configurations reject.

The first focused run passed one test and failed eight because test roots used the
macOS `/tmp` symlink alias. Fixtures now pass canonical `realpath` roots; the strict
production path requirement was preserved. No timeout or semantic assertions were
weakened. A declaration mismatch from using overloaded `lstat` return types was
corrected to the actual numeric Node `Stats` type before successful build.

Commands:

```sh
npm run build --workspace=@recfn/server
npm test --workspace=@recfn/server -- __tests__/recording-scratch.test.ts __tests__/encrypted-capture-lifecycle.test.ts __tests__/bot-lifecycle.test.ts
npm test --workspace=@recfn/server
npm run typecheck --workspace=@recfn/server
npm test --workspace=@recfn/server -- __tests__/recording-scratch.test.ts
```

Receipts: `/tmp/rec-scratch-build4.log`, `/tmp/rec-scratch-focused2.log`,
`/tmp/rec-scratch-full.log`, `/tmp/rec-scratch-types.log`, and
`/tmp/rec-scratch-permissions-final.log`. No dependency or lockfile changes.
Python remains the HTTP/WebSocket client; no client protocol or Python implementation
changed. The preceding encrypted-scratch checkpoint's 17 Python and 108 TypeScript
core/platform/client tests remain applicable to unchanged code, not new rerun claims.

No live provider, external service, deployment, global temporary-directory sweep,
or comprehensive production-readiness assertion is part of this slice.
