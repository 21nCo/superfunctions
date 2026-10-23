# Actor-bound durable publish replay

Adds the precise `content.docs.publish.idempotency.v1` capability only when the
server has a trusted context resolver. Keyed publication then requires a verified
nonempty subject and includes it in the existing fingerprint. The dataset/key
record identity is unchanged: legacy records deterministically conflict, rather
than being mistaken for new work. Default anonymous behavior remains available
without advertising the stronger contract. README documents identity trust,
legacy migration, record retention and dataset deletion limitations.

Validation on Node 22.22.1:

- `npm test -w ./contentfn/server`: 206 passed, 2 external SQL service tests skipped.
- `npm run typecheck -w ./contentfn/server`: passed.
- `npx --yes turbo@2.6.1 run build --filter=@contentfn/server...`: 13 tasks passed.
- `python3 contentfn/.conduct/publish-idempotency-packed.py`: normal npm 11
  production install of packed dependency closure, 106 audited packages, zero
  vulnerabilities; actual loopback HTTP publication/replay/actor denial passed.
- New native SQLite regression closes/reopens the file, replays after draft
  removal without another audit record, rejects changed actor/input, isolates
  datasets, enforces revoked permission, and proves legacy-record conflict.

Initial native test attempt under shell Node 20 failed before fixture setup due
only to an existing Node 22 native binding. All reported native checks used
Node 22.22.1 with its matching binding. No deployment or provider delivery.

This is a producer prerequisite, not completion of CmsFn scheduled publishing.
