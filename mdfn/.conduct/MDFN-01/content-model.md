# MDFN-01 Content Model

## Canonical boundary

The canonical value is UTF-8 Markdown source plus a versioned sidecar. The source hash, extension schema hash, diagnostics, and optional projected document form an exportable snapshot. Selection and transient view state are not canonical content.

## Document model

`MdfnDocument` is a typed tree rooted at `doc`. Nodes carry a type, optional stable identifier, attributes, marks, children or text, and an optional `SourceSpan`. A source span stores UTF-16 offsets, raw source, syntax metadata, a preservation level, and dirty state.

The baseline is CommonMark. GFM tables, task lists, strikethrough, and autolinks are enabled by the default profile. Extension nodes share the same tree and preservation protocol.

## Preservation levels

- Exact: untouched source is returned byte-for-byte, including whitespace, line endings, fence choices, and equivalent syntax choices.
- Semantic: supported edited content retains meaning while the touched region may normalize.
- Opaque: unsupported or disabled constructs retain raw source and remain uneditable until an extension owns them.

The serializer first returns the original source for a clean document, then attempts descending-offset top-level region patches for dirty nodes, and only performs whole-document semantic serialization when source mapping is no longer sound. Every fallback emits a diagnostic.

## Sidecar

Comments, suggestions, asset metadata, and a history reference live in `MdfnSidecar`. Anchors are source ranges mapped through every transaction. Accepted edits update source; rejected suggestions stay as history until removed. Collaboration synchronizes source and sidecar through the same controller boundary.

## Snapshots and migrations

Snapshots are versioned, source-hashed, and schema-hashed. A matching extension schema may restore the projected document directly. A mismatch reparses canonical source and allows registered extension migrations to advance schema versions deterministically.

## Limits

Parsers and renderers enforce bytes, token length, node count, tree depth, output size, and URL policy limits. Limit failures are explicit and never produce partial authoritative content.
