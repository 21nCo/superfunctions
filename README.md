<div align="center">
  <h1>Super functions</h1>
  <p>Self deployed super stack for building modern software.</p>
</div>
<div align="center">

[![Status: Alpha](https://img.shields.io/badge/status-alpha-orange.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](/LICENSE)
[![Discord](https://img.shields.io/discord/831815510563749889?logo=discord&logoColor=white)](https://discord.com/invite/9HJqKYTZKg)

</div>

> [!WARNING]
> **Alpha software**.
> Super functions is currently in alpha and is not yet fully ready for production use. APIs and behavior may change without notice, and some features may be incomplete or unstable. Evaluate it carefully and use it at your own risk.

# Contributor runtime

Use Node.js 20.19+ or 22.12+ for the root test tools. MailFn Cloudflare workerd tests require Node.js 22.12+; the release workflow uses Node 22. Individual published packages retain their own runtime requirements, including separately tested Node 18 consumers.

`npm run test:ui` runs the three DocsFn projects selected by the root Vitest config. For a scoped checkout, install `@docsfn/svelte`, `@docsfn/sveltekit`, and `@docsfn/example-sveltekit-docs-site` with `--include-workspace-root`, then build their dependencies with Turbo before launching. The UI launcher bootstraps npm 11.21.0 and keeps matching Vitest/UI 4.1.12 and jsdom 27.4.0 in an isolated npm cache tree; npm 10's optional-peer resolver fails for this combination. It preserves the caller's working directory and forwards arguments after `--`. It does not change the npm version or dependencies globally.

UI shutdown terminates its owned process group on POSIX and uses `taskkill /PID /T /F` on Windows. Windows users must launch through `npm run test:ui`; Windows process-tree cleanup has not been validated on a Windows host. Cleanup failures are reported instead of claiming success. See [_conduct/vitest4-default-docs-ui.md](_conduct/vitest4-default-docs-ui.md) for exact install, validation, and remaining compatibility limits.

# Functions

## Data and storage

| Function | Description |
| --- | --- |
| dataFn | Full stack data management framework with offline-first sync, reactive signals, sharing capability, and auto REST API.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@datafn/client) · [PyPI](https://pypi.org/project/datafn/) |
| fileFn | Complete file management with resumability, multi-part uploads, security, processing, versioning, storage quota and analytics.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@filefn/client) · [PyPI](https://pypi.org/project/filefn/) |
| searchFn | Adapter-first full-text search for browser, native mobile apps and server with offline IndexedDB and DataFn integration.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@searchfn/client) |

## Application core

| Function | Description |
| --- | --- |
| authFn | Drop-in authentication and user management. Social logins, magic links, session handling, AI agent authentication and more.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@authfn/client) · [PyPI](https://pypi.org/project/authfn/) |
| billFn | Complete billing infrastructure. Subscriptions, one-time payments, usage-based billing, analytics, store integrations and invoicing.<br><br>**Packages:** [npm](https://www.npmjs.com/package/billfn) |
| [mcpFn](./mcpfn/README.md) | Build and regression-test MCP servers with protocol contracts, OAuth/API-key testkits, Playwright auth fixtures, host profiles, official conformance, and safe DataFn exposure.<br><br>**Packages:** `@mcpfn/core` · `@mcpfn/auth` · `@mcpfn/testing` · `@mcpfn/datafn` · `@mcpfn/cli` |
| plugFn | Universal API integration SDK. Connect to third-party services with a standardized interface and automatic auth handling.<br><br>**Packages:** [npm](https://www.npmjs.com/package/plugfn) |

## User interface

| Function | Description |
| --- | --- |
| [uiFn](./uifn) | Reusable frontend component primitives, themes, framework adapters, catalogs, registry delivery, and design-system tooling.<br><br>**Packages:** `@uifn/*` |
| docFn | AI native documentation platform.<br><br>**Packages:** [npm](https://www.npmjs.com/package/docfn) |

## Infrastructure and meta

| Function | Description | Packages |
| --- | --- | --- |
| [Super Console](./superconsole) | Self-hosted, UIFn-powered operator control plane for an explicitly selected set of Superfunctions, with one capability registry projected to UI, REST/OpenAPI, TypeScript, and McpFn. | `superconsole` · `@superfunctions/admin` · function-owned `@*fn/admin` packages |
| [hostFn](./hostfn) | Hosting and deployment tooling for projects, environments and providers. | [npm](https://www.npmjs.com/package/hostfn) |
| [extFn](./extfn) | Cross-framework extension development with hot reload, bundling, scanning and publishing. | [npm](https://www.npmjs.com/org/extfn) |
| [apiFn](./apifn) | API design, exploration, testing and documentation tooling. | [npm](https://www.npmjs.com/org/apifn) |

## Contributing

Due to the current size of our team, we are not accepting external contributions at this time. We appreciate your interest and understanding.

### License

This project is licensed under the MIT license. See the [LICENSE](LICENSE) file for details.

### Contact

For any questions, security reporting or feedback, please contact us at [hello@21n.co](mailto:hello@21n.co).

❤️ We extend our deepest gratitude to all the [OSS libraries and tools](https://github.com/21nCo/super-functions/network/dependencies) that made this project possible.
