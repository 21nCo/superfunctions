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
 * Orders resources so the targets of their foreign keys come first. A cycle
 * between resources keeps the given order for the resources in it.
 */
export function orderResourcesByDependency(
  resources: string[],
  references: Map<string, ReferenceField[]>,
): string[] {
  const inScope = new Set(resources);
  const ordered: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (resource: string) => {
    const current = state.get(resource);
    if (current) return;
    state.set(resource, "visiting");
    for (const reference of references.get(resource) ?? []) {
      for (const target of reference.targets) {
        if (target !== resource && inScope.has(target) && !state.has(target)) visit(target);
      }
    }
    state.set(resource, "done");
    ordered.push(resource);
  };
  for (const resource of resources) visit(resource);
  return ordered;
}

/**
 * Orders records (already sorted by id) so a record comes after the records
 * of the same resource it references through `fields`. A reference cycle is
 * left for the caller to break.
 */
export function orderRecordsParentFirst(
  records: Record<string, unknown>[],
  fields: string[],
): Record<string, unknown>[] {
  if (fields.length === 0 || records.length < 2) return records;
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
      if (frame.next < fields.length) {
        const parentId = record[fields[frame.next++]];
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
