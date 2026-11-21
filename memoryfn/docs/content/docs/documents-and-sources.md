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

`upsertDocument({ tenantId, containerTags, sourceKey, content, contentHash?, metadata?, type?, extract?, chunking? })` requires an embedder, like `search()`, and fails with `MEMORY_EMBEDDER_REQUIRED` without one, before it reads or writes storage. Blank content fails with `MEMORY_CONTENT_REQUIRED`, and content holding a NUL or an unpaired UTF-16 surrogate with `MEMORY_CONTENT_INVALID` (hashed as UTF-8, a lone surrogate would alias U+FFFD, and PostgreSQL text rejects NUL); a blank source key with `MEMORY_SOURCE_KEY_REQUIRED`, a `contentHash` that is blank or holds a NUL or unpaired surrogate with `MEMORY_SOURCE_HASH_REQUIRED`, a `contentHash` over 1 KiB of UTF-8 with `MemorySourceLimitError`, a `type` that is not a memory type with `MEMORY_TYPE_INVALID`, and `metadata` that is not JSON data (plain objects, dense arrays, strings, finite numbers, booleans and null; so a Map, Date, typed array, BigInt, function, NaN or cycle is rejected, never converted), or whose JSON holds a NUL or an unpaired surrogate in any key or string (PostgreSQL `jsonb` rejects both), with `MEMORY_METADATA_INVALID`; an object property that is `undefined` is left out, as JSON does. The metadata is copied once at call time, reading each property once, and that copy is what is measured and written. A storage adapter without `replaceSourceIfChanged()` (optional on `StorageAdapter`), or without the `excludesSources` declaration that its `searchVectors()` leaves out source rows before ranking (see [storage](/docs/storage)), fails with `MEMORY_DOCUMENTS_UNSUPPORTED`; it still serves `add()`, `search()` and `forgetBySource()`. Both are checked when the upsert starts and again immediately before the write, and a built-in adapter rechecks the declaration before the rows it added commit, so a declaration withdrawn meanwhile fails with `MEMORY_DOCUMENTS_UNSUPPORTED` and keeps the previous source. The declaration covers exact vector search, the shipped default; an approximate pgvector index can return fewer ordinary `add()` candidates (see [storage](/docs/storage)). All input checks run before any storage, LLM or embedding call.

1. The content hash is `contentHash` when given, otherwise the lowercase hex SHA-256 of the UTF-8 content. A caller can pass its own value, such as an HTTP ETag.
2. If the source's stored hash equals it, the call returns `unchanged: true` with `memories: []` and `chunks` set to the number of records the source holds. Nothing is chunked, embedded or written. Only the hash is compared: a call with other `chunking`, `extract`, `type` or `metadata` but the same hash is still unchanged. The hash is that of the source's live records: an `update()` or `forget()` of one record is not detected, so re-sending the same content stays unchanged. Pass a new `contentHash`, or call `forgetBySource()` first, to force a rewrite.
3. Otherwise the content is chunked and every chunk is embedded in one `embedBatch` call. The batch must hold one non-empty vector of finite numbers per chunk, all of one length (the storage adapter's `embeddingDimensions` when it has one), each with a largest component whose square is at least float32's smallest normal value (2^-126) and a sum of squares that stays below float32's largest value (about 3.4e38) with room for float32 rounding, so its cosine can be computed in the memory adapter and in pgvector's float32 arithmetic; a zero vector is rejected. Each number is checked and counted toward the 256 MiB replacement budget as it is copied. A wrong count fails with `MEMORY_EMBEDDING_COUNT_MISMATCH` and any other bad batch with `MEMORY_EMBEDDING_INVALID`. Each vector is stored as a plain copy of the embedder's values, not rescaled, so a query scores a chunk exactly as it scores a memory stored by `add()`. The float32 range check is a portability rule for stored document vectors, applied on every adapter (including the memory adapter, which could score some of them), so a stored source stays searchable if it moves to PostgreSQL; a rejected batch leaves the previous chunks live. `search()` is unchanged: it passes the embedder's query vector to storage as it is. Then the storage adapter's `replaceSourceIfChanged()` compares the stored hash again inside its per-source serialization and, if it still differs, soft-deletes the previous chunks and inserts the new ones atomically. Readers see either all old chunks or all new chunks, and concurrent upserts of one source serialize: the last committed write wins, and of concurrent calls with the same hash (such as a client retry) only one writes, while the others return `unchanged: true` like step 2, after embedding. If chunking, extraction or embedding fails, the batch is invalid or a limit is exceeded, the previous chunks stay live and the new hash is not stored.

Each stored chunk has `type: "document"` (or the given `type`), the caller's `metadata`, the distinct container tags (a repeated tag is stored once), and the source fields `sourceKey`, `contentHash` and `chunkIndex` (its position). The result's `chunks` is the number of records written and `memories` holds them. Search returns chunks like any other memory; filter by tags or metadata to select documents.

## Chunking

The default chunker is Markdown-aware. It is exported as `chunkMarkdown(markdown, options?)`.

- It first splits the document into sections at ATX headings (`#` to `######`); a heading inside fenced code does not split. A chunk never spans two sections, so every section starts a new chunk.
- Within a section it packs whole paragraphs (split at blank lines; a fenced code block is one paragraph of its own, even when text touches it without a blank line) up to `targetChars`.
- A paragraph that fits in an empty chunk is never split. Only a paragraph longer than `targetChars` is hard split, at the last whitespace in the second half of the window when there is one, and never inside a surrogate pair; whitespace-only pieces are dropped.
- Each chunk after the first of a section starts with up to `overlapChars` trailing characters of the previous chunk, beginning at a word boundary, and fewer when the paragraph that starts the chunk needs the room. Overlap never crosses a heading.
- Fenced code follows CommonMark: a line starting with three or more backticks whose rest contains a backtick is inline code, not a fence, and a fence closes only at a marker at least as long as the opening one followed by nothing but spaces or tabs.

`chunking.targetChars` defaults to 1,500 and is the most characters (UTF-16 code units) in one chunk, overlap included; it must be an integer of at least 64. `chunking.overlapChars` defaults to 200 and must be an integer from 0 to half of `targetChars`. Other values fail with `MEMORY_CHUNKING_INVALID`. Line endings are normalized to `\n`, no chunk is blank, the running time is linear in the content, and the output depends only on the content and the options. `markdownChunks()` yields the same chunks one at a time, reading the content line by line, so a caller that stops early does no work on the rest.

## Fact extraction

`extract` defaults to `false`: chunks are stored verbatim and no LLM is called. With `extract: true` (which requires an LLM, otherwise `MEMORY_LLM_REQUIRED`) the fact extractor runs on each chunk in order, and the facts are stored **instead of** the chunks, under the same source. A fact whose content or tags hold a NUL or an unpaired surrogate fails the upsert with `MEMORY_EXTRACTION_INVALID` before embedding, as does a facts or tags array with holes. Each fact keeps its extracted type and gets `metadata.extractedTags`, `metadata.confidence` and `metadata.sourceChunk` (the index of the chunk it came from) beside the caller's metadata. Document facts are not deduplicated against or linked to other memories, so `forgetBySource()` removes everything the source wrote. If extraction yields no facts, the source is left without live records, and the next upsert of the same content runs again.

## Forget

`forgetBySource({ tenantId, containerTags, sourceKey })` soft-deletes every live chunk or fact of the source through the same tombstone lifecycle as `forget()`: content, embedding and metadata are cleared, relationships are removed and the row is kept with `deletedAt` set. It returns `{ sourceKey, deleted }`, where `deleted` is 0 when the source held nothing, so it can be retried. It needs no embedder. Memories written by `add()` with the same tags are untouched, even when their content matches a chunk, because `add()` never deduplicates into a source.

The tag set is part of the source: forgetting with other tags, or upserting with other tags, names another source.

## HTTP

The [HTTP router](/docs/http) exposes both operations with the same scope rules as `/v1/memories`:

- `PUT /v1/documents` with `sourceKey`, `content`, optional `containerTags`, `contentHash`, `metadata`, `type`, `extract` and `chunking: { targetChars?, overlapChars? }` returns the upsert result.
- `DELETE /v1/documents` with a JSON body of `sourceKey` and optional `containerTags` returns `{ sourceKey, deleted }`.

The source's tags are the trusted host tags followed by the body tags, so a `DELETE` must send the same body tags as the `PUT`. Missing authorization returns 401 and malformed JSON or schema-invalid input, including a body `tenantId`, returns 400 `INVALID_INPUT`. Input the pipeline rejects (a blank source key or content, an invalid `contentHash`, invalid chunking, an invalid tag) returns 400 `{ error: "INVALID_INPUT", code }`, and a source over a limit returns 413 `{ error: "MEMORY_SOURCE_LIMIT_EXCEEDED" }`. Both come before any provider call, except a replacement whose embeddings push it over 256 MiB, which is rejected after embedding and before the write (see Limits); document text with a NUL or an unpaired surrogate returns 400 with code `MEMORY_CONTENT_INVALID`, and such metadata 400 with code `MEMORY_METADATA_INVALID`. If the `IMemoryFn` given to the router has no `upsertDocument` or `forgetBySource` (both are optional on the interface; `MemoryFn` has them), or its storage has no `replaceSourceIfChanged()` or no `excludesSources` declaration, the route returns 501 `{ error: "MEMORY_DOCUMENTS_UNSUPPORTED" }`. The router's body limit applies.

## Limits

The storage source limits apply: a tenant ID, source key or `contentHash` of at most 1 KiB of UTF-8 each, at most 64 KiB of distinct tags, at most 16,384 records per source and at most 256 MiB of chunk data per replacement. `upsertDocument()` stops chunking at the record limit, rejects an extraction response with more facts than the records left before reading any of them, and stops reading facts at the one that passes the byte limit, and a fact's tags at the tag that passes it. Its own 256 MiB budget counts for each record its type, content and metadata (so the caller's metadata counts once per record, and a fact's metadata is counted from the caller's and its own values as each is read, without serializing the record), the JSON of its copy of the distinct container tags, which `replaceSource()` itself does not count, and the JSON of its embedding. Everything but the embeddings is checked before any embedding call; each embedding is added as it is copied, after embedding and before the write. Each fails with `MemorySourceLimitError` and leaves the source unchanged. See [storage](/docs/storage) for the full contract. An MCP tool for documents is not available yet.
