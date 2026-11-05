# FileFn client

The public client uploads files and retrieves FileFn metadata and download instructions.

### Bounded download descriptors

`downloadDescriptor` preserves the provider's URL and required download headers:

```ts
const controller = new AbortController();
const descriptor = await client.downloadDescriptor('file_123', {
  versionId: 'version_456',
  signal: controller.signal,
  timeoutMs: 10_000,
  maxResponseBytes: 65_536,
});
// descriptor: { url: string; headers?: Record<string, string> }
```

The version option uses the existing version-specific server route. Without it,
FileFn selects the current version. URLs may be relative proxy paths; this method
only returns instructions and never fetches the destination. Resolve relative URLs
against your trusted FileFn service and apply your own destination/credential
policy before downloading bytes. Treat returned headers and signed URLs as secrets.

The new method makes one request, with a default 10-second deadline covering auth
header resolution, response headers and body, and a 64-KiB limit on decoded response
bytes. The options accept positive safe integers (timeout at most 2,147,483,647 ms;
response limit at most 16 MiB). Redirects are rejected without following them.
Descriptor headers are limited to 64 entries and 16 KiB total UTF-8 name/value bytes;
URL strings are limited to 16,384 characters. IDs must be nonempty path segments of at most 4096 characters that the URL parser
preserves unchanged. Existing custom IDs such as `report:2026+final` are preserved;
separators, control characters and normalized dot segments are rejected. Current
server routes do not percent-decode IDs, so IDs that require URL encoding are not
silently rewritten. Invalid metadata,
provider bodies and authentication errors do not appear in thrown error text.
Timeout/abort cancels transport and the response reader is released before settlement.
An arbitrary host `getAuthHeaders` callback cannot be forcibly cancelled; late completion
is ignored and cannot start a request after the deadline. Runtime fetch implementations
must honor AbortSignal; this API does not impose a hard process deadline on arbitrary
custom fetch code. Existing `downloadUrl` and `downloadArtifact` string APIs retain
their behavior and do not inherit these new bounds.
