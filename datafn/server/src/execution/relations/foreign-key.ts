import { firstEndpoint, getRelationFkFieldsForResource } from "@datafn/core";
import type { DatafnRelationSchema } from "../../core-types.js";

function foreignKeyDescriptor(relation: DatafnRelationSchema) {
  const owner = firstEndpoint(relation.type === "many-one" ? relation.from : relation.to);
  // Derive the names for this relation alone. Core de-duplicates a resource's
  // full field list by FK name, and two relations can share the same FK.
  return getRelationFkFieldsForResource({ resources: [], relations: [relation] }, owner)[0];
}

export function htreeFkField(relation: DatafnRelationSchema): string {
  return foreignKeyDescriptor(relation)?.field ?? "parentId";
}

export function fkResourceFieldForRelation(relation: DatafnRelationSchema): string | undefined {
  return foreignKeyDescriptor(relation)?.resourceField;
}
