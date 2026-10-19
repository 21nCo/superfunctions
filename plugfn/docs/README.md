# PlugFn documentation site

This SvelteKit site uses DocsFn. Consumer guides live in `content/docs`; the original Markdown guides remain at their existing paths under `plugfn/docs`.

From the repository root:

```sh
npm --workspace @plugfn/docs run dev
npm --workspace @plugfn/docs run build
```

The build regenerates `static/llms.txt` and `static/llms-full.txt`. For CLI validation, first build the SearchFn workspace dependencies from the repository root (the Vite site build uses source aliases and does not require these separate builds):

```sh
npm run build --workspace @searchfn/core
npm run build --workspace @searchfn/adapter-contracts
npm run build --workspace @searchfn/adapter-memory
npm run build --workspace @searchfn/adapter-indexeddb
npm run build --workspace @searchfn/client
npm exec --workspace @plugfn/docs -- docsfn validate --root .
```

The site defaults to port 6023. `site.canonicalUrl` is set from `CLOUDFLARE_DOCS_PUBLIC_ORIGIN` only when `CLOUDFLARE_DOCS_DEPLOY=1` (the Cloudflare docs deploy sets both), independently of the asset/CDN origin. Local builds leave it unset.

The LLM resources are served at `/docs/llms.txt` and `/docs/llms-full.txt` so they stay inside the shared docs Worker route. Without a canonical origin (the committed artifacts), generated page links point to their source files on GitHub (`blob/dev`) and the full corpus's page-index footer points to the GitHub copy of `static/llms.txt`. Deploy builds resolve page links and the footer against the public origin. Both mounted `/docs/llms*` endpoints and legacy root static resources use the same generated files; Cloudflare routes only the `/docs*` prefix, so root static compatibility does not change public-root routing.

CI checks both committed reference mirrors and LLM artifacts before Build can regenerate them; developer prebuild regeneration remains available.
