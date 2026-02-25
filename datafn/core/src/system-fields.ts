export const SYSTEM_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "isArchived",
]);

export const READONLY_SYSTEM_FIELDS: ReadonlySet<string> = new Set([
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
]);
