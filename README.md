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

# Functions

## Data and storage

| Function | Description |
| --- | --- |
| dataFn | Full stack data management framework with offline-first sync, reactive signals, sharing capability, and auto REST API.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@datafn/client) · [PyPI](https://pypi.org/project/datafn/) |
| fileFn | Complete file management with resumability, multi-part uploads, security, processing, versioning, storage quota and analytics.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@filefn/client) · [PyPI](https://pypi.org/project/filefn/) |
| searchFn | Adapter-first full-text search for browser, native mobile apps and server with offline IndexedDB and DataFn integration.<br><br>**Packages:** [npm](https://www.npmjs.com/package/@searchfn/client) |

## Application core

| Function | Description | Comparable to | Packages |
| --- | --- | --- | --- |
| [authFn](https://authfn.com) | Drop-in authentication and user management. Social logins, magic links, session handling, AI agent authentication and more. | Clerk or Auth0 | [npm](https://www.npmjs.com/package/@authfn/client) · [PyPI](https://pypi.org/project/authfn/) |
| [billFn](https://billfn.com) | Complete billing infrastructure. Subscriptions, one-time payments, usage-based billing, analytics, store integrations and invoicing. | Stripe Billing + Metronome + RevenueCat | [npm](https://www.npmjs.com/package/billfn) |
| [mailFn](./mailfn) | Programmable real inboxes for products, agents, and deterministic email testing, with Cloudflare deployment and SendFn composition. | MailSlurp + Mailtrap Inbound + AgentMail | `mailfn` + `@mailfn/*` |
| [mcpFn](./mcpfn/README.md) | Build and regression-test MCP servers with full protocol contracts, OAuth/API-key testkits, Playwright auth fixtures, host profiles, official conformance, and safe DataFn exposure. | MCP SDK + contract testing | `@mcpfn/core` · `@mcpfn/auth` · `@mcpfn/testing` · `@mcpfn/datafn` · `@mcpfn/cli` |
| [plugFn](./plugfn) | Universal API integration SDK with standardized provider interfaces and managed authentication. | Nango + Pipedream Connect | [npm](https://www.npmjs.com/package/plugfn) |

## User interface

| Function | Description | Packages |
| --- | --- | --- |
| [uiFn](./uifn) | Reusable frontend component primitives, themes, catalogs and design-system tooling. | [npm](https://www.npmjs.com/package/uifn) |
| [docsFn](./docsfn) | AI-native documentation platform and reusable documentation UI. | [npm](https://www.npmjs.com/package/docsfn) |

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
