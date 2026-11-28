# superfunctions

The Superfunctions command line. This package is the front door to
[`@superfunctions/cli`](https://www.npmjs.com/package/@superfunctions/cli):
its `superfunctions` command, and the `sfs` alias, run that CLI at exactly this
package's version.

```bash
npx superfunctions --help
npx superfunctions status
npx superfunctions generate-migration
```

`npx sfs` looks for an npm package named `sfs`, so use the alias once the
package is installed, or name the package for npx:

```bash
npm install --save-dev superfunctions
npx superfunctions init
npx sfs status
npm exec --package=superfunctions -- sfs --version
```

The commands, options and configuration are those of `@superfunctions/cli`;
see its README. To import the CLI's helpers (such as `defineConfig`), import
`@superfunctions/cli`. This package exports no modules: it is never a barrel of
the Superfunctions libraries, which you install by their scoped names.

## Moving from `@superfunctions/cli`

`@superfunctions/cli` provides the same `superfunctions` and `sfs` commands. If
a project depends on both packages directly at different versions, npm links
those commands to one of them, possibly the older scoped CLI. Remove the direct
`@superfunctions/cli` dependency when you add `superfunctions`, or keep the two at
the same version.
