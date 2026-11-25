import type { DatafnRelationSchema } from "../../core-types.js";

export function htreeFkField(relation: DatafnRelationSchema): string {
  return relation.fkField || relation.foreignKey || relation.inverse || "parentId";
}

export function fkResourceFieldForRelation(relation: DatafnRelationSchema, side: "from" | "to"): string {
  if (relation.fkResourceField) return relation.fkResourceField;
  if (relation.type === "htree") return `${htreeFkField(relation).replace(/Id$/, "")}Resource`;
  const base = side === "to"
    ? (relation.relation || "target")
    : (relation.inverse || relation.relation || "source");
  return `${base.replace(/Id$/, "")}Resource`;
}
