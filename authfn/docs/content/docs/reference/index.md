---
title: Reference
description: The reference for the kernel and the plugins documented here — routes, errors, events, tables, envelopes, and configuration options.
---

# Reference

This section is the index of the public surface of the authfn kernel and the plugins documented under [Plugins](../plugins). `@authfn/oauth-provider` is not covered here; its routes and tables are documented in its [package README](https://github.com/21nCo/superfunctions/blob/dev/authfn/oauth-provider/README.md). The content here is auto-generated from the source where possible (OpenAPI, schema generator, error / event types) and hand-curated where it isn't (envelopes, configuration).

| Section | What's there |
| --- | --- |
| [HTTP routes](./routes) | Each operation of the kernel and the documented plugins: method + path + envelope + plugin. |
| [Error codes](./errors) | All error codes with HTTP statuses, retryability, and details payloads. |
| [Observability events](./events) | All event types with metadata schemas. |
| [Database schema](./schema) | The tables and columns `@superfunctions/cli generate-schema` generates for the kernel and the documented plugins. |
| [Envelopes](./envelopes) | Success and error envelope shapes. |
| [Configuration](./configuration) | All `authfn()` and `createServer()` options. |
| [Changelog](./changelog) | Release history. |

For an interactive, swagger-style API reference, see the [API Reference](../api) section instead.
