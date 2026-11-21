---
title: Documents and sources
description: Store a re-ingested document as embedded chunks keyed by a source, replace it when it changes, and forget it.
---

`memory.upsertDocument()` stores a document as embedded chunks of one **source**. A source is a tenant ID, the exact container tag set (order and repeats ignored) and a `sourceKey`, such as a URL or file path. Calling it again with changed content replaces the source's previous chunks in one atomic step; calling it with unchanged content does nothing. `memory.forgetBySource()` removes a source. `add()` never deduplicates into, supersedes or links a source's chunks or facts, so they live and die with their source; memories written by `add()` behave as before.

```ts
const result = await memory.upsertDocument({
  tenantId: scope.tenantId,
  containerTags: ["docs"],
  sourceKey: "https://example.com/guide",
  content: markdown,
  metadata: { url: "https://example.com/guide" },
});
// { sourceKey, contentHash, unchanged: false, chunks: 4, memories: [...] }

await memory.forgetBySource({
  tenantId: scope.tenantId,
  containerTags: ["docs"],
  sourceKey: "https://example.com/guide",
});
// { sourceKey, deleted: 4 }
```

## Upsert

`upsertDocument({ tenantId, containerTags, sourceKey, content, contentHash?, metadata?, type?, extract?, chunking? })` requires an embedder, like `search()`, and fails with `MEMORY_EMBEDDER_REQUIRED` without one, before it reads or writes storage. Blank content fails with `MEMORY_CONTENT_REQUIRED`, a blank source key with `MEMORY_SOURCE_KEY_REQUIRED`, a `contentHash` that is blank or holds a NUL or unpaired surrogate with `MEMORY_SOURCE_HASH_REQUIRED`, a `contentHash` over 1 KiB of UTF-8 with `MemorySourceLimitError`, and a `type` that is not a memory type with `MEMORY_TYPE_INVALID`. All input checks run before any storage, LLM or embedding call.

1. The content hash is `contentHash` when given, otherwise the lowercase hex SHA-256 of the UTF-8 content. A caller can pass its own value, such as an HTTP ETag.
2. If the source's stored hash equals it, the call returns `unchanged: true` with `memories: []` and `chunks` set to the number of records the source holds. Nothing is chunked, embedded or written. Only the hash is compared: a call with other `chunking`, `extract`, `type` or `metadata` but the same hash is still unchanged. The hash is that of the source's live records: an `update()` or `forget()` of one record is not detected, so re-sending the same content stays unchanged. Pass a new `contentHash`, or call `forgetBySource()` first, to force a rewrite.
3. Otherwise the content is chunked, every chunk is embedded in one `embedBatch` call, and the storage adapter's `replaceSource()` soft-deletes the previous chunks and inserts the new ones atomically. Readers see either all old chunks or all new chunks, concurrent upserts of one source serialize, and the last committed write wins. If chunking, extraction or embedding fails, or a limit is exceeded, the previous chunks stay live.

Each stored chunk has `type: "document"` (or the given `type`), the caller's `metadata`, and the source fields `sourceKey`, `contentHash` and `chunkIndex` (its position). The result's `chunks` is the number of records written and `memories` holds them. Search returns chunks like any other memory; filter by tags or metadata to select documents.

## Chunking

The default chunker is Markdown-aware. It is exported as `chunkMarkdown(markdown, options?)`.

- It first splits the document into sections at ATX headings (`#` to `######`); a heading inside fenced code does not split. A chunk never spans two sections, so every section starts a new chunk.
- Within a section it packs whole paragraphs (split at blank lines; a fenced code block stays one paragraph) up to `targetChars`.
- A paragraph that fits in an empty chunk is never split. Only a paragraph longer than `targetChars` is hard split, at the last whitespace in the second half of the window when there is one, and never inside a surrogate pair; whitespace-only pieces are dropped.
- Each chunk after the first of a section starts with up to `overlapChars` trailing characters of the previous chunk, beginning at a word boundary, and fewer when the paragraph that starts the chunk needs the room. Overlap never crosses a heading.
- Fenced code follows CommonMark: a line starting with three or more backticks whose rest contains a backtick is inline code, not a fence.

`chunking.targetChars` defaults to 1,500 and is the most characters (UTF-16 code units) in one chunk, overlap included; it must be an integer of at least 64. `chunking.overlapChars` defaults to 200 and must be an integer from 0 to half of `targetChars`. Other values fail with `MEMORY_CHUNKING_INVALID`. Line endings are normalized to `\n`, no chunk is blank, the running time is linear in the content, and the output depends only on the content and the options. `markdownChunks()` yields the same chunks one at a time.

## Fact extraction

`extract` defaults to `false`: chunks are stored verbatim and no LLM is called. With `extract: true` (which requires an LLM, otherwise `MEMORY_LLM_REQUIRED`) the fact extractor runs on each chunk in order, and the facts are stored **instead of** the chunks, under the same source. Each fact keeps its extracted type and gets `metadata.extractedTags`, `metadata.confidence` and `metadata.sourceChunk` (the index of the chunk it came from) beside the caller's metadata. Document facts are not deduplicated against or linked to other memories, so `forgetBySource()` removes everything the source wrote. If extraction yields no facts, the source is left without live records, and the next upsert of the same content runs again.

## Forget

`forgetBySource({ tenantId, containerTags, sourceKey })` soft-deletes every live chunk or fact of the source through the same tombstone lifecycle as `forget()`: content, embedding and metadata are cleared, relationships are removed and the row is kept with `deletedAt` set. It returns `{ sourceKey, deleted }`, where `deleted` is 0 when the source held nothing, so it can be retried. It needs no embedder. Memories written by `add()` with the same tags are untouched, even when their content matches a chunk, because `add()` never deduplicates into a source.

The tag set is part of the source: forgetting with other tags, or upserting with other tags, names another source.

## HTTP

The [HTTP router](/docs/http) exposes both operations with the same scope rules as `/v1/memories`:

- `PUT /v1/documents` with `sourceKey`, `content`, optional `containerTags`, `contentHash`, `metadata`, `type`, `extract` and `chunking: { targetChars?, overlapChars? }` returns the upsert result.
- `DELETE /v1/documents` with a JSON body of `sourceKey` and optional `containerTags` returns `{ sourceKey, deleted }`.

The source's tags are the trusted host tags followed by the body tags, so a `DELETE` must send the same body tags as the `PUT`. Missing authorization returns 401 and schema-invalid input, including a body `tenantId`, returns 400 `INVALID_INPUT`. Input the pipeline rejects (a blank source key or content, an invalid `contentHash`, invalid chunking, an invalid tag) returns 400 `{ error: "INVALID_INPUT", code }`, and a source over a limit returns 413 `{ error: "MEMORY_SOURCE_LIMIT_EXCEEDED" }`, both before any provider call. If the `IMemoryFn` given to the router has no `upsertDocument` or `forgetBySource` (both are optional on the interface; `MemoryFn` has them), the route returns 501 `{ error: "MEMORY_DOCUMENTS_UNSUPPORTED" }`. The router's body limit applies.

## Limits

The storage source limits apply: a tenant ID, source key or `contentHash` of at most 1 KiB of UTF-8 each, at most 64 KiB of distinct tags, at most 16,384 records per source and at most 256 MiB of chunk data per replacement. `upsertDocument()` stops chunking at the record limit, stops extracting once the facts pass it, and checks the chunk data except embeddings (the caller's metadata counts once per record) before any embedding call. Each fails with `MemorySourceLimitError` and leaves the source unchanged; the embeddings' share is checked by `replaceSource()`. See [storage](/docs/storage) for the full contract. An MCP tool for documents is not available yet.
