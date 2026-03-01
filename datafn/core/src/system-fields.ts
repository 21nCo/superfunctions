/**
 * All system-managed fields on every resource.
 *
 * LOW-025: `isArchived` is in SYSTEM_FIELDS (so it's recognised as a reserved name)
 * but is intentionally NOT in READONLY_SYSTEM_FIELDS — clients are allowed to set/clear
 * it directly as a soft-delete flag. The other four audit fields (createdAt, updatedAt,
 * createdBy, updatedBy) are server-managed and must not be written by clients.
 */
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
