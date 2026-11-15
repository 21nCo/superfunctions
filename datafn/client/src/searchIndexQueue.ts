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
