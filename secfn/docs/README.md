# SecFn documentation site

This SvelteKit site uses DocsFn. Consumer guides live in `content/docs`; the core, server, and runtime reference pages are generated from those packages' READMEs.

Prepare repository-owned dependencies and build from the repository root:

```sh
npm exec -- turbo run build --filter=@secfn/docs
```

The filtered Turbo build prepares declared workspace dependency exports before building the site. The site resolves its declared public SearchFn/DocsFn dependencies; it does not substitute SearchFn workspace source aliases, so a direct Vite invocation needs those exports prepared first.

After prerequisites are prepared, run from the repository root:

```sh
npm --workspace @secfn/docs run dev
npm --workspace @secfn/docs run generate:references
npm --workspace @secfn/docs run generate:llms
npm --workspace @secfn/docs run check:references
npm --workspace @secfn/docs run check:llms
npm exec --workspace @secfn/docs -- docsfn validate --root .
```

To change a reference page, edit the core, server, or runtime README and run `generate:references`, then `generate:llms`. The build regenerates the reference mirrors, `static/llms.txt`, and `static/llms-full.txt`; the package test runs both checks, which reject stale committed bytes without rewriting them. The site defaults to port 6016; documentation and the LLM-resource routes live under `/docs`.

Public-origin configuration is applied only when `CLOUDFLARE_DOCS_DEPLOY=1`. `CLOUDFLARE_DOCS_PUBLIC_ORIGIN` names the public receiver independently of `CLOUDFLARE_DOCS_ASSETS_ORIGIN`. Without a public origin, generated page links in the committed LLM artifacts point to their source files on the `dev` branch on GitHub.
