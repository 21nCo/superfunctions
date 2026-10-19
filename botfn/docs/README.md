# BotFn documentation site

This SvelteKit site uses DocsFn. Consumer guides and source-aligned references live in `content/docs`. Keep these pages aligned with the packages under `botfn/<pkg>` and with `botfn/README.md`.

Prepare repository-owned dependencies and build from the repository root:

```sh
npm exec -- turbo run build --filter=@superfunctions/botfn-docs
```

The site resolves its declared public SearchFn/DocsFn dependencies. It does not substitute SearchFn workspace source aliases or prepare missing public `dist` exports during an ordinary direct Vite invocation.

After prerequisites are prepared, run from the repository root:

```sh
npm --workspace @superfunctions/botfn-docs run dev
npm --workspace @superfunctions/botfn-docs run generate:llms
npm --workspace @superfunctions/botfn-docs run check:llms
npm exec --workspace @superfunctions/botfn-docs -- docsfn validate --root .
```

The native build regenerates `static/llms.txt` and `static/llms-full.txt`. The site defaults to port 6013; documentation and the native LLM-resource routes live under `/docs`. The development host is `https://botfn.21n.site/docs` and the live host is `https://botfn.com/docs`.

Public-origin configuration is applied only when `CLOUDFLARE_DOCS_DEPLOY=1`. `CLOUDFLARE_DOCS_PUBLIC_ORIGIN` names the public receiver independently of `CLOUDFLARE_DOCS_ASSETS_ORIGIN`. Without a public origin, the generated LLM files link each page to its Markdown source on GitHub. A successful local build does not prove live Worker execution or domain readiness.
