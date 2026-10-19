# FlowFn packed consumer checkpoint

Fresh tarballs from this sf-next checkout pass the runtime matrix on exact
Node20.0.0 (the declared floor), Node20.20.0 and Node22.23.3. Core ESM imports and
CommonJS require exercise memory queue processing, adapter exports and the shared
instrumentation registration. Admin ESM and CommonJS dynamic import exercise a
real shared dispatcher, queue listing and namespace rejection. Admin is an ESM
package; synchronous CommonJS require is not claimed.

The isolated consumer installs local observability0.0.1, HTTP0.3.1, MCP0.0.6,
shared admin0.1.5, FlowFn core0.0.2 and FlowFn admin0.1.0 tarballs without peer
bypass flags. A subsequent clean npm ci and npm ls --omit=dev --all succeed.
TypeScript5.9.3 and Node20 types are development dependencies. Strict declaration
consumers pass for Node16 and NodeNext resolution, including CommonJS dynamic
admin imports, without skipLibCheck. npm audit --omit=dev reports zero
vulnerabilities across all severities in the actual installed consumer graph.
The fixture and its installation are deleted in finally after success or failure.

Reproduce after building the local prerequisite/core/admin packages:

```sh
node flowfn/typescript/scripts/packed-consumer-acceptance.mjs
```

NPM_CLI optionally selects an explicit npm CLI file; this run used npm11.21.0 on
Node20.20.0. FLOWFN_NODE_VERSIONS can select comma-separated exact runtime versions;
the default is the three versions above. All Superfunctions dependencies used in
the test are supplied as local tarballs, not assumed published registry versions.

An initial declaration fixture omitted the required namespace option and failed
strict typing; the corrected fixture passed. No package implementation or export
defect was found, and no peer bypass or declaration suppression was introduced.

This validates packaging and the exercised runtime paths only. Native storage,
cloud providers, distributed recovery, partitions, persisted policy, full SDK
parity, throughput/latency and production deployment remain separate original
gates. The matrix does not establish every possible later Node release.
