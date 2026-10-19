---
title: Rendering and security
description: Apply a rendering policy to untrusted Markdown.
---

`@mdfn/render` produces HTML or a render tree without a browser dependency. `renderHtml` disables raw HTML by default; enabling it requires an explicit sanitizer. Its HTML renderer rejects unsafe URL schemes and enforces resource limits. `renderTree` builds new node wrappers but reuses each input node's `attrs` object, and it does not sanitize URLs or enforce traversal limits. Tree consumers must validate the result before rendering it and must not mutate the returned attributes unless they own the input tree.

Treat Markdown imports, extension output, asset URLs, and AI suggestions as untrusted data. Render with an appropriate policy for the destination and inspect diagnostics before publishing. Do not bypass the renderer with raw HTML from a document or sidecar.

See [render](/docs/reference/render), [core](/docs/reference/core), [asset bridge](/docs/reference/filefn), and [AI bridge](/docs/reference/ai).
