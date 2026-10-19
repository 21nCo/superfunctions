# ReviewFn documentation site

This SvelteKit site uses DocsFn. Consumer guides live in `content/docs`; detailed reference pages mirror the existing Markdown guides in this directory to preserve repository links. Edit the source guides and run `npm run generate:references --workspace @reviewfn/docs`. The build runs the same generator before regenerating the LLM resources, so deployed pages always use the current guides. `npm run check:references --workspace @reviewfn/docs` is a manual, nonwriting check that the committed mirrors and the reference index labels are current; CI does not run it.

From the repository root:

```sh
npm exec -- turbo run build --filter=@reviewfn/docs
npm --workspace @reviewfn/docs run dev
```

The filtered Turbo build prepares declared workspace dependency exports before building the site and regenerating `static/llms.txt` and `static/llms-full.txt`. Vite and CLI consumers use those public exports, not SearchFn source aliases, so run the Turbo build before a direct `dev` or `build` on a fresh install. After that build, validate the site:

```sh
npm exec --workspace @reviewfn/docs -- docsfn validate --root .
```

The site defaults to port 6014. The public documentation route is `/docs`.

The LLM resources are served at `/docs/llms.txt` and `/docs/llms-full.txt`. Cloudflare builds set `CLOUDFLARE_DOCS_PUBLIC_ORIGIN`, and generated links and the full-text page-index pointer use that origin. Without a public origin, committed artifacts link to the source files on the GitHub `dev` branch.
