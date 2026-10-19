# MDFN documentation site

This SvelteKit site uses DocsFn. Consumer guides live in `content/docs`; the package reference mirrors source READMEs.

From the repository root:

```sh
npm --workspace @mdfn/docs run dev
npm --workspace @mdfn/docs run build
```

The build regenerates `static/llms.txt` and `static/llms-full.txt`. For CLI validation, first build the SearchFn workspace dependencies from the repository root (the Vite site build uses source aliases and does not require these separate builds):

```sh
npm run build --workspace @searchfn/core
npm run build --workspace @searchfn/adapter-contracts
npm run build --workspace @searchfn/adapter-memory
npm run build --workspace @searchfn/adapter-indexeddb
npm run build --workspace @searchfn/client
npm run validate --workspace=@mdfn/docs
```

The site defaults to port 6022. Set `site.canonicalUrl` once the public docs host serves these routes.

The LLM resources are served at `/docs/llms.txt` and `/docs/llms-full.txt` so they stay inside the shared docs Worker route. Until the public docs host is live, generated page links point to the source files on GitHub at ref `dev`; the full corpus refers to the index as `/docs/llms.txt`. Cloudflare deploy builds (`CLOUDFLARE_DOCS_DEPLOY=1`) use `CLOUDFLARE_DOCS_PUBLIC_ORIGIN` for absolute page links instead; without `CLOUDFLARE_DOCS_DEPLOY=1` that origin is ignored. CI checks committed corpora before prebuild regeneration can hide drift.
