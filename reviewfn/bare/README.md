# reviewfn

ReviewFn, evidence-backed pull request review. This is its front door:

- `npx reviewfn <command>` runs [`@superfunctions/reviewfn-cli`](https://www.npmjs.com/package/@superfunctions/reviewfn-cli)
  at exactly this package's version, so `npx reviewfn help` lists the commands.
- `import { ReviewCoordinator } from "reviewfn"` gives
  [`@superfunctions/reviewfn-core`](https://www.npmjs.com/package/@superfunctions/reviewfn-core),
  pinned to the same version.

Installing `reviewfn` as a library installs only the core. The command fetches
the CLI the first time it runs, as `npx` would, unless the same CLI version is
already installed. The scoped `@superfunctions/reviewfn-*` packages stay the way
to install a single part (a harness, the GitHub integration, the testing kit).
See the [ReviewFn README](https://github.com/21nCo/superfunctions/tree/dev/reviewfn#readme).
