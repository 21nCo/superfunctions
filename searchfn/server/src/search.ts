import type { Adapter } from "@superfunctions/db";
import type { DatafnSchema } from "@datafn/core";

export interface SearchOptions {
  schema: DatafnSchema;
  db: Adapter;
  query: string;
  model?: string;
  limit?: number;
  tablePrefix?: string;
}

const DEFAULT_PREFIX = "_searchfn_";

function tokenize(text: string): string[] {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export async function searchIndex(options: SearchOptions) {
  const { db, query, model, limit = 20, tablePrefix = DEFAULT_PREFIX } = options;
  const indexTable = `${tablePrefix}index`;
  const tokens = tokenize(query);

  if (tokens.length === 0) return [];

  // Find matches for tokens
  // We want to find records that contain these tokens.
  // Query: SELECT * FROM index WHERE term IN (tokens)
  
  // Using adapter:
  // where: [ { term: { in: tokens } } ]
  // But Adapter 'where' syntax depends on implementation.
  // Assuming standard datafn filter syntax support or simple equality.
  // If 'in' operator is not standard in base adapter, we iterate.
  
  // Naive approach: search for each token
  const matches = [];
  for (const token of tokens) {
    const tokenMatches = await db.find_many(indexTable, {
        term: token,
        ...(model ? { model } : {})
    });
    matches.push(...tokenMatches);
  }

  // Aggregate results (scoring)
  const scores: Record<string, { id: string, model: string, score: number, matches: string[] }> = {};

  for (const match of matches) {
    const key = `${match.model}:${match.recordId}`;
    if (!scores[key]) {
      scores[key] = {
        id: match.recordId,
        model: match.model,
        score: 0,
        matches: []
      };
    }
    scores[key].score += 1;
    scores[key].matches.push(match.term);
  }

  // Sort by score
  const results = Object.values(scores)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Optional: Hydrate records
  // For now return refs
  return results;
}
