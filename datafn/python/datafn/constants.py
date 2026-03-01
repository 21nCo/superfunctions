"""
DataFn shared constants.

Source of truth is core/src/system-fields.ts; keep in sync with that file.
"""

# All system-managed fields present on every DataFn record.
# Matches TypeScript core: SYSTEM_FIELDS in core/src/system-fields.ts
SYSTEM_FIELDS: frozenset[str] = frozenset([
    "id",
    "createdAt",
    "updatedAt",
    "createdBy",
    "updatedBy",
    "isArchived",
])
