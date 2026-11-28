# superfunctions

The Superfunctions command line. This package is the front door to
[`@superfunctions/cli`](https://www.npmjs.com/package/@superfunctions/cli):
`superfunctions` and `sfs` run that CLI at exactly this package's version.

```bash
npx superfunctions --help
npx superfunctions status
npx sfs migrate
```

Or install it in a project:

```bash
npm install --save-dev superfunctions
npx superfunctions init
```

The commands, options and configuration are those of `@superfunctions/cli`;
see its README. To import the CLI's helpers (such as `defineConfig`), import
`@superfunctions/cli`. This package exports no modules: it is never a barrel of
the Superfunctions libraries, which you install by their scoped names.
