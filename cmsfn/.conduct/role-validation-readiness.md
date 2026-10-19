# Runtime role-rule validation

2026-10-19 UTC. Bounded follow-up to role authorization/body limits and CmsFn-owned storage schemas.

## Correctness issue and behavior

Permission evaluation previously trusted the TypeScript shape and called `.includes()` on selectors/actions directly. A malformed deployment-supplied role with `datasets: "production"` and `actions: "doc.publish.extra"` could therefore permit dataset `prod` and action `doc.publish` through substring matching. Storage validation also accepted arrays with arbitrary element types and unknown actions.

Core now exports `validateCmsfnRole`, shared by storage upserts and permission evaluation. It requires plain role/rule objects with their own data properties, string IDs/names, a rule array, wildcard scalars or arrays of nonblank string selectors, and wildcard scalars or arrays containing only the documented actions. Sparse arrays, nulls, numbers, nested objects, unknown actions and wildcard array actions are rejected. Empty rule/selector/action arrays remain valid and grant nothing. Selector strings retain exact matching; whitespace is not trimmed into a broader selector. IDs and names retain the existing trim normalization.

Validation copies only the documented fields and detaches selector arrays. All rules in a role must be valid before that role may grant access. A different valid role can still grant access under the existing any-role semantics. Permission evaluation also rejects unknown requested actions and non-array role collections. Persisted legacy or deployment-supplied malformed roles consequently cannot bypass validation by avoiding the upsert endpoint.

Storage rejects malformed roles before database reads or writes and returns `VALIDATION_FAILED` with a field path. HTTP behavior retains the existing envelope transport. Existing valid wildcard and exact-match contracts are preserved.

## Validation

```sh
npm test --workspace=./cmsfn/core --workspace=./cmsfn/server
npm run typecheck --workspace=./cmsfn/core
node node_modules/typescript/bin/tsc -p cmsfn/server/tsconfig.storage.json
node node_modules/typescript/bin/tsc -p cmsfn/server/tsconfig.roles.json
npm run build --workspace=./cmsfn/core --workspace=./cmsfn/server
```

- Core: 46 tests passed. Server: 70 tests passed, including the native SQLite persistence contract.
- Added 22 core adversarial/contract cases, five storage cases asserting no DB access or mutation, and six real HTTP cases. The HTTP publish regression specifically rejects the former substring-match authorization path through `getRolesForSubject`.
- Core typecheck, strict scoped storage/role checks (`skipLibCheck: false`), and ESM/CJS/declaration builds pass.
- Node 18.18 built CJS rejects the malformed substring role and loads the server successfully.
- Full server typecheck retains exactly the same normalized 145 diagnostics as the pre-change baseline; no full package typecheck pass is claimed.

## Remaining original requirements

This does not establish identity verification inside deployment callbacks, complete authorization/body protection for other endpoints, policy checks against configured dataset/type registries, audit identity completeness, concurrent mutation guarantees, release scheduling, studio workflows, native-JSON SQL compatibility/migrations, other database providers, live ContentFn integration, or the packed declaration-consumer matrix. Those original CmsFn gates remain open.
