# Current packed runtime acceptance

The installed runtime fixture now expects physical schema version 4, matching the
webhook audit metadata migration, while retaining the exact 13-table assertion. Its
package list now includes the local shared observability prerequisite. Omitting that
package previously installed registry 0.0.1 with top-level await and caused CommonJS
server loading to fail before the schema assertion. This is a fixture correction;
production source and dependency manifests are unchanged.

`PATH=/opt/homebrew/opt/node@22/bin:$PATH python3
contentfn/.conduct/packed-acceptance.py` passed using fresh normal npm 11.21.0 installs:

- Node 20.19.0 core/server/client ESM and CommonJS loading, strict installed TypeScript
  consumers, actual loopback HTTP create/publish/read, query SSE snapshot/cancellation,
  schema version/table count, audit metadata, export and actual CLI readback.
- Node 20.19.0 installed admin capability contract.
- Node 18.18.0 core/client ESM and CommonJS imports and CLI version.
- Production-only dependency audits for core, admin and Node 18 consumers: zero
  vulnerabilities in each. No external providers or deployed services were called.

The first failed run is retained in `/tmp/content-packed-schema4.log`; the successful
matrix is `/tmp/content-packed-schema4-final.log`. Install logs and production audits
were copied to `/tmp/content-packed-schema4-{core,admin,node18}-{install.log,audit.json}`.
Both exact owned disposable consumer directories were removed and read back absent.
This acceptance does not rerun native database/provider suites or establish deployment
readiness. Published shared prerequisites remain required before releasing these packages.
