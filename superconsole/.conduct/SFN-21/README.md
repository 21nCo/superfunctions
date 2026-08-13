# SFN-21 — Super Console

This bundle is the source-controlled architecture and delivery record for [SFN-21](https://linear.app/21n/issue/SFN-21/build-super-console-as-the-modular-self-hosted-administration-control).

Super Console is the self-hosted operator control plane for a consumer-selected set of Superfunctions. A deployment registers modules explicitly. That registry is the only source for console navigation, server dispatch, REST/OpenAPI, the TypeScript admin client, and McpFn tool discovery. A function that is not registered is absent from every surface.

## Binding decisions

- Product and directory: **Super Console**, `superconsole/`.
- Runtime: self-hosted SvelteKit.
- Visual system: Tailwind configured through UIFn, with `@uifn/components-svelte` as the component boundary.
- UIFn defects or missing primitives are fixed in UIFn; local substitutes and secondary component libraries are prohibited.
- Relevant Superfunctions must power their corresponding console concern instead of local reimplementations.
- Operator administration stays separate from customer portals and embedded product UI.
- Each function owns its administration service interface and capability manifest.
- REST is versioned and language-neutral; OpenAPI is generated from enabled capabilities.
- `@superfunctions/admin` provides the language-neutral REST transport client and a manifest-derived TypeScript capability client with exact operation IDs, runtime availability discovery, and cursor iteration. Domain-backed function packages additionally publish typed operation maps and direct domain-adapter factories.
- McpFn projects enabled capabilities to MCP; mutations use the same scope, policy, validation, idempotency, and audit path as REST.
- Tenancy is installation → workspace → project → environment. `organizationId` remains a compatibility alias for the installation root.
- CatchFn and LogFn are nested under WatchFn. ContentFn is folded into CmsFn and cannot be enabled independently.
- CiFn's existing React dashboard behavior is migrated into the SvelteKit shell.
- Delivery remains local in coherent commits; no push or pull request is part of SFN-21.

## Base integration

The work began from fetched `sf-next/next` at `8dddd865ee9b86571c70db87efd918152cf682fb`. At the user's direction, fetched `origin/dev` at `04230e1462d85fe7aa0157fa26eca707681872ee` was merged into local `next`. The resulting base is `da0720a508eb86e3680f433dee17474670c41b27`.

The separate `dev` worktree contains uncommitted AuthFn, DataFn, FileFn, SearchFn, database, HTTP, storage, delivery, and observability work. It is treated as read-only forward-compatibility input. None of those user-owned changes are moved, staged, modified, or committed by SFN-21.

## Document map

- [Product rationale](product-rationale.md)
- [Architecture](architecture.md)
- [Capability inventory](capability-inventory.md)
- [Module contract](module-contract.md)
- [REST and OpenAPI](rest-openapi.md)
- [TypeScript SDK](typescript-sdk.md)
- [MCP](mcp.md)
- [Security, tenancy, and RBAC](security-tenancy-rbac.md)
- [UIFn rules](uifn-rules.md)
- [CiFn migration](cifn-migration.md)
- [Testing](testing.md)
- [Self-hosting and operations](self-hosting-operations.md)
- [Delivery plan](delivery-plan.md)
- [Decisions](decisions.md)
- [Verification](verification.md)

The architecture and capability contract are normative. Verification records what was actually run and must be read before treating the branch as releasable.

An admin package is not considered available merely because it exists in the
workspace. Available modules must expose exact handlers backed by their public
domain service. Packages whose functions do not yet own a canonical operator
service are registered as `unavailable`, expose no operations/navigation, and
are rejected if a self-hoster attempts to enable them.
ContentFn is `folded` into CmsFn and cannot be enabled independently; this
prevents the old generic ContentFn package from duplicating CmsFn's real
ContentFnServer-backed resources.
