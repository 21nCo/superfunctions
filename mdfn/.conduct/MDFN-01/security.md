# MDFN-01 Security Contract

Raw HTML is disabled by default and preserved as an opaque node. Opt-in rendering requires a host-provided sanitizer; no package ships an implicit bypass. The renderer escapes text/attributes, blocks dangerous schemes, allows only explicit URL schemes, adds safe external-link relations, and enforces output/node/depth limits.

Paste enters through the DOM package policy before ProseMirror interprets it. Source parsing has byte, token, node, and depth limits. Rendering has output limits. Server writes reparse source and reject invalid/oversized input before persistence.

Collaboration updates may pass through an async authorization hook. A document stores its schema hash in shared metadata; mismatched clients fail before binding. Presence is ephemeral and cannot grant authorization. Server collaboration routes authorize both reads and writes.

AI output is untrusted data. It must be a source range replacement inside an optional host-approved range and size limit. It becomes either a reviewable sidecar suggestion or a normal editor transaction; generated code is never executed.

The server authorizes create/read/update/delete/history/collaborate separately, supports tenant scoping, returns non-sensitive error codes, uses optimistic versions and idempotency receipts, and exposes no database adapter internals. Assets retain explicit media type/size/document association; providers control storage URLs and access.

Security tests cover script/raw HTML, event attributes, dangerous URLs, malformed Markdown, parser/render limits, collaboration authorization, schema mismatch, AI range enforcement, and server version conflicts.
