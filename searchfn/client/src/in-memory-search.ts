import {
  DocumentStatsManager,
  Indexer,
  PipelineEngine,
  fuzzyExpand,
  scorePostings,
  type PipelineOptions,
  type RetrievedPostingChunk,
  type TermPosting,
} from "@searchfn/core";

export interface InMemorySearchFnOptions {
  fields: string[];
  pipeline?: PipelineOptions;
}

export interface InMemoryAddDocumentInput {
  id: string | number;
  fields: Record<string, string>;
  store?: Record<string, unknown>;
}

export interface InMemorySearchOptions {
  fields?: string[];
  limit?: number;
  fuzzy?: number | boolean;
}

export interface InMemorySearchDetailedOptions extends InMemorySearchOptions {
  includeStored?: boolean;
}

export interface InMemorySearchResultItem {
  docId: string | number;
  score: number;
  document?: Record<string, unknown>;
}

export interface InMemorySearchFnSnapshot {
  postings: Array<{
    field: string;
    term: string;
    documents: TermPosting[];
  }>;
  stats: Array<{ docId: string; length: number }>;
  documents: Array<{ docId: string; payload: Record<string, unknown> }>;
  vocabulary: string[];
}

interface PostingBucket {
  field: string;
  term: string;
  documents: Map<string, TermPosting>;
}

function postingBucketKey(field: string, term: string): string {
  return `${field}\u0000${term}`;
}

function docIdKey(value: string | number): string {
  return typeof value === "string" ? value : String(value);
}

function sortString(a: string, b: string): number {
  return a.localeCompare(b, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

export class InMemorySearchFn {
  private readonly fields: string[];
  private readonly pipeline: PipelineEngine;
  private readonly pipelineWithoutNGrams: PipelineEngine;
  private readonly indexer: Indexer;
  private readonly statsManager = new DocumentStatsManager();
  private readonly postings = new Map<string, PostingBucket>();
  private readonly documents = new Map<string, Record<string, unknown>>();
  private readonly vocabulary = new Set<string>();
  private readonly fuzzyCache = new Map<string, string[]>();

  constructor(options: InMemorySearchFnOptions) {
    this.fields = [...options.fields];
    this.pipeline = new PipelineEngine(options.pipeline);
    this.pipelineWithoutNGrams = new PipelineEngine({
      ...options.pipeline,
      enableEdgeNGrams: false,
    });
    this.indexer = new Indexer(this.pipeline);
  }

  add(input: InMemoryAddDocumentInput): void {
    const docId = input.id;
    const docKey = docIdKey(docId);
    const ingested = this.indexer.ingest({
      docId,
      fields: input.fields,
    });

    this.statsManager.addDocument(docId, ingested.totalLength);
    this.documents.set(docKey, input.store ?? {});

    for (const [field, termFrequencies] of ingested.fieldFrequencies.entries()) {
      const metadata = ingested.fieldMetadata.get(field) ?? new Map<string, Record<string, unknown>>();
      for (const [term, frequency] of termFrequencies.entries()) {
        const bucketKey = postingBucketKey(field, term);
        const bucket = this.postings.get(bucketKey) ?? {
          field,
          term,
          documents: new Map<string, TermPosting>(),
        };
        const postingMetadata = metadata.get(term);
        bucket.documents.set(docKey, {
          docId,
          termFrequency: frequency,
          metadata: postingMetadata,
        });
        this.postings.set(bucketKey, bucket);

        if (postingMetadata?.isPrefix !== true) {
          this.vocabulary.add(term);
          this.fuzzyCache.clear();
        }
      }
    }
  }

  search(query: string, options: InMemorySearchOptions = {}): Array<string | number> {
    return this.searchDetailed(query, options).map((result) => result.docId);
  }

  searchDetailed(
    query: string,
    options: InMemorySearchDetailedOptions = {}
  ): InMemorySearchResultItem[] {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const searchFields = options.fields?.length ? options.fields : this.fields;
    const queryTokens = new Map<string, { field: string; term: string; boost: number }>();
    const fuzzyDistance = this.getFuzzyDistance(options.fuzzy);

    for (const field of searchFields) {
      const tokens = this.pipelineWithoutNGrams.run(field, normalizedQuery);
      for (const token of tokens) {
        const key = postingBucketKey(field, token.value);
        if (!queryTokens.has(key)) {
          queryTokens.set(key, {
            field,
            term: token.value,
            boost: 1,
          });
        }

        if (fuzzyDistance) {
          for (const fuzzyTerm of this.getCachedFuzzyExpansion(token.value, fuzzyDistance)) {
            const fuzzyKey = postingBucketKey(field, fuzzyTerm);
            if (!queryTokens.has(fuzzyKey)) {
              queryTokens.set(fuzzyKey, {
                field,
                term: fuzzyTerm,
                boost: fuzzyTerm === token.value ? 1 : 0.8,
              });
            }
          }
        }
      }
    }

    const postings: RetrievedPostingChunk[] = [];
    for (const token of queryTokens.values()) {
      const bucket = this.postings.get(postingBucketKey(token.field, token.term));
      if (!bucket) {
        continue;
      }
      postings.push({
        field: bucket.field,
        term: bucket.term,
        docFrequency: bucket.documents.size,
        postings: [...bucket.documents.values()].map((posting) => ({
          ...posting,
          termFrequency: posting.termFrequency * token.boost,
        })),
      });
    }

    if (postings.length === 0) {
      return [];
    }

    const docLengths = new Map(
      this.statsManager.snapshot().map((entry) => [entry.docId, entry.length] satisfies [string, number])
    );
    const scored = scorePostings(
      postings,
      docLengths,
      this.statsManager.getAverageLength(),
      { k1: 1.2, b: 0.75, d: 0.5 }
    );

    return scored.slice(0, Math.max(options.limit ?? 10, 1)).map((entry) => ({
      docId: entry.docId,
      score: entry.score,
      document: options.includeStored ? this.documents.get(docIdKey(entry.docId)) : undefined,
    }));
  }

  remove(docId: string | number): void {
    const docKey = docIdKey(docId);
    this.documents.delete(docKey);
    this.statsManager.removeDocument(docId);

    for (const [bucketKey, bucket] of this.postings.entries()) {
      bucket.documents.delete(docKey);
      if (bucket.documents.size === 0) {
        this.postings.delete(bucketKey);
      }
    }
  }

  getDocument(docId: string | number): Record<string, unknown> | undefined {
    return this.documents.get(docIdKey(docId));
  }

  clear(): void {
    this.postings.clear();
    this.documents.clear();
    this.vocabulary.clear();
    this.fuzzyCache.clear();
    this.statsManager.load([]);
  }

  exportSnapshot(): InMemorySearchFnSnapshot {
    return {
      postings: [...this.postings.values()]
        .map((bucket) => ({
          field: bucket.field,
          term: bucket.term,
          documents: [...bucket.documents.values()].sort((left, right) =>
            sortString(docIdKey(left.docId), docIdKey(right.docId))
          ),
        }))
        .sort((left, right) => {
          const fieldCompare = sortString(left.field, right.field);
          if (fieldCompare !== 0) {
            return fieldCompare;
          }
          return sortString(left.term, right.term);
        }),
      stats: this.statsManager
        .snapshot()
        .sort((left, right) => sortString(left.docId, right.docId)),
      documents: [...this.documents.entries()]
        .map(([docId, payload]) => ({ docId, payload }))
        .sort((left, right) => sortString(left.docId, right.docId)),
      vocabulary: [...this.vocabulary].sort(sortString),
    };
  }

  importSnapshot(snapshot: InMemorySearchFnSnapshot): void {
    this.clear();
    this.statsManager.load(snapshot.stats);

    for (const posting of snapshot.postings) {
      this.postings.set(postingBucketKey(posting.field, posting.term), {
        field: posting.field,
        term: posting.term,
        documents: new Map(
          posting.documents.map((entry) => [docIdKey(entry.docId), entry] satisfies [string, TermPosting])
        ),
      });
    }

    for (const document of snapshot.documents) {
      this.documents.set(document.docId, document.payload);
    }

    for (const term of snapshot.vocabulary) {
      this.vocabulary.add(term);
    }
  }

  private getFuzzyDistance(fuzzy?: number | boolean): number | undefined {
    if (fuzzy === true) {
      return 2;
    }
    if (typeof fuzzy === "number" && fuzzy > 0) {
      return fuzzy;
    }
    return undefined;
  }

  private getCachedFuzzyExpansion(term: string, distance: number): string[] {
    const cacheKey = `${term}:${distance}`;
    const cached = this.fuzzyCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const expanded = fuzzyExpand(term, distance, this.vocabulary);
    this.fuzzyCache.set(cacheKey, expanded);
    return expanded;
  }
}
