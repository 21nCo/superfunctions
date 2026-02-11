import type { CfqlOrderBy } from "@contentfn/core";

export function normalizeOrderBy(orderBy: CfqlOrderBy[] | undefined): CfqlOrderBy[] {
  if (!orderBy || orderBy.length === 0) {
    return [
      { field: "_updatedAt", direction: "desc" },
      { field: "_id", direction: "asc" },
    ];
  }

  const hasIdTiebreaker = orderBy.some((o) => o.field === "_id");
  if (hasIdTiebreaker) {
    return orderBy;
  }

  return [...orderBy, { field: "_id", direction: "asc" }];
}
