# Physical scratch limits and crash reclamation: next steps

Plan dated 2026-10-23 against ProbeFn 8dfe10995 and installed Playwright 1.57.0.
The current host is macOS 27.0. No quota, mount, container or service was created
for this assessment. Linux and Windows feasibility below is documentary, not
native acceptance.

## Requirement and guarantee boundaries

The original [REQUIREMENTS](specs/2026-04-15-new-384qfawh-spec/REQUIREMENTS.md)
requires configurable artifact/event caps and explicit failure/rollover
(STORAGE-002,248–255), final status/timestamps (SESSION-001,129–138), and actual
trace artifacts linked from reports (OBS-001,402–411). [SPEC](specs/2026-04-15-new-384qfawh-spec/SPEC.md)
573 defines2GiB artifact volume per run;583 prohibits silent truncation.

The literal text does not specify OS project quotas, an all-host-physical-block
limit or automatic crash garbage collection. Preventing opaque capture scratch
from growing without bound is a necessary unresolved part of interpreting the
artifact-volume promise across the capture lifecycle. Physical allocation,
logical evidence bytes, filesystem metadata, rollback journals, snapshots and
browser profile/cache bytes must be distinguished explicitly. Polling usage can
report overshoot; it cannot establish a hard upper bound.

## Baseline source paths

All line anchors below refer to baseline 8dfe10995, before the trace retry fix.

- `packages/browser-runner/src/browser-runner.ts:100–108` launches without an
  owned temp root and puts video encoding in OS `mkdtemp` storage. Only the
  in-memory session remembers that directory. Cleanup at276–278 removes it after
  browser disconnection; it survives failed removal in memory, not host death.
- `packages/browser-runner/src/trace.ts:48–56` creates OS temporary trace output,
  imports it through ArtifactStore, then removes it in `finally`.
- `packages/browser-runner/src/video.ts:10–18` has a separate legacy finalized
  copy;26–39 creates a streaming finalization copy beside encoder output.
  Output-size admission happens after Playwright has created those files.
- Installed `playwright-core/lib/server/browserType.js:157–165` always creates
  opaque artifacts and, absent a persistent profile, a browser profile under
  `os.tmpdir()`. `downloadsPath`/`tracesDir` alone do not redirect all scratch.
- `packages/storage/src/run-quota.ts:287–300` scans committed run files and cleans
  recognized interrupted staging files. It cannot see external OS scratch.
- `packages/storage/src/session-ownership.ts` holds native SQLite locks for
  cooperating run/session owners. Releasing that lock after Node death does not
  prove that every browser or encoder descendant has exited.

A concrete small prerequisite is trace receipt retention: a failed scratch `rm`
after successful import overrides `stopTracing`'s return. BrowserRunner records
`finalizedTracePath` only after that return and subsequently disables tracing when
the browser closes. Successful admission and pending scratch cleanup need separate
state so retry cannot lose a trace that is already present.

## Bounded implementation sequence

1. **Implemented in the trace cleanup checkpoint:** preserve trace admission receipts independently of cleanup errors in the current
   live owner. Retry only that exact scratch directory, and retain the existing
   trace result after retry. Prove import succeeded, removal failed, browser closed,
   retry removed scratch, and public session still references the ZIP. See
   [trace cleanup receipt](trace-cleanup-readiness.md). The later registry and OS
   enforcement steps remain prospective.
   This fixes live-process ownership; it does not establish crash reclamation.
2. Add a versioned, bounded scratch registry to the existing storage coordinator.
   Reserve a unique generation and relative path before creation; persist directory
   dev/inode plus a private ownership marker before giving it to a producer.
   Track prepared, producing, sealed/admitted, cleanup-pending and removed states.
   Persist the admitted destination/digest before deletion. Reuse native run
   ownership and minimum caps; reject links, replaced roots and stale generations.
   Stop older writers before upgrading this ownership protocol.
3. Reclaim automatically only scratch with durable proof of producer quiescence
   (never handed to a producer, or sealed after verified producer exit). An unknown
   producing generation becomes quarantined/recovery-required. Age, a stale PID,
   SQLite lock availability and filename prefixes are insufficient deletion proof.
   Never sweep arbitrary `probefn-*` or `playwright-*` directories in global temp.
4. Run the browser driver in an owned per-run helper process with its own temp
   environment set before Playwright is imported/launched. Do not mutate the host's
   global TMPDIR/TEMP or redirect unrelated sessions. Bind helper generation,
   browser instance and quota identity in the registry. Route explicit trace,
   video, download and finalization paths to that allocation; verify opaque
   profile/artifact paths too. Retain manifest paths relative to the repository.
5. Supply an actual OS-enforced allocation and process-containment backend before
   claiming a hard scratch cap. Unsupported hosts must report that capability
   honestly; existing payload counters cannot stand in for it. A backend limit
   error becomes E_STORAGE_CAP_EXCEEDED only when the owned quota is established
   as the cause; unrelated disk failure remains a storage error.

## Native ownership and OS feasibility

| Platform | Enforced storage candidate | Process ownership and deletion gate | Remaining proof |
| --- | --- | --- | --- |
| Linux | Host-provisioned XFS/ext4 project quota, or dedicated sized tmpfs. A dedicated allocation must include every helper/browser temp path. | A delegated cgroup v2 subtree contains the helper and descendants; retain its exact generation and kernel identity. After termination, verify `populated=0` before removing scratch. Do not allow workload migration out of the owned subtree. | Native quota exhaustion, child survival, cgroup delegation/permissions, helper crash, replacement/migration and cleanup restart. A cgroup alone does not impose a disk-byte quota. |
| macOS | A dedicated APFS volume with quota, or a separately approved bounded disk-image filesystem. Ordinary directory creation does not give a per-directory hard limit. | Existing native run locks fence cooperating callers only. Public Playwright BrowserServer exposes a ChildProcess and joined close/kill, but that is not a verified descendant containment boundary after helper death. Unknown orphan producers must remain quarantined until an authorized host quiescence mechanism proves them stopped. | APFS/image lifecycle and capacity/metadata behavior; exact descendant exit proof. Provisioning needs an explicit host-owned allocation workflow, not automatic changes to the user's disks. |
| Windows | An isolated quota-capable volume or equivalent host provisioned sandbox. NTFS user quota is per-user/per-volume, so it cannot isolate concurrent same-user sessions by directory. | Native Job Object with kill-on-last-handle-close and no breakaway can contain descendants; a helper must create/assign the job before launch and join process termination before cleanup. | Native job membership, nested jobs, crash behavior, volume lifecycle and per-run quota evidence. No Windows acceptance has been run. |

Linux tmpfs limits allocation with its `size` option and consumes memory/swap;
mounting normally requires CAP_SYS_ADMIN. Project quota needs filesystem and host
configuration. These are host prerequisites, not a reason to silently fall back
to a directory-size timer. Sources: [kernel tmpfs](https://www.kernel.org/doc/html/v7.0-rc7/filesystems/tmpfs.html),
[mount permissions](https://www.man7.org/linux/man-pages/man2/mount.2.html),
[ext4 quota configuration](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/managing_file_systems/limiting-storage-space-usage-on-ext4-with-quotas).

Cgroup v2 documents descendant population and subtree termination interfaces;
permissions and preventing escape remain deployment responsibilities. Source:
[kernel cgroup v2](https://cdn.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

Apple documents an APFS volume quota as limiting volume allocation; this is not a
per-folder quota. The local macOS27 `diskutil` and `hdiutil` manuals additionally
show APFS `-quota` and sized image creation. None was executed. Source:
[Apple APFS volume limits](https://support.apple.com/en-euro/guide/disk-utility/dskua9e6a110/mac).

Microsoft documents NTFS quotas by user/volume and Job Object descendant semantics,
including breakaway exceptions. Sources: [disk quotas](https://learn.microsoft.com/en-us/windows/win32/fileio/disk-quota-limits),
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

## Acceptance before claiming the broader guarantee

Use an owned local fixture, never a live site: force a browser/encoder output over
a small actual OS allocation while bypassing JavaScript payload counters; verify
kernel rejection, structured failure, retained evidence and truthful manifest.
Kill the helper before launch, during encoding, after artifact admission and during
cleanup. Test live-owner denial, surviving descendants, another generation/session,
replaced inode, symlink, PID reuse/ambiguity, repeated recovery, and registry caps.
A killed helper with unproven surviving descendants must produce quarantine, not
unsafe deletion or a claimed successful reclaim. Read back allocation/container,
process and directory deletion for every owned fixture.
