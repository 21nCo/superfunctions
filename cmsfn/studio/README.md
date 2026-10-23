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

Automatic release scheduling, startup/operation capability enforcement and the specified history view remain incomplete. Media/preview are already mounted in the editor but broader native acceptance remains separate; diff UI is explicitly optional. See `../.conduct/studio-singleton-readiness.md` for singleton acceptance, `../.conduct/studio-lifecycle-readiness.md` for current verified behavior and `../.conduct/studio-packaging-readiness.md` for the preceding packaging checkpoint.
