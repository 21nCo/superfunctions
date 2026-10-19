# LangFn documentation site

This SvelteKit site uses DocsFn and documents the current TypeScript source. Consumer guides live in `content/docs`; references mirror the TypeScript README, provider matrix, and release-gate notes.

Prepare repository-owned dependencies and build from the repository root:

```sh
npm exec -- turbo run build --filter=@langfn/docs
```

The site resolves its declared public SearchFn/DocsFn dependencies. It does not substitute SearchFn workspace source aliases or prepare missing public `dist` exports during an ordinary direct Vite invocation.

After prerequisites are prepared, run from the repository root:

```sh
npm --workspace @langfn/docs run dev
npm --workspace @langfn/docs run generate:llms
npm --workspace @langfn/docs run check:llms
npm exec --workspace @langfn/docs -- docsfn validate --root .
```

The native build regenerates `static/llms.txt` and `static/llms-full.txt`. The site defaults to port 6018; documentation and the LLM resources (`/docs/llms.txt`, `/docs/llms-full.txt`) live under `/docs`.

Public-origin configuration is applied only when `CLOUDFLARE_DOCS_DEPLOY=1`. `CLOUDFLARE_DOCS_PUBLIC_ORIGIN` names the public receiver independently of `CLOUDFLARE_DOCS_ASSETS_ORIGIN`.
