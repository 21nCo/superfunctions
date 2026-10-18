# @testfn/admin

Node.js 20+ administration capability for TestFn using `@superfunctions/admin`. Register `createTestFnDomainAdminAdapter({resolve})` in the shared registry and use the shared dispatcher or HTTP/MCP projection. The resolver supplies a runner, storage, visual tester and environment for the authorized project scope.

Each bound runner/storage/visual object is claimed by its complete installation, workspace, project, environment, namespace and region scope. Reusing those objects across scopes is rejected. Backend credentials and test definitions remain controlled by the host; an admin request cannot supply a command, test path, browser executable or filesystem path.

Run lists expose the most recent records with a bounded `limit` (default50, maximum200); this API does not advertise cursor pagination. Result projections expose statuses and artifact IDs/types, while private artifact paths, bytes, errors and logs stay out of admin responses. Obtain artifact IDs from `item.results[].artifactIds`.

The shared dispatcher enforces permissions, audit and mutation idempotency. Retention cleanup and baseline updates require confirmation. Comparison explicitly disables automatic baseline replacement even if the resolved visual tester enables it. Approval-required baseline stores continue to stage proposals; approval is performed through the host-controlled `BaselineManager` workflow.
