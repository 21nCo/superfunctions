# @compfn/admin

ESM administration capability for CompFn, on Node.js 20+. Bind `createCompFnDomainAdminService({ compfn, scope: { workspaceId } })` to a single workspace, or supply `resolveCompfn(context)` to select the authorized scope's isolated instance. Register `createCompFnAdminAdapter(service)` with the shared administration registry and dispatcher. The dispatcher enforces permissions, auditing, mutation idempotency and sensitive-field redaction; calling the domain service directly does not provide those protections.

Lists default to 50 records and accept limits from 1 to 200, `search`, `filter`, and `sort: [{ field, direction: 'asc' | 'desc' }]`. Supported fields are declared in the capability metadata. Controls support category and tag filters; evidence supports control/framework/type/since filters before the core 1000-record bound. Additional admin search/filter/sort operates on that bounded core collection; oversized core queries return an explicit error. Queries do not silently truncate.

Pagination uses signed keyset cursors bound to the resource, query and complete active scope (including namespace and region). Cursors expire after 15 minutes. The default random signing key is local to the service instance: restarts or another instance invalidate its cursors. Supply the same securely generated `cursorSecret` of at least 32 bytes to replicas that should share cursors; rotating the secret invalidates outstanding cursors. Do not use public or predictable secrets.

Pages reflect live data rather than a snapshot. Inserts, deletion or changes to sorting fields between requests can alter membership; the ID tie-breaker makes ordering deterministic for unchanged rows. Changing search, filters or sorting requires starting a new pagination sequence.

Evidence collection and reports both redact sensitive payload fields, including `value` and standard secret/token/password fields, through the shared dispatcher. Stored evidence remains intact. Reports are classified as sensitive. Application database migrations, tenant isolation, storage retention and external authorization policy remain deployment responsibilities.
