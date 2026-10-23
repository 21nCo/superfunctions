# CmsFn Studio

React 18 authoring components for a self-hosted ContentFn installation. This package exports UI components; the host serves the `/studio` route and supplies authentication and configuration. It does not initialize a database schema or start an HTTP server.

Install `@cmsfn/studio` with `react@^18.3.1` and `react-dom@^18.3.1`. React is a host-owned peer so the Studio and its MDFN/UIFn adapters use the same renderer instance. Both ESM and CommonJS exports include matching TypeScript declarations.

```tsx
import { createRoot } from 'react-dom/client';
import { App, type CmsfnStudioConfig } from '@cmsfn/studio';

const config: CmsfnStudioConfig = {
  contentfn: { baseUrl: 'https://content.example.test' },
  datasets: [{ name: 'production' }],
  auth: { kind: 'custom' },
  desk: {
    kind: 'documentList', title: 'Posts', dataset: 'production', types: ['post'],
  },
};
createRoot(document.getElementById('studio')!).render(<App config={config} />);
```

The matching ContentFn 0.2.0 producer prerequisite is tracked in sf-next PR #56. Studio uses its real package exports, not source aliases. A host bundler must support React JSX and browser modules. Do not put service credentials in browser configuration. Enforce authentication and dataset access on the ContentFn/CmsFn HTTP servers.

From the monorepo root:

```sh
npm ci --workspace=@cmsfn/studio --include-workspace-root=false
npx turbo run build --filter=@cmsfn/studio...
npm run typecheck -w ./cmsfn/studio
npm test -w ./cmsfn/studio
```

The App defaults to a Drafts list and offers a separate Published view. Published documents are read-only; **Create or open draft** copies the displayed published revision through ContentFn `docs.fork`, or loads an existing draft through the authorized read route. Draft saves and workflow changes use the draft ID/revision. Publication state is checked against ContentFn; publishing and unpublishing call the role-gated CmsFn server.

Serve Studio and its API paths under one browser origin (or explicitly configure an appropriate authenticated CORS policy in the host). To expose publish/unpublish, configure `cmsfn.apiUrl` for Studio and provide the CmsFn server with its database and `getRolesForSubject` callback. ContentFn editor policies must explicitly allow `query.drafts`, `docs.fork`, and appropriate `docs.get`/`docs.patch` operations. A public `query` allowance does not grant draft queries.

Singleton desk nodes open their fixed document ID in the selected Drafts or Published perspective and switch the selector to the node’s configured dataset. A dataset absent from `config.datasets` is rejected before a request. Authorized documents must match the singleton’s declared type before editor controls appear. Missing or denied reads show an error without creating a document; published documents use the same explicit draft workflow described above. These UI checks complement server authorization.

The desk also exposes **Audit events** and **Webhook deliveries** for the selected dataset through `cmsfn.apiUrl`. CmsFn must grant `audit.read`; configure its server-owned `contentfnAuditHeaders` when the ContentFn audit policy requires upstream credentials. Never place those credentials in Studio configuration. Webhook history requires the ContentFn schema 4 writer/backfill readiness described in `../.conduct/webhook-audit-integration.md`.

Audit panes paginate metadata, offer refresh/retry and show server denial as No access. Changing datasets immediately clears the prior dataset’s data and cancels its request. Missing API configuration and failed/malformed responses are visible errors rather than successful empty lists. Audit panes do not render document bodies, destination credentials or arbitrary error details.

**Releases** opens the selected dataset’s manual batch publisher. Configure the CmsFn database and grant `release.manage` plus per-document `doc.publish`; each draft must also pass the workflow gate. Create a named batch, add draft document IDs, and publish to see individual successes and failures. Adding `drafts.article` uses canonical `article`. Publishing is best-effort and continues after a document failure; it is not an all-document transaction. A transport failure does not establish rollback: refresh and inspect state before retrying. Automatic scheduling remains unavailable even if a stored release has `publishAt` metadata.

**Import / export** downloads the complete JSON archive and imports a supplied archive into the selected dataset. The host must grant `audit.read` for that target and configure server-owned `contentfnOpsHeaders` when ContentFn requires credentials. Missing or failed identity resolution denies the operation. Synchronous import requests and export responses are bounded to 25 MiB; export requests are bounded to 64 KiB. Oversized operations fail explicitly, without truncating archives. Larger archives require a separate streaming/job integration.

Imports default to same-dataset restores. For an intentional migration, a host may configure `authorizeCrossDatasetImport(req, { sourceDataset, targetDataset })` on the CmsFn server; only explicit `true` permits it, after the target dataset and role checks. The source name is untrusted artifact provenance; it never chooses the write target or grants access. The callback receives the original request so the host can apply its existing identity/session policy. Import may overwrite existing target documents/schema and is never retried automatically after an uncertain transport failure.

Hosts should await the server’s initial `readiness` promise before marking Studio ready; Content-backed operations also perform feature-specific capability checks. See `../server/README.md`.

Automatic release scheduling requires the schema migration and trusted host execution described in `../server/README.md`; the document history view is described below. Media/preview are already mounted in the editor but broader native acceptance remains separate; diff UI is explicitly optional. See `../.conduct/studio-singleton-readiness.md` for singleton acceptance, `../.conduct/studio-lifecycle-readiness.md` for current verified behavior and `../.conduct/studio-packaging-readiness.md` for the preceding packaging checkpoint.

## Document history

Every opened document has a History control. It requests the configured
ContentFn `/contentfn/docs/history` endpoint and displays full immutable draft
and published snapshots, newest first, with revision identity and timestamp.
“Older revisions” replaces the current 20-row page; Refresh returns to the newest
page. View snapshot expands the full JSON content, rendered as text. This viewer
does not restore revisions or provide a diff editor.

Hosts must authorize ContentFn's `docs.history` action for the current caller;
this action exposes private draft history, independently of document-read access.
HTTP 401/403 and permission-denied envelopes show “No access” and clear all
snapshots. Dataset/document changes cancel requests and remove old results.
Requests time out after 10 seconds. Each response is limited to 2 MiB before JSON
parsing. Overflow retries the same cursor with limits 20, 10, 5, 2, then 1,
sharing the original deadline; no revision is skipped. A single oversized
snapshot or malformed page fails visibly rather than showing partial data.
The default fetch credential policy applies; configure the normal same-origin
proxy/session integration for the ContentFn API.

Requires ContentFn's versioned document-bound history cursors (checkpoint
`3b87a303d8c37a22ba1b08bad6b9cbfb2c65a8bc`, sf-next PR 56). Legacy cursor pages
must restart. ContentFn checkpoint `6fb4c5660fd8bfbe13565565aa3b76f551f1d277` adds compact
scope-hashed cursors and the explicit ordered-index migration hook. Hosts must
implement and run that hook; populated SQLite plans are verified. PostgreSQL/MySQL
index-entry limits and plans remain separate readiness gates.

### Media library

Media pages follow ContentFn's `createdAt` descending, then `assetId` ascending order.
Each page contains at most 50 assets; next/previous navigation replaces the current page.
This is the producer's offset pagination, not a stable snapshot: concurrent uploads or
deletions can shift page boundaries. Refresh returns to the newest page.

`limits.maxUploadBytes` bounds decoded file bytes and is checked against `File.size`
before reading or encoding. Studio defaults to 1 MiB when it is omitted and rejects
invalid nonpositive/noninteger limits. The producer independently enforces its decoded
asset limit and the encoded JSON request limit. Configure the latter for base64 expansion
and metadata; a file passing Studio's check can still exceed a stricter host request
limit. Uploads are not automatically retried after an uncertain network outcome.

File names and MIME metadata are length-bounded; names are rendered as text, never HTML.
Media responses are validated and limited to 2 MiB with a ten-second request deadline.
Access denial removes prior rows. Dataset, endpoint and document changes cancel pending
work and prevent stale selections. Nested object asset fields use literal schema keys,
preserve siblings and reject prototype keys or array traversal. Array-item media editing
is not added by this object-field integration.
