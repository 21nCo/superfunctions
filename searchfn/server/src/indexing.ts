import type { Adapter } from "@superfunctions/db";
import type { DatafnSchema } from "@datafn/core";

export interface IndexOptions {
  schema: DatafnSchema;
  db: Adapter;
  model?: string;
  tablePrefix?: string;
}

const DEFAULT_PREFIX = "_searchfn_";

// Simple tokenizer
function tokenize(text: string): string[] {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export async function indexData(options: IndexOptions) {
  const { schema, db, model: targetModel, tablePrefix = DEFAULT_PREFIX } = options;
  const indexTable = `${tablePrefix}index`;

  // 1. Ensure index table exists
  // In a real plugin system, this might be done via migrations.
  // Here we try to create it if we can, or assume it exists.
  // Using generic Adapter which might not support DDL directly in a standard way.
  // We'll skip DDL for now and assume the table is:
  // _searchfn_index (term: string, model: string, recordId: string, field: string)
  // Or we store a JSON blob if adapter is limited.
  
  // For now, we will assume we can write to this table.

  const modelsToIndex = targetModel ? [targetModel] : Object.keys(schema.models);
  let totalIndexed = 0;

  for (const modelName of modelsToIndex) {
    const modelDef = schema.models[modelName];
    if (!modelDef) continue;

    // Find fields that should be indexed.
    // We assume an 'indexes' property or similar metadata.
    // For this prototype, we'll index all string fields or look for specific directive.
    // Let's assume we index fields that are part of 'fulltext' indexes in schema.
    // If schema structure is unknown, we'll index all string fields for demonstration.
    
    // Check if model has specific indexes defined for fulltext
    // Schema structure varies, assuming standard DataFn schema
    const stringFields = Object.entries(modelDef.fields)
      .filter(([_, field]: [string, any]) => field.type === "string")
      .map(([name]) => name);
      
    if (stringFields.length === 0) continue;

    // Fetch all data
    // Pagination should be used here for large datasets
    const records = await db.find_many(modelName, {});

    for (const record of records) {
      const id = record.id; // Assume 'id' field exists
      if (!id) continue;

      for (const field of stringFields) {
        const value = record[field];
        if (typeof value === "string") {
          const tokens = tokenize(value);
          
          for (const token of tokens) {
            // Write to index table
            // We use upsert logic or simple insert.
            // Ideally:
            // await db.create(indexTable, { term: token, model: modelName, recordId: id, field });
            
            // Note: This is very inefficient (one insert per token).
            // Batching should be used.
            try {
                // Check if exists to avoid duplicates (naive)
                // Or just insert and rely on unique constraint?
                // We'll just insert for prototype.
                await db.create(indexTable, {
                    term: token,
                    model: modelName,
                    recordId: String(id),
                    field: field
                });
            } catch (e) {
                // Ignore errors (e.g. duplicate if using simple table)
            }
          }
        }
      }
      totalIndexed++;
    }
  }

  return { totalIndexed };
}
