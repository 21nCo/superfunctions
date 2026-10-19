# CliFn documentation site

This SvelteKit site uses DocsFn. Consumer guides and subpath references live in `content/docs` and should be updated with changes to the public `@clifn/core` exports.

From the repository root:

```sh
npm --workspace @clifn/docs run dev
npm --workspace @clifn/docs run build
```

The build regenerates `static/llms.txt` and `static/llms-full.txt`. In a workspace checkout, build through Turbo so the SearchFn workspaces the site imports are built first, then validate:

```sh
npm exec -- turbo run build --filter=@clifn/docs...
npm exec --workspace @clifn/docs -- docsfn validate --root .
```

The site defaults to port 6011. The public documentation route is `/docs`.

The LLM resources are served at `/docs/llms.txt` and `/docs/llms-full.txt`.
