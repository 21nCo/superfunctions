# SendFn documentation site

This SvelteKit site uses DocsFn. Consumer guides live in `content/docs`; package references mirror the current source READMEs (`../typescript/README.md` and `../python/README.md`).

Prepare repository-owned dependencies and build from the repository root:

```sh
npm exec -- turbo run build --filter=@sendfn/docs
```

The site resolves its declared public SearchFn/DocsFn dependencies. It does not substitute SearchFn workspace source aliases or prepare missing public `dist` exports during an ordinary direct Vite invocation.

After prerequisites are prepared, run from the repository root:

```sh
npm --workspace @sendfn/docs run dev
npm --workspace @sendfn/docs run generate:references
npm --workspace @sendfn/docs run generate:llms
npm exec --workspace @sendfn/docs -- docsfn validate --root .
```

Run `generate:references` after editing either source README. The workspace `test` script runs the nonwriting `check:references` and `check:llms` commands; the build's prebuild regenerates `static/llms.txt` and `static/llms-full.txt`. The site defaults to port 6021; documentation and the LLM resources (`/docs/llms.txt`, `/docs/llms-full.txt`) live under `/docs`, inside the docs Worker's `/docs*` route. `/` is a local-preview compatibility route, not a claim that the Worker owns the deployed host root.

Public-origin configuration is applied only when `CLOUDFLARE_DOCS_DEPLOY=1`: `CLOUDFLARE_DOCS_PUBLIC_ORIGIN` names the public origin, including scheme (`https://sendfn.21n.site` for dev, `https://sendfn.com` for live). Without it, generated LLM page links point to the source files on GitHub.
