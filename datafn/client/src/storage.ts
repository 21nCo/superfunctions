/**
 * Storage adapter types for local persistence
 */

export type DatafnHydrationState = "notStarted" | "hydrating" | "ready";

/**
 * Factory function for creating storage adapters with namespace-based isolation.
 * Used for multi-user/multi-tenant data isolation.
 *
 * @example
 * ```typescript
 * const storageFactory: DatafnStorageFactory = (namespace) => {
 *   return IndexedDbStorageAdapter.createForNamespace("my-app", namespace);
 * };
 * ```
 */
export type DatafnStorageFactory = (
  namespace: string,
) => DatafnStorageAdapter;

export type DatafnChangelogEntry = {
  /** Monotonic local sequence (assigned by storage adapter). */
  seq: number;
  clientId: string;
  mutationId: string;
  mutation: Record<string, unknown>;
  timestampMs: number;
  /** Actor ID for audit attribution (when available) - AUD-001 */
  actorId?: string;
  /** ISO 8601 timestamp - AUD-001 */
  timestamp?: string;
};

export interface DatafnStorageAdapterCapabilities {
  /**
   * `mergeRecord` atomically chooses between applying `partial` to an existing
   * record and creating a missing record from the complete `options.ifMissing`
   * payload. It must not reapply `partial` to that creation payload.
   */
  readonly atomicMergeIfMissing?: boolean;
  /**
   * `mergeRecord` calls `options.onResolved` inside its atomic write with
   * whether it created the record. Callers pass the callback only to
   * adapters that set this.
   */
  readonly reportsMergeOutcome?: boolean;
  /**
   * DATA-41: the adapter stores each record's server revision with it
   * (`getRecordWithRevision`, `putRecordsWithRevisions`,
   * `revisionWriteStamp`), and every other record write (`upsertRecord`,
   * `upsertRecords`, `mergeRecord`, `deleteRecord`) clears that record's
   * revision and raises its write stamp in the same write.
   */
  readonly revisions?: boolean;
}

/** DATA-41: a complete server row (null for a delete tombstone) and its revision. */
export interface DatafnRevisionEntry {
  id: string;
  record: Record<string, unknown> | null;
  rev: number;
}

/** DATA-41: which records a revision install must leave alone. */
export interface DatafnRevisionInstallOptions {
  /** Skip records a pending changelog entry may change. */
  unlessPending?: boolean;
  /** Skip records written after this write stamp (`revisionWriteStamp`). */
  writtenSince?: number;
  /** Also skip records these not yet logged local mutations (debounced writes) may change. */
  pendingMutations?: ReadonlyArray<unknown>;
  /**
   * Resources whose writes may change other records' inherited inactive
   * state (parents of `inheritsInactive` relations): a pending write to one
   * counts as touching every record.
   */
  propagatingResources?: ReadonlyArray<string>;
}

/** DATA-41: options for reading a record with its revision. */
export interface DatafnRevisionReadOptions {
  /** See DatafnRevisionInstallOptions.propagatingResources. */
  propagatingResources?: ReadonlyArray<string>;
}

/**
 * DATA-41: the outcome of a revision install. `installed` lists the records
 * written with their revisions; `current` lists the records whose stored
 * revision is already equal to or newer than the entry's, which keep their
 * stored row and revision (the caller must not write the older row). Every
 * other entry was refused because a local change protects the record.
 */
export interface DatafnRevisionInstallResult {
  installed: string[];
  current: string[];
}

/** DATA-41: a record (null when deleted or absent) and its revision, read together. */
export interface DatafnStoredRevision {
  record: Record<string, unknown> | null;
  /** The server revision of exactly `record`, or undefined when unknown. */
  rev: number | undefined;
}

export interface DatafnStorageAdapter {
  readonly capabilities?: DatafnStorageAdapterCapabilities;

  // Records (by resource)
  getRecord(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | null>;
  listRecords(resource: string): Promise<Record<string, unknown>[]>;
  upsertRecord(
    resource: string,
    record: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Optional bulk upsert. Adapters that implement it write all records in one
   * backend transaction; callers fall back to `upsertRecord` per record.
   */
  upsertRecords?(
    resource: string,
    records: Array<Record<string, unknown>>,
  ): Promise<void>;
  deleteRecord(resource: string, id: string): Promise<void>;
  
  /**
   * Atomic read-modify-write merge. MUST be linearizable across every adapter
   * instance through a backend transaction or equivalent coordination primitive.
   * If the record does not exist, creates from `options.ifMissing` when
   * supplied, otherwise from `partial`.
   * Uses one-level-deep merge for object-type fields.
   */
  mergeRecord(
    resource: string, 
    id: string, 
    partial: Record<string, unknown>,
    options?: {
      /** Complete creation payload used instead of `partial` when absent. */
      ifMissing?: Record<string, unknown>;
      /**
       * Called inside the atomic read-modify-write with whether the record
       * was missing and has been created. Passed only to adapters that set
       * `capabilities.reportsMergeOutcome`.
       */
      onResolved?: (outcome: { created: boolean }) => void;
    },
  ): Promise<Record<string, unknown>>;

  /**
   * DATA-41 (adapters with `capabilities.revisions`): reads a record and its
   * revision in one storage read. The revision is undefined while a pending
   * changelog entry may change the record.
   */
  getRecordWithRevision?(resource: string, id: string, options?: DatafnRevisionReadOptions): Promise<DatafnStoredRevision>;
  /**
   * DATA-41 (adapters with `capabilities.revisions`): the current write
   * stamp. Every record write after this call (by any client sharing the
   * storage) gets a higher stamp, so a request can install its rows with
   * `writtenSince` and never overwrite a newer local state.
   */
  revisionWriteStamp?(): Promise<number>;
  /**
   * DATA-41 (adapters with `capabilities.revisions`): installs complete
   * server rows (or, where `record` is null, delete tombstones) together with
   * their revisions in one storage write. It never replaces a known revision
   * with an equal or older one (reported as `current`), and skips each record
   * `options` say must not be overwritten.
   */
  putRecordsWithRevisions?(
    resource: string,
    entries: ReadonlyArray<DatafnRevisionEntry>,
    options?: DatafnRevisionInstallOptions,
  ): Promise<DatafnRevisionInstallResult>;

  // Join rows (many-many)
  listJoinRows(relationKey: string): Promise<Array<Record<string, unknown>>>;
  getJoinRows(
    relationKey: string,
    fromId: string,
  ): Promise<Array<Record<string, unknown>>>;
  getJoinRowsInverse(
    relationKey: string,
    toId: string,
  ): Promise<Array<Record<string, unknown>>>;
  upsertJoinRow(
    relationKey: string,
    row: Record<string, unknown>,
  ): Promise<void>;
  setJoinRows(
    relationKey: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void>;
  deleteJoinRow(relationKey: string, from: string, to: string): Promise<void>;

  // Convenience query
  findRecords(
    resource: string,
    field: string,
    value: unknown,
  ): Promise<Record<string, unknown>[]>;

  // Sync state
  getCursor(resource: string): Promise<string | null>;
  setCursor(resource: string, cursor: string | null): Promise<void>;
  getHydrationState(resource: string): Promise<DatafnHydrationState>;
  setHydrationState(
    resource: string,
    state: DatafnHydrationState,
  ): Promise<void>;

  // Offline change log
  changelogAppend(
    entry: Omit<DatafnChangelogEntry, "seq">,
  ): Promise<DatafnChangelogEntry>;
  changelogList(options?: { limit?: number }): Promise<DatafnChangelogEntry[]>;
  changelogAck(options: { throughSeq: number }): Promise<void>;
  /**
   * Largest sequence number in the changelog, or null when it is empty.
   * Optional; callers fall back to listing the changelog.
   */
  changelogLastSeq?(): Promise<number | null>;

  // Counts for reconcile (SYNC-007)
  countRecords(resource: string): Promise<number>;
  countJoinRows(relationKey: string): Promise<number>;

  // Lifecycle (CLN-001, CLN-002)
  /** Close all connections and release resources. */
  close(): Promise<void>;
  /** Delete all data across all stores. */
  clearAll(): Promise<void>;

  // Health check (HEAL-001)
  /** 
   * Health check: verify core stores exist and are accessible.
   * Returns { ok: true, issues: [] } when healthy.
   * Returns { ok: false, issues: [...] } when corrupted or inaccessible.
   */
  healthCheck(): Promise<{ ok: boolean; issues: string[] }>;
}
