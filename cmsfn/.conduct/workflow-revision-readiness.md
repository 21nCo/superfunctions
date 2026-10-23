# Workflow publication revision checkpoint — 2026-10-23

Addresses the concurrent-edit boundary of original WF-001 and REL-001 in
`.conduct/specs/2026-02-07-new-zr4cvxyp-spec/REQUIREMENTS.md`.

At baseline `5d9ea54377451af60d3ba7245d87cb4393ce280a`, both single and release
publication checked a fetched draft's workflow state but omitted `ifRev` when
publishing it. An owned HTTP reproduction with the built server checked approved
revision `approved-r1`, sent only `{dataset,id}`, and returned success for a
changed document at `changed-r2` in workflow state `draft`.

Both publication paths now pass the exact fetched revision to the existing
ContentFn publish helper. Draft responses must contain a nonempty string `_rev`;
missing, empty, whitespace-only or non-string revisions return
`CONTENTFN_UNAVAILABLE` before any publish call. The revision itself is not
trimmed or normalized. Existing `REV_CONFLICT` to `CONFLICT` mapping retains
upstream code and expected/actual revision details for single publication.
Releases retain their existing sorted per-document summary: a conflict is a
failure for that document and later documents are still attempted. There is no
automatic refetch/retry that could approve a changed draft accidentally.

## Validation

- `npm test --workspace=@cmsfn/server`: **94 tests, 14 files pass**. Seven new
  owned HTTP tests cover single revision conflict and detail mapping, unchanged
  publication including draft-prefixed IDs, sorted release continuation, and
  unusable revision rejection for both single and release publication. The prior
  release authorization fixture now includes the real producer's required
  revision field. Existing assertions and authorization tests remain intact.
- `npm run typecheck --workspace=@cmsfn/server` and
  `npm run build --workspace=@cmsfn/server`: pass; ESM, CJS and declarations built.
- Fresh isolated normal `npx --yes npm@11.21.0 install` of locally packed
  `cmsfn`/`@cmsfn/server` 0.0.2 and `@contentfn/server`/core 0.2.0 plus their built
  local dependency closure passes without force or peer bypass; npm reports zero
  vulnerabilities. The real producer is built ContentFn commit
  `f9f4e1460f59736863a48da624746bfbf6cec887`. No producer files were modified.
- Copied `workflow-revision-acceptance.mjs` runs from that installed directory
  with `node acceptance.mjs` on Node 20.20.0 and with
  `npx --yes --package=node@20.19.0 node acceptance.mjs` on the producer's exact
  declared minimum. It serves actual ContentFn through HTTP, captures its draft
  response, changes `_cms.state` via the real ContentFn patch API, and then lets
  CmsFn publish the captured revision. Actual ContentFn rejects the changed
  revision; persisted reads show changed drafts remain unpublished. Unchanged
  single and later release documents publish. Every outgoing publish includes
  the captured revision. There is no mocked fetch or fake publish endpoint.
- Producer source confirms `ifRev` is accepted by its publish endpoint, compared
  with the draft revision, and followed by a revision-conditional update inside
  its mutation transaction. CmsFn already supported this optional HTTP argument;
  no SDK signature, dependency version or configuration change is needed.
- `git diff --check` passes. Temporary package-install fixtures are removed after
  verification; owned HTTP servers and adapters are closed.

This is actual installed-package/HTTP/shared-memory-adapter transaction evidence,
not new SQLite/PostgreSQL/MySQL or deployment acceptance. Other or older ContentFn
versions that silently ignore `ifRev` are not validated by this checkpoint.

## Remaining scope

This does not complete WF-001 or REL-001 as a whole. Release scheduling,
concurrent release membership updates, other route authorization/body limits,
upstream auth forwarding and response bounds, audit integration, Studio editing
and live preview remain distinct work. Publish/unpublish authorization policy and
workflow override semantics are unchanged. Release publication remains partial,
not all-or-nothing, and network failure does not prove rollback upstream.

Logs: `/tmp/cms-workflow-{focused,full,types,build}-oct23.log`,
`/tmp/cms-workflow-packed-{install,http,node2019}-oct23.log`.
No push, release, deployment or external provider send occurred.
