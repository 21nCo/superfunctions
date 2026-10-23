# PHASE 13 — Data Export and Import

## Phase Goal
Add data backup and restore capabilities via structured JSON export/import.

## In Scope
- `client.exportData(options?)` — read all records and join rows
- `client.importData(data, options?)` — upsert records and join rows
- `DatafnExportPayload` format (version 1)
- Resource filtering for export
- Schema validation on import
- Optional `triggerCloneUp` after import

## Out of Scope
- Streaming export (for very large datasets)
- Incremental export/import
- Export to file (caller handles file I/O)

## Deliverables
- `client/src/export.ts` — export and import functions (NEW FILE)
- `client/src/client.ts` — exportData/importData methods on client
- `client/__tests__/export.test.ts` — export/import tests

## Requirements Covered
- EXP-001, EXP-002

## Implementation Tasks
1. Define `DatafnExportPayload` and `DatafnImportResult` types (from SPEC)
2. Implement `exportData()`:
   ```typescript
   async exportData(options?: { resources?: string[] }): Promise<DatafnExportPayload> {
     const resources = resolveExportScope(schema, options?.resources);
     const payload: DatafnExportPayload = {
       version: 1,
       exportedAt: new Date().toISOString(),
       schema: resources.map(r => ({ name: r.name, version: r.version })),
       resources: {},
       joins: {},
     };
     for (const resource of resources) {
       payload.resources[resource.name] = await storage.listRecords(resource.name);
     }
     // Export join rows for many-many relations
     for (const relation of schema.relations ?? []) {
       if (relation.type === "many-many") {
         const storeName = resolveJoinStoreName(relation);
         try { payload.joins![storeName] = await storage.listJoinRows(storeName); } catch {}
       }
     }
     return payload;
   }
   ```
3. Implement `importData()`:
   ```typescript
   async importData(data: DatafnExportPayload, options?: { triggerCloneUp?: boolean }): Promise<DatafnImportResult> {
     // Validate version
     if (data.version !== 1) throw createClientError("DFQL_INVALID", "Unsupported export version", { path: "version" });
     const result: DatafnImportResult = { ok: true, stats: { resources: {}, joins: {} }, errors: [] };
     // Import records
     for (const [resourceName, records] of Object.entries(data.resources)) {
       const resourceSchema = schema.resources.find(r => r.name === resourceName);
       if (!resourceSchema) continue; // Skip unknown resources
       let imported = 0, skipped = 0;
       for (const record of records) {
         try {
           await storage.upsertRecord(resourceName, record);
           imported++;
         } catch (err) {
           skipped++;
           result.errors.push({ resource: resourceName, id: String(record.id), code: "IMPORT_FAILED", message: String(err) });
         }
       }
       result.stats.resources[resourceName] = { imported, skipped };
     }
     // Import join rows
     for (const [storeName, rows] of Object.entries(data.joins ?? {})) {
       let imported = 0, skipped = 0;
       for (const row of rows) {
         try {
           await storage.upsertJoinRow(storeName, row);
           imported++;
         } catch { skipped++; }
       }
       result.stats.joins[storeName] = { imported, skipped };
     }
     if (options?.triggerCloneUp) await this.sync.cloneUp();
     if (result.errors.length > 0) result.ok = false;
     return result;
   }
   ```
4. Write test: export returns all records in correct format
5. Write test: export with resource filter only exports specified resources
6. Write test: import upserts records correctly
7. Write test: import skips unknown resources
8. Write test: import with triggerCloneUp calls cloneUp
9. Write test: export → import roundtrip preserves data
10. Run full test suite

## Verification Steps
- New tests pass: export, import, roundtrip, filtering
- `npm test -w @datafn/client` → 0 failures
- TV-EXP-001/N, TV-EXP-002/N verified

## Stop Condition
Export/import works correctly. All tests pass. Phase report written.
