# MailFn documentation site

This SvelteKit site uses DocsFn. Consumer guides live in `content/docs`; references mirror the source specification, threat model, operations guide, and package READMEs. Keep both copies aligned when changing a MailFn contract.

Prepare repository-owned dependencies and build from the repository root:

```sh
npm exec -- turbo run build --filter=@mailfn/docs
```

The site resolves its declared public SearchFn/DocsFn dependencies. It does not substitute SearchFn workspace source aliases or prepare missing public `dist` exports during an ordinary direct Vite invocation, so run the Turbo build above (which builds those workspace dependencies first) before using the commands below on a fresh checkout.

After prerequisites are prepared, run from the repository root:

```sh
npm --workspace @mailfn/docs run dev
npm --workspace @mailfn/docs run generate:llms
npm --workspace @mailfn/docs run check:llms
npm exec --workspace @mailfn/docs -- docsfn validate --root .
```

The build regenerates `static/llms.txt` and `static/llms-full.txt`. The site defaults to port 6019. The public documentation route is `/docs`.

The LLM resources are served at `/docs/llms.txt` and `/docs/llms-full.txt` so they stay inside the shared docs Worker route. Until a public host is serving the site, generated indexes link to the repository source pages.
