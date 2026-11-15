import type { DatafnSchema } from "@datafn/core";
import { dfqlKey, endpointList } from "@datafn/core";

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortRecordsById(
  records: Record<string, unknown>[]
): Record<string, unknown>[] {
  return [...records].sort((a, b) => compareCodeUnits(String(a.id), String(b.id)));
}

/** A field on a resource that holds the id of a record in one of `targets`. */
export type ReferenceField = {
  field: string;
  targets: string[];
  /** Companion field naming the target resource on polymorphic relations. */
  resourceField?: string;
};

/**
 * The resources a record's reference can point to. On a polymorphic relation
 * the companion resource field, when it names one of the targets, narrows
 * them to that resource.
 */
export function referenceTargetsFor(
  reference: ReferenceField,
  record: Record<string, unknown>,
): string[] {
  if (reference.resourceField) {
    const named = record[reference.resourceField];
    if (typeof named === "string" && reference.targets.includes(named)) return [named];
  }
  return reference.targets;
}

/**
 * Foreign-key fields per resource, from many-one (on `from`), one-many and
 * htree (on `to`) relations.
 */
export function referenceFieldsByResource(
  schema: DatafnSchema,
): Map<string, ReferenceField[]> {
  const byResource = new Map<string, ReferenceField[]>();
  const add = (resource: string, entry: ReferenceField) => {
    const list = byResource.get(resource) ?? [];
    const existing = list.find((item) => item.field === entry.field);
    if (existing) {
      for (const target of entry.targets) {
        if (!existing.targets.includes(target)) existing.targets.push(target);
      }
    } else {
      list.push({ ...entry, targets: [...entry.targets] });
    }
    byResource.set(resource, list);
  };
  const resourceFieldFor = (
    base: string | undefined,
    relation: { fkResourceField?: string },
    multiple: boolean,
  ) => (multiple ? relation.fkResourceField ?? (base ? `${base.replace(/Id$/, "")}Resource` : undefined) : undefined);

  for (const relation of schema.relations ?? []) {
    const from = endpointList(relation.from);
    const to = endpointList(relation.to);
    if (relation.type === "many-one") {
      const field = relation.fkField || relation.foreignKey || `${relation.relation ?? to[0]}Id`;
      const resourceField = resourceFieldFor(relation.relation || "target", relation, to.length > 1);
      for (const resource of from) add(resource, { field, targets: to, resourceField });
    } else if (relation.type === "one-many") {
      const field = relation.fkField || relation.foreignKey || relation.inverse || `${from[0]}Id`;
      const resourceField = resourceFieldFor(
        relation.inverse || relation.relation || "source",
        relation,
        from.length > 1,
      );
      for (const resource of to) add(resource, { field, targets: from, resourceField });
    } else if (relation.type === "htree") {
      const field = relation.fkField || relation.foreignKey || relation.inverse || "parentId";
      const resourceField = resourceFieldFor(field, relation, from.length > 1);
      for (const resource of to) add(resource, { field, targets: from, resourceField });
    }
  }
  return byResource;
}

/**
 * Orders resources so the targets of their foreign keys come first. Resources
 * that reference each other in a cycle stay together, in the given order
 * where the references allow: the next one placed is the first whose
 * references, then whose non-nullable references, are all satisfied, so
 * cloneUp can break the cycle by unsetting a nullable reference. A cycle of
 * only non-nullable references keeps the given order.
 */
export function orderResourcesByDependency(
  resources: string[],
  references: Map<string, ReferenceField[]>,
  isNullable: (resource: string, field: string) => boolean = () => false,
): string[] {
  const inScope = [...new Set(resources)];
  const scope = new Set(inScope);
  const targetsOf = (resource: string, nonNullableOnly = false) =>
    (references.get(resource) ?? [])
      .filter((reference) => !nonNullableOnly || !isNullable(resource, reference.field))
      .flatMap((reference) => reference.targets)
      .filter((target) => target !== resource && scope.has(target));

  const placed = new Set<string>();
  const ordered: string[] = [];
  const placeCycle = (members: string[]) => {
    const remaining = inScope.filter((resource) => members.includes(resource));
    const ready = (resource: string, nonNullableOnly: boolean) =>
      targetsOf(resource, nonNullableOnly).every((target) => placed.has(target));
    while (remaining.length > 0) {
      let index = remaining.findIndex((resource) => ready(resource, false));
      if (index < 0) index = remaining.findIndex((resource) => ready(resource, true));
      if (index < 0) index = 0;
      const [next] = remaining.splice(index, 1);
      placed.add(next);
      ordered.push(next);
    }
  };

  // Tarjan's algorithm emits each strongly connected component after every
  // component it references, which is the order cloneUp needs.
  let counter = 0;
  const indexOf = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const connect = (resource: string) => {
    indexOf.set(resource, counter);
    lowLink.set(resource, counter);
    counter++;
    stack.push(resource);
    onStack.add(resource);
    for (const target of targetsOf(resource)) {
      if (!indexOf.has(target)) {
        connect(target);
        lowLink.set(resource, Math.min(lowLink.get(resource)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(resource, Math.min(lowLink.get(resource)!, indexOf.get(target)!));
      }
    }
    if (lowLink.get(resource) !== indexOf.get(resource)) return;
    const members: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      members.push(member);
    } while (member !== resource);
    placeCycle(members);
  };
  for (const resource of inScope) {
    if (!indexOf.has(resource)) connect(resource);
  }
  return ordered;
}

/**
 * Orders records of `resource` (already sorted by id) so a record comes after
 * the records of the same resource it references. A reference counts only
 * when it can point to `resource` (see referenceTargetsFor). A reference
 * cycle is left for the caller to break.
 */
export function orderRecordsParentFirst(
  records: Record<string, unknown>[],
  resource: string,
  references: ReferenceField[],
): Record<string, unknown>[] {
  const selfReferences = references.filter((reference) => reference.targets.includes(resource));
  if (selfReferences.length === 0 || records.length < 2) return records;
  const byId = new Map<string, Record<string, unknown>>();
  for (const record of records) byId.set(String(record.id), record);
  const state = new Map<string, "visiting" | "done">();
  const ordered: Record<string, unknown>[] = [];

  for (const root of records) {
    const rootId = String(root.id);
    if (state.has(rootId)) continue;
    // Iterative depth-first walk up the parent chain.
    const stack: Array<{ id: string; next: number }> = [{ id: rootId, next: 0 }];
    state.set(rootId, "visiting");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const record = byId.get(frame.id)!;
      if (frame.next < selfReferences.length) {
        const reference = selfReferences[frame.next++];
        if (!referenceTargetsFor(reference, record).includes(resource)) continue;
        const parentId = record[reference.field];
        if (typeof parentId === "string" && byId.has(parentId) && !state.has(parentId)) {
          state.set(parentId, "visiting");
          stack.push({ id: parentId, next: 0 });
        }
        continue;
      }
      stack.pop();
      state.set(frame.id, "done");
      ordered.push(record);
    }
  }
  return ordered;
}

export function sortJoinRows(
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  return [...rows].sort((a, b) => {
    const fromCmp = compareCodeUnits(String(a.from), String(b.from));
    if (fromCmp !== 0) return fromCmp;

    const toCmp = compareCodeUnits(String(a.to), String(b.to));
    if (toCmp !== 0) return toCmp;

    const aMeta = extractMeta(a);
    const bMeta = extractMeta(b);
    return dfqlKey(aMeta).localeCompare(dfqlKey(bMeta));
  });
}

function extractMeta(
  row: Record<string, unknown>
): Record<string, unknown> {
  const { from, to, ...meta } = row;
  return meta;
}
