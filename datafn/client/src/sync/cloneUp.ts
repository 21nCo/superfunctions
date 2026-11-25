import type { DatafnSchema, DatafnResourceSchema, DatafnRelationSchema } from "@datafn/core";
import {
  ANCESTOR_INACTIVE_FIELD,
  getJoinStoreKey,
  resourceRequiresAncestorInactive,
  stripNullsForNonNullableFields,
} from "@datafn/core";
import type { DatafnStorageAdapter } from "../storage.js";
import type { DatafnRemoteAdapter } from "../client.js";
import type { EventBus } from "../events/bus.js";
import { createClientError, isTransportError } from "../errors.js";
import { computeMutationHash } from "./cloneUp/hash.js";
import {
  orderRecordsParentFirst,
  referenceTargetsFor,
  referencesInUse,
  orderResourcesByDependency,
  referenceFieldsByResource,
  sortJoinRows,
  sortRecordsById,
  type ReferenceField,
} from "./cloneUp/order.js";
import { batchMutations } from "./cloneUp/batch.js";
import {
  decryptPullResultForE2ee,
  encryptMutationPayloadForE2ee,
  type DatafnE2eeConfig,
} from "../e2ee.js";

export type CloneUpOptions = {
  resources?: string[];
  includeManyMany?: boolean;
  recordOperation?: "merge" | "replace" | "insert";
  batchSize?: number;
  maxRetries?: number;
  failFast?: boolean;
  clearChangelogOnSuccess?: boolean;
  setGlobalCursorOnSuccess?: boolean;
  pullAfter?: boolean;
  mutationIdPrefix?: string;
};

export type CloneUpResult = {
  ok: boolean;
  cursor: string;
  stats: {
    resources: Record<string, { records: number; mutations: number }>;
    joinStores: Record<string, { rows: number; mutations: number }>;
    batches: number;
  };
  errors: Array<{
    mutationId: string;
    code: string;
    message: string;
    path: string;
  }>;
  /** Optional total count of uploaded records (for event context) */
  uploadedCount?: number;
};

export type CloneUpDeps = {
  schema: DatafnSchema;
  storage: DatafnStorageAdapter | undefined;
  remote: DatafnRemoteAdapter | undefined;
  clientId: string;
  syncConfig: { pushBatchSize?: number; pushMaxRetries?: number } | undefined;
  eventBus: EventBus;
  getTimestamp: () => number;
  e2ee?: DatafnE2eeConfig;
};

export async function cloneUp(
  deps: CloneUpDeps,
  options?: CloneUpOptions,
): Promise<CloneUpResult> {
  const storage = deps.storage;
  const remote = deps.remote;
  const schema = deps.schema;

  if (!storage) {
    throw createClientError(
      "DFQL_INVALID",
      "Invalid cloneUp: storage is required",
      { path: "storage" },
    );
  }

  if (!remote) {
    throw createClientError(
      "DFQL_INVALID",
      "Invalid cloneUp: sync.remote is required",
      { path: "sync.remote" },
    );
  }

  if (!schema) {
    throw createClientError(
      "INTERNAL",
      "Invalid cloneUp: schema is not available",
      { path: "schema" },
    );
  }

  const batchSize = options?.batchSize ?? deps.syncConfig?.pushBatchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw createClientError(
      "DFQL_INVALID",
      "Invalid cloneUp: batchSize must be a positive integer",
      { path: "batchSize" },
    );
  }

  const maxRetries = options?.maxRetries ?? deps.syncConfig?.pushMaxRetries ?? 3;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw createClientError(
      "DFQL_INVALID",
      "Invalid cloneUp: maxRetries must be a non-negative integer",
      { path: "maxRetries" },
    );
  }

  const recordOperation = options?.recordOperation ?? "merge";
  const prefix = options?.mutationIdPrefix ?? "cloneup";
  const failFast = options?.failFast ?? true;
  const includeManyMany = options?.includeManyMany ?? true;

  const resolvedResources = resolveResourceScope(schema, options?.resources);

  const resourceSchemaMap = new Map<string, DatafnResourceSchema>();
  for (const r of schema.resources) {
    resourceSchemaMap.set(r.name, r);
  }

  const result: CloneUpResult = {
    ok: true,
    cursor: "0",
    stats: {
      resources: {},
      joinStores: {},
      batches: 0,
    },
    errors: [],
  };

  let highestCursor = "0";
  let hasErrors = false;

  // --- Stage A: Upload records ---
  // Records go up parents first so a server with foreign keys (and htree path
  // maintenance) always has the referenced record: resources in dependency
  // order, and records of a self-referencing resource after their parents.
  // A nullable reference that would still point at a local record not pushed
  // yet (a cycle) is sent unset and set by a follow-up merge after all
  // records. A non-nullable one is sent as it is: unsetting it would be an
  // invalid write, and a server that enforces the reference reports the
  // rejected record in the result.
  const references = referenceFieldsByResource(schema);
  // Changelog entries written after this point (local writes made while the
  // push runs) may not be in the records read below, so finalization leaves
  // them queued for the next sync.
  const changelogMark =
    options?.clearChangelogOnSuccess !== false ? await lastChangelogSeq(storage) : null;
  const recordsByResource = new Map<string, Record<string, unknown>[]>();
  const localIds = new Map<string, Set<string>>();
  for (const resourceName of resolvedResources) {
    // A pull from a SQL-backed server stores an unset column as null, also
    // for a field the schema does not allow to be null. That null means "not
    // set", so it is dropped here, once, for ordering and upload alike: the
    // record goes up like one created without the field (the server applies
    // its default), and a defaulted reference orders its resource after the
    // default's target. Nullable fields keep their null.
    const resourceSchema = resourceSchemaMap.get(resourceName);
    const records = (await storage.listRecords(resourceName)).map((record) =>
      stripNullsForNonNullableFields(record, resourceSchema),
    );
    recordsByResource.set(resourceName, records);
    localIds.set(
      resourceName,
      new Set(records.map((record) => record.id).filter((id): id is string => typeof id === "string")),
    );
  }
  // Order by the references the records actually hold, so a polymorphic
  // reference depends only on the resources its records name.
  const orderedResources = orderResourcesByDependency(
    resolvedResources,
    referencesInUse(
      references,
      recordsByResource,
      (resource, field) =>
        resourceSchemaMap.get(resource)?.fields.some((f) => f.name === field && f.default !== undefined) ??
        false,
    ),
    (resource, field) =>
      resourceSchemaMap.get(resource)?.fields.some((f) => f.name === field && f.nullable === true) ?? false,
  );
  const pushedIds = new Map<string, Set<string>>();
  const deferredReferences: Array<{
    resourceName: string;
    version: number;
    id: string;
    patch: Record<string, unknown>;
    recordMutationId: string;
    /** The not-yet-pushed records the patch points at. */
    targets: string[];
  }> = [];

  // Non-nullable references sent while their target was not pushed yet, by
  // record mutation id, to explain a rejection of that record.
  const unbrokenCycleReferences = new Map<
    string,
    Array<{ resource: string; id: string; field: string; targetId: string }>
  >();
  const explainRejectedCycles = (
    batch: Record<string, unknown>[],
    errors: PushError[],
  ): PushError[] => {
    const rejected = new Set(errors.map((error) => error.mutationId));
    const wholeBatch = errors.some((error) => !error.mutationId);
    const explained: PushError[] = [];
    for (const mutation of batch) {
      const mutationId = mutation.mutationId as string;
      if (!wholeBatch && !rejected.has(mutationId)) continue;
      // A rejection of the whole batch may have another cause, so it is
      // offered as a possible one.
      const named = rejected.has(mutationId);
      for (const reference of unbrokenCycleReferences.get(mutationId) ?? []) {
        explained.push({
          mutationId,
          code: "REFERENCE_CYCLE",
          message:
            `${reference.resource} ${reference.id} was sent with ${reference.field} = ` +
            `${reference.targetId}, which was not pushed yet: the reference is part of a ` +
            `cycle and cannot be unset because the field is not nullable` +
            (named ? "" : "; this may be why the batch was rejected"),
          path: `record.${reference.field}`,
        });
      }
    }
    return explained;
  };

  /** Pushes mutations in batches; returns false when cloneUp must stop. */
  // Record mutations the server rejected, so their deferred references are
  // not restored onto a record that is not there.
  const rejectedMutationIds = new Set<string>();
  const rejectedRecords = new Set<string>();
  const recordKey = (resource: unknown, id: unknown) => `${String(resource)}\u0000${String(id)}`;
  const pushMutations = async (mutations: Record<string, unknown>[]): Promise<boolean> => {
    const batches = batchMutations(mutations, batchSize);
    for (const batch of batches) {
      const payloadBatch = await encryptMutationPayloadForE2ee(
        schema,
        deps.e2ee,
        batch,
      ) as Record<string, unknown>[];
      const pushResult = await pushBatchWithRetry(
        remote,
        deps.clientId,
        payloadBatch,
        maxRetries,
      );

      result.stats.batches += pushResult.attempts;

      if (pushResult.cursor) {
        highestCursor = maxCursorStr(highestCursor, pushResult.cursor);
      }

      if (pushResult.errors.length > 0) {
        result.errors.push(...pushResult.errors, ...explainRejectedCycles(batch, pushResult.errors));
        const wholeBatch = pushResult.errors.some((error) => !error.mutationId);
        const rejectedHere = new Set(pushResult.errors.map((error) => error.mutationId));
        for (const mutation of batch) {
          if (!wholeBatch && !rejectedHere.has(mutation.mutationId as string)) continue;
          rejectedMutationIds.add(mutation.mutationId as string);
          rejectedRecords.add(recordKey(mutation.resource, mutation.id));
        }
        hasErrors = true;
        if (failFast) {
          result.ok = false;
          result.cursor = highestCursor;
          deps.eventBus.emit({
            type: "sync_failed",
            timestampMs: deps.getTimestamp(),
            context: { phase: "cloneup", error: { errors: result.errors } },
          });
          return false;
        }
      }
    }
    return true;
  };

  for (const resourceName of orderedResources) {
    const resourceSchema = resourceSchemaMap.get(resourceName)!;
    const fieldNames = writableFieldNames(schema, resourceSchema);
    const nullableFields = new Set(
      resourceSchema.fields.filter((field) => field.nullable === true).map((field) => field.name),
    );
    const resourceReferences: ReferenceField[] = (references.get(resourceName) ?? []).filter(
      (reference) => fieldNames.has(reference.field),
    );

    const rawRecords = recordsByResource.get(resourceName) ?? [];
    const sortedRecords = orderRecordsParentFirst(
      sortRecordsById(rawRecords),
      resourceName,
      resourceReferences,
    );
    const pushed = pushedIds.get(resourceName) ?? new Set<string>();
    pushedIds.set(resourceName, pushed);

    const mutations: Record<string, unknown>[] = [];
    let recordIndex = 0;

    for (const record of sortedRecords) {
      if (typeof record.id !== "string") {
        throw createClientError(
          "DFQL_INVALID",
          "Invalid cloneUp: record id must be a string",
          { path: `records[${recordIndex}].id` },
        );
      }

      const filteredRecord: Record<string, unknown> = {};
      for (const key of Object.keys(record)) {
        if (key !== "id" && fieldNames.has(key)) {
          filteredRecord[key] = record[key];
        }
      }

      // Break reference cycles: unset a nullable reference to a local record
      // that has not been pushed yet and set it once every record is up. A
      // record that references itself needs no break.
      const deferredPatch: Record<string, unknown> = {};
      const deferredTargets: string[] = [];
      const unbroken: Array<{ resource: string; id: string; field: string; targetId: string }> = [];
      for (const reference of resourceReferences) {
        const targetId = filteredRecord[reference.field];
        if (typeof targetId !== "string" || targetId.length === 0) continue;
        const pendingTargets = referenceTargetsFor(reference, record).filter(
          (target) =>
            !(target === resourceName && targetId === record.id) &&
            localIds.get(target)?.has(targetId) &&
            !pushedIds.get(target)?.has(targetId),
        );
        if (pendingTargets.length === 0) continue;
        if (!nullableFields.has(reference.field)) {
          // Sent as it is; fine when the target already exists on the server.
          unbroken.push({ resource: resourceName, id: record.id, field: reference.field, targetId });
          continue;
        }
        deferredPatch[reference.field] = targetId;
        filteredRecord[reference.field] = null;
        for (const target of pendingTargets) deferredTargets.push(recordKey(target, targetId));
        const resourceField = reference.resourceField;
        // References that share a resource field keep the first saved value.
        if (
          resourceField &&
          nullableFields.has(resourceField) &&
          resourceField in filteredRecord &&
          !(resourceField in deferredPatch)
        ) {
          deferredPatch[resourceField] = filteredRecord[resourceField];
          filteredRecord[resourceField] = null;
        }
      }
      const hashInput = {
        kind: "rec",
        resource: resourceName,
        operation: recordOperation,
        id: record.id,
        record: filteredRecord,
      };
      const hash = computeMutationHash(hashInput);
      const mutationId = `${prefix}:rec:${resourceName}:${record.id}:${hash}`;
      if (unbroken.length > 0) unbrokenCycleReferences.set(mutationId, unbroken);

      if (Object.keys(deferredPatch).length > 0) {
        deferredReferences.push({
          resourceName,
          version: resourceSchema.version,
          id: record.id,
          patch: deferredPatch,
          recordMutationId: mutationId,
          targets: deferredTargets,
        });
      }

      mutations.push({
        resource: resourceName,
        version: resourceSchema.version,
        operation: recordOperation,
        id: record.id,
        record: filteredRecord,
        clientId: deps.clientId,
        mutationId,
      });
      pushed.add(record.id);

      recordIndex++;
    }

    // Only include resources in stats if they have records
    if (sortedRecords.length > 0) {
      result.stats.resources[resourceName] = {
        records: sortedRecords.length,
        mutations: mutations.length,
      };
    }

    if (!(await pushMutations(mutations))) return result;
  }

  // Set the references held back to break cycles.
  // Neither the record nor a record it points at may have been rejected.
  const restorable = deferredReferences.filter(
    ({ recordMutationId, targets }) =>
      !rejectedMutationIds.has(recordMutationId) &&
      !targets.some((target) => rejectedRecords.has(target)),
  );
  if (restorable.length > 0) {
    const mutations = restorable.map(({ resourceName, version, id, patch, recordMutationId }) => {
      // The record mutation that unset the reference is part of the identity:
      // when that record changes and is pushed again (unsetting the reference
      // again), the restore must be a new mutation too, or the server would
      // skip it as already applied.
      const hash = computeMutationHash({
        kind: "ref",
        resource: resourceName,
        id,
        record: patch,
        after: recordMutationId,
      });
      const stats = result.stats.resources[resourceName];
      if (stats) stats.mutations += 1;
      return {
        resource: resourceName,
        version,
        operation: "merge",
        id,
        record: patch,
        clientId: deps.clientId,
        mutationId: `${prefix}:ref:${resourceName}:${id}:${hash}`,
      };
    });
    if (!(await pushMutations(mutations))) return result;
  }

  // --- Stage B: Many-many join rows ---
  if (includeManyMany && schema.relations) {
    const resolvedResourceSet = new Set(resolvedResources);
    const joinStoreEntries = enumerateJoinStores(schema.relations, resolvedResourceSet);
    const sortedJoinStoreNames = joinStoreEntries.map((e) => e.storeName).sort();

    for (const storeName of sortedJoinStoreNames) {
      const entry = joinStoreEntries.find((e) => e.storeName === storeName)!;
      const { fromResource, relationName, relation } = entry;
      const fromSchema = resourceSchemaMap.get(fromResource)!;
      const metaFieldNames = new Set(
        (relation.metadata ?? []).map((m) => m.name),
      );

      let rawJoinRows: Record<string, unknown>[];
      try {
        rawJoinRows = await storage.listJoinRows(storeName);
      } catch {
        rawJoinRows = [];
      }

      let rowIndex = 0;
      for (const row of rawJoinRows) {
        if (typeof row.from !== "string") {
          throw createClientError(
            "DFQL_INVALID",
            "Invalid cloneUp: join row from/to must be a string",
            { path: `joinRows[${rowIndex}].from` },
          );
        }
        if (typeof row.to !== "string") {
          throw createClientError(
            "DFQL_INVALID",
            "Invalid cloneUp: join row from/to must be a string",
            { path: `joinRows[${rowIndex}].to` },
          );
        }

        for (const key of Object.keys(row)) {
          if (key === "from" || key === "to") continue;
          if (!metaFieldNames.has(key)) {
            throw createClientError(
              "DFQL_UNKNOWN_FIELD",
              "Invalid cloneUp: unknown join metadata field",
              { path: `joinRows[${rowIndex}].${key}` },
            );
          }
        }
        rowIndex++;
      }

      const sortedRows = sortJoinRows(rawJoinRows);

      const mutations: Record<string, unknown>[] = [];
      for (const row of sortedRows) {
        const metaFiltered: Record<string, unknown> = {};
        for (const key of Object.keys(row)) {
          if (key !== "from" && key !== "to" && metaFieldNames.has(key)) {
            metaFiltered[key] = row[key];
          }
        }

        const hashInput = {
          kind: "rel",
          joinStore: storeName,
          resource: fromResource,
          relation: relationName,
          from: row.from,
          to: row.to,
          metadata: metaFiltered,
        };
        const hash = computeMutationHash(hashInput);
        const mutationId = `${prefix}:rel:${storeName}:${row.from}:${row.to}:${hash}`;

        mutations.push({
          resource: fromResource,
          version: fromSchema.version,
          operation: "relate",
          id: row.from,
          relations: { [relationName]: { $ref: row.to, ...metaFiltered } },
          clientId: deps.clientId,
          mutationId,
        });
      }

      result.stats.joinStores[storeName] = {
        rows: rawJoinRows.length,
        mutations: mutations.length,
      };

      const batches = batchMutations(mutations, batchSize);
      for (const batch of batches) {
        const payloadBatch = await encryptMutationPayloadForE2ee(
          schema,
          deps.e2ee,
          batch,
        ) as Record<string, unknown>[];
        const pushResult = await pushBatchWithRetry(
          remote,
          deps.clientId,
          payloadBatch,
          maxRetries,
        );

        result.stats.batches += pushResult.attempts;

        if (pushResult.cursor) {
          highestCursor = maxCursorStr(highestCursor, pushResult.cursor);
        }

        if (pushResult.errors.length > 0) {
          result.errors.push(...pushResult.errors);
          hasErrors = true;
          if (failFast) {
            result.ok = false;
            result.cursor = highestCursor;
            deps.eventBus.emit({
              type: "sync_failed",
              timestampMs: deps.getTimestamp(),
              context: { phase: "cloneup", error: { errors: result.errors } },
            });
            return result;
          }
        }
      }
    }
  }

  if (hasErrors) {
    result.ok = false;
  }

  result.cursor = highestCursor;

  if (hasErrors) {
    deps.eventBus.emit({
      type: "sync_failed",
      timestampMs: deps.getTimestamp(),
      context: { phase: "cloneup", error: { errors: result.errors } },
    });
    return result;
  }

  // --- Finalization ---
  const startingCursor = (await storage.getCursor("__global_cursor__")) ?? "0";

  // pullAfter: catch-up loop from startingCursor
  if (options?.pullAfter !== false) {
    let pullCursor = startingCursor;
    let caughtUp = false;

    while (!caughtUp) {
      let pullResponse: any;
      try {
        pullResponse = await remote.pull({
          clientId: deps.clientId,
          cursor: pullCursor,
          limit: 100,
        });
      } catch (err) {
        if (isTransportError(err)) {
          throw err;
        }
        throw err;
      }

      const pullResult = pullResponse?.result ?? pullResponse;
      const decryptedPullResult = await decryptPullResultForE2ee(
        schema,
        deps.e2ee,
        pullResult,
      ) as any;
      const changes: any[] = decryptedPullResult?.changes ?? [];
      const nextCursor: string | null = decryptedPullResult?.nextCursor ?? null;

      for (const change of changes) {
        if (change.op === "upsert" && change.record) {
          await storage.upsertRecord(change.resource, change.record);
        } else if (change.op === "delete") {
          await storage.deleteRecord(change.resource, change.id);
        }
      }

      if (nextCursor !== null) {
        await setCursorMonotonically(storage, nextCursor);
        pullCursor = nextCursor;
      } else if (changes.length > 0) {
        const lastSeq = String(changes[changes.length - 1].serverSeq);
        await setCursorMonotonically(storage, lastSeq);
        pullCursor = lastSeq;
        caughtUp = true;
      } else {
        caughtUp = true;
      }

      if (nextCursor === null) {
        caughtUp = true;
      }
    }
  }

  // setGlobalCursorOnSuccess: monotonic set to max push cursor
  if (options?.setGlobalCursorOnSuccess !== false) {
    await setCursorMonotonically(storage, highestCursor);
  }

  // clearChangelogOnSuccess: acknowledge the changelog entries that existed
  // before the records were read; later ones stay queued.
  if (options?.clearChangelogOnSuccess !== false && changelogMark !== null) {
    await storage.changelogAck({ throughSeq: changelogMark });
  }

  deps.eventBus.emit({
    type: "sync_applied",
    timestampMs: deps.getTimestamp(),
    context: { phase: "cloneup", cursor: result.cursor, stats: result.stats },
  });

  return result;
}

/** Largest changelog sequence number in storage, or null when it is empty. */
async function lastChangelogSeq(storage: DatafnStorageAdapter): Promise<number | null> {
  if (typeof storage.changelogLastSeq === "function") return storage.changelogLastSeq();
  // An adapter without changelogLastSeq: changelogList has no offset, so read
  // it whole (IndexedDB caps a getAll count at 2^32 - 1).
  const entries = await storage.changelogList({ limit: 0xffffffff });
  let last: number | null = null;
  for (const entry of entries) {
    if (typeof entry.seq === "number" && (last === null || entry.seq > last)) last = entry.seq;
  }
  return last;
}

async function setCursorMonotonically(
  storage: DatafnStorageAdapter,
  newCursor: string,
): Promise<void> {
  const existing = await storage.getCursor("__global_cursor__");
  const existingNum = parseInt(existing ?? "0", 10) || 0;
  const newNum = parseInt(newCursor, 10) || 0;
  if (newNum > existingNum) {
    await storage.setCursor("__global_cursor__", newCursor);
  }
}

/**
 * Names of the record fields the server accepts on a client write to
 * `resource`. The server rejects the whole push batch when a record carries a
 * read-only field (a field marked `readonly`, such as a capability field or
 * the DataFn system field `isAncestorInactive`) or a field the schema does not
 * declare, so cloneUp uploads only the declared fields that are writable.
 */
function writableFieldNames(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
): Set<string> {
  const names = new Set<string>();
  for (const field of resource.fields) {
    if (field.readonly !== true) names.add(field.name);
  }
  // The server rejects this system field on dependents of an inheritsInactive
  // relation even when the schema it was given does not list it.
  if (resourceRequiresAncestorInactive(schema.relations, resource.name)) {
    names.delete(ANCESTOR_INACTIVE_FIELD);
  }
  return names;
}

function resolveResourceScope(
  schema: DatafnSchema,
  requestedResources?: string[],
): string[] {
  if (requestedResources) {
    const schemaResourceMap = new Map<string, DatafnResourceSchema>();
    for (const r of schema.resources) {
      schemaResourceMap.set(r.name, r);
    }

    for (let i = 0; i < requestedResources.length; i++) {
      const name = requestedResources[i];
      const res = schemaResourceMap.get(name);

      if (!res) {
        throw createClientError(
          "DFQL_UNKNOWN_RESOURCE",
          "Invalid cloneUp: unknown resource",
          { path: `resources[${i}]` },
        );
      }

      if (res.isRemoteOnly) {
        throw createClientError(
          "DFQL_INVALID",
          "Invalid cloneUp: remote-only resources are not allowed",
          { path: `resources[${i}]` },
        );
      }
    }

    return requestedResources;
  }

  return schema.resources
    .filter((r) => !r.isRemoteOnly)
    .map((r) => r.name);
}

type JoinStoreEntry = {
  storeName: string;
  fromResource: string;
  relationName: string;
  relation: DatafnRelationSchema;
};

function enumerateJoinStores(
  relations: readonly DatafnRelationSchema[],
  resolvedResourceSet: Set<string>,
): JoinStoreEntry[] {
  const entries: JoinStoreEntry[] = [];

  for (const rel of relations) {
    if (rel.type !== "many-many") continue;

    const fromResources = Array.isArray(rel.from) ? rel.from : [rel.from];
    const toResources = Array.isArray(rel.to) ? rel.to : [rel.to];
    const relName = rel.relation ?? "rel";

    for (const f of fromResources) {
      if (!resolvedResourceSet.has(f)) continue;
      for (const t of toResources) {
        entries.push({
          storeName: getJoinStoreKey(f, relName, t),
          fromResource: f,
          relationName: relName,
          relation: rel,
        });
      }
    }
  }

  return entries;
}

type PushError = CloneUpResult["errors"][number];

type PushBatchResult = {
  cursor: string | null;
  errors: PushError[];
  attempts: number;
};

/**
 * Reads the cursor and errors of a push response. The server rejects a batch
 * in two shapes, and both must count as a failure:
 * - per-mutation errors: `{ ok: false, error, result: { errors: [...] } }`
 *   (or `{ errors: [...] }` from a remote adapter that returns the result);
 * - a whole-batch rejection with no per-mutation result, such as a schema
 *   validation error: `{ ok: false, error: { code, message, details } }`.
 */
function readPushResponse(response: unknown): Omit<PushBatchResult, "attempts"> {
  const envelope = isObject(response) ? response : {};
  const pushResult = isObject(envelope.result) ? envelope.result : envelope;
  const cursor = (pushResult.cursor ?? null) as string | null;

  const mutationErrors = pushResult.errors;
  if (Array.isArray(mutationErrors) && mutationErrors.length > 0) {
    return { cursor, errors: mutationErrors as PushError[] };
  }

  const rejected =
    envelope.ok === false || pushResult.ok === false || isObject(envelope.error);
  if (!rejected) return { cursor, errors: [] };

  const error = isObject(envelope.error) ? envelope.error : {};
  const details = isObject(error.details) ? error.details : {};
  return {
    cursor,
    errors: [
      {
        mutationId: "",
        code: typeof error.code === "string" ? error.code : "PUSH_REJECTED",
        message:
          typeof error.message === "string" ? error.message : "Push rejected by server",
        path: typeof details.path === "string" ? details.path : "$",
      },
    ],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pushBatchWithRetry(
  remote: DatafnRemoteAdapter,
  clientId: string,
  mutations: Record<string, unknown>[],
  maxRetries: number,
): Promise<PushBatchResult> {
  let attempts = 0;

  while (true) {
    attempts++;
    try {
      const response = (await remote.push({
        clientId,
        mutations,
      })) as any;

      return { ...readPushResponse(response), attempts };
    } catch (err) {
      if (isTransportError(err) && attempts <= maxRetries) {
        // CLI-010: Exponential backoff between retries
        const backoffMs = 1000 * Math.pow(2, attempts - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
}

function maxCursorStr(a: string, b: string): string {
  const an = parseInt(a, 10) || 0;
  const bn = parseInt(b, 10) || 0;
  return an >= bn ? a : b;
}
