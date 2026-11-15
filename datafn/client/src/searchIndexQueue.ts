/**
 * Search index updates for one provider and resource run one at a time. Each
 * update reads the records it indexes from storage inside its turn, so a
 * later write's update always runs after an earlier one and the index ends on
 * the newest stored version.
 */
const queues = new WeakMap<object, Map<string, Promise<unknown>>>();

export function runSearchIndexUpdate<T>(
  provider: object,
  resource: string,
  task: () => Promise<T>,
): Promise<T> {
  let byResource = queues.get(provider);
  if (!byResource) {
    byResource = new Map();
    queues.set(provider, byResource);
  }
  const previous = byResource.get(resource) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  byResource.set(resource, settled);
  void settled.then(() => {
    if (byResource!.get(resource) === settled) byResource!.delete(resource);
  });
  return run;
}

type IndexingProvider = {
  updateIndices(params: {
    resource: string;
    records: Array<Record<string, unknown>>;
    operation: "upsert" | "delete";
  }): Promise<unknown>;
};

type RecordReader = {
  getRecord(resource: string, id: string): Promise<Record<string, unknown> | null>;
  listRecords(resource: string): Promise<Record<string, unknown>[]>;
  countRecords(resource: string): Promise<number>;
};

const READ_CHUNK = 200;

/**
 * Indexes the version storage holds for each id, in the resource's turn, and
 * removes ids no longer stored. Reads the whole resource at once when the ids
 * are a large part of it, otherwise reads them by id.
 */
export function indexStoredRecords(
  provider: IndexingProvider,
  storage: RecordReader,
  resource: string,
  ids: readonly string[],
): Promise<void> {
  return runSearchIndexUpdate(provider, resource, async () => {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return;
    const stored = new Map<string, Record<string, unknown>>();
    const wantedSet = new Set(wanted);
    if (wanted.length > READ_CHUNK && wanted.length * 4 >= (await storage.countRecords(resource))) {
      for (const record of await storage.listRecords(resource)) {
        if (typeof record.id === "string" && wantedSet.has(record.id)) stored.set(record.id, record);
      }
    } else {
      for (let start = 0; start < wanted.length; start += READ_CHUNK) {
        const chunk = wanted.slice(start, start + READ_CHUNK);
        const records = await Promise.all(chunk.map((id) => storage.getRecord(resource, id)));
        for (const record of records) {
          if (record && typeof record.id === "string") stored.set(record.id, record);
        }
      }
    }
    const removed = wanted.filter((id) => !stored.has(id)).map((id) => ({ id }));
    if (stored.size > 0) {
      await provider.updateIndices({ resource, records: [...stored.values()], operation: "upsert" });
    }
    if (removed.length > 0) {
      await provider.updateIndices({ resource, records: removed, operation: "delete" });
    }
  });
}

/** Ids of records that have a string id. */
export function recordIds(records: readonly unknown[]): string[] {
  return records
    .map((record) => (record as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string");
}
