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

The current App lists published documents and loads their draft counterpart for editing. Draft-only discovery, editing published-only documents, and App-level unpublish state are still incomplete. Individual audit, release, and operational panes are not all integrated into this shell. See `../.conduct/studio-packaging-readiness.md` for exact validated behavior and remaining acceptance work.
