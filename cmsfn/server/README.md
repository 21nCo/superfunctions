# CmsFn HTTP server

`createCmsfnServer(config)` returns a Node HTTP server with an initial-startup `readiness` promise. Constructing or importing the server performs no network I/O. The first `listening` event starts a ContentFn capability probe. Hosts should await the promise before marking their service ready or routing Studio traffic:

```ts
const server = createCmsfnServer(config);
await new Promise<void>(resolve => server.listen(3000, resolve));
const readiness = await server.readiness;
if (!readiness.ok) {
  server.close();
  throw new Error(readiness.error.code);
}
```

Listening alone does not mean ContentFn is ready. The promise resolves to an envelope, including failures, rather than emitting an unhandled asynchronous server error. It records initial startup, not ongoing health. `GET /cmsfn/status` performs a fresh check, and each Content-backed operation checks the capabilities it needs after local authorization and input/dataset validation. Local role CRUD and release create/list/add remain usable during a ContentFn outage. Relevant operations fail with `CONTENTFN_UNAVAILABLE` before forwarding when the producer is incompatible or unavailable; subsequent requests can recover without restarting CMS.

Startup/status require `content.schema`, `content.docs`, `content.assets`, plus `content.realtime` when preview is enabled. Publish/unpublish/release-publish require docs; preview requires docs/realtime; events require audit; webhook history requires audit/webhooks; import/export require schema/docs/assets. Disabled preview does not probe on a token request. Declarations are coarse feature checks; endpoint envelopes still undergo their existing validation.

For a protected ContentFn status endpoint, configure `contentfnStatusHeaders: () => ({ authorization: serviceCredential })`. This is server-owned service identity, independent of incoming browser headers and operation-specific audit/ops credentials. The resolver and HTTP/body read each have a two-second deadline. Status responses are limited to 64 KiB, malformed/non-success bodies fail closed, and redirects are rejected. Closing the server aborts in-flight lifecycle/operation status probes. The host owns any side effects inside its credential resolver.

See `../.conduct/status-capability-readiness.md` for evidence and remaining requirements. Automatic release scheduling, history and deployment acceptance are separate work.
