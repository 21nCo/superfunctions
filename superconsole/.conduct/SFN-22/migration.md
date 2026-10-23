# SFN-22 migration and rollback

## What changed

Super Console now derives its module catalog entirely from the
`AdminCapabilityAdapter` manifests supplied by the installation. The core no
longer exports or consults a fixed module catalog, named nesting table, or
product-specific routes. Any valid lowercase manifest ID can participate in
registry, navigation, generic resource pages, REST/OpenAPI, the generated
client, and MCP discovery.

`AdminResourceDefinition.presentation` is an optional, validated presentation
hint. It can identify list/detail read operations and configure title,
subtitle, status, columns, formats, and default sort for generic pages.
Authorization, validation, safety, audit, redaction, and confirmation remain
owned by the operation manifest and shared dispatcher.

Operator authentication in core is provider-neutral. AuthFn composition moved
to `@authfn/admin` as `createAuthFnOperatorAuth`, and provider-selected CSRF
cookie/header names are projected to the browser shell. Default OpenAPI
security scheme keys are now `operatorSession` and `operatorApiKey`.

## Upgrade

1. Supply every available function adapter in `adapters` and select deployable
   root manifests in `enabledModules`. Do not import a console catalog.
2. Express required dependencies, folded children, ownership, navigation, and
   display metadata in each function-owned manifest.
3. Replace imports of `createAuthFnOperatorAuth` from `superconsole/server`
   with `@authfn/admin`, or provide another `SuperConsoleOperatorAuth`.
4. Rename custom OpenAPI security scheme entries from `authFnSession` and
   `authFnApiKey` to the required provider-neutral keys `operatorSession` and
   `operatorApiKey`. The scheme values may still describe provider-specific
   cookies or headers.
5. Replace product-only console routes with generic resources/operations and,
   when useful, `resource.presentation`. Application-specific build-time routes
   may live in the host application, outside the core package.

No stored data migration is required. Existing admin operation IDs and API
routes remain authoritative unless a function manifest itself changes them.

## Compatibility and rollout

Roll out the new core and all changed function-owned adapters together. Before
deployment, compare the authorized registry, OpenAPI operation set, client
invocation set, and MCP tool set for the chosen manifests. Disabled or absent
manifests must produce no entries in any of those surfaces.

The source guard `npm run verify:function-agnostic --workspace=superconsole`
prevents concrete function identifiers and fixed-catalog symbols from being
reintroduced into runtime source.

## Rollback

Rollback is code/configuration-only: deploy the previous Super Console and
matching adapter versions, restore the prior installation module and OpenAPI
scheme keys, and remove any `presentation` metadata that the previous
`@superfunctions/admin` validator does not understand. No database reversal is
needed. Do not mix a previous core with newly renamed auth configuration.

## McpFn boundary decision

McpFn remains an optional transport integration in the first manifest-driven
delivery. Keeping the bridge beside the shared dispatcher preserves identical
scope, policy, validation, idempotency, confirmation, redaction, and audit
semantics across REST, client, and MCP exposure. Extracting an
`@superfunctions/admin-mcp` package is a compatible follow-up if independent
release cadence or dependency weight justifies it; that package must consume
the same registry/dispatcher rather than create a second authorization path.
