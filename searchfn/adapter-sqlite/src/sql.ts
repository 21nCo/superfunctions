/**
 * SQL builders for the SQLite FTS5 adapter.
 *
 * Layout per table prefix (default "searchfn"):
 *   <prefix>_resources            one row per resource: id, name, field list, FTS generation
 *   <prefix>_r<id>_docs           source of truth: doc id, id sort key, id type, namespace, region, fields JSON
 *   <prefix>_r<id>_fts_<gen>      FTS5 index, one column (c0..cN) per declared search field
 *
 * Table names come from the integer resource id, and FTS columns are positional, so no
 * caller-supplied resource or field name is ever spliced into an identifier. Field names
 * appear only as escaped string literals, and every value is a bound parameter. Each write
 * binds a single JSON parameter, which keeps D1 under its 100-parameter statement limit.
 */
import type { SqliteStatement } from "./driver";

export const TOKENIZER = "unicode61 remove_diacritics 2";
/** Generation of a resource whose tables are not created yet. */
export const PENDING_GENERATION = -1;

const TABLE_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
/** Token characters of the unicode61 tokenizer (L*, N*, Co) plus combining marks. */
const QUERY_TOKEN_PATTERN = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;

export interface ResourceState {
  id: number;
  resource: string;
  fields: string[];
  generation: number;
}

export interface SearchRow {
  /** Published generation of the resource, present on every row. */
  generation: number;
  /** Null on the single row returned when nothing matched. */
  doc_id: string | null;
  id_type: string | null;
  score: number | null;
}

export interface ResourceRow {
  id: number;
  fields: string;
  generation: number;
}

export function isValidTablePrefix(prefix: string): boolean {
  return TABLE_PREFIX_PATTERN.test(prefix);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier}"`;
}

function textLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function columnNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `c${index}`);
}

export class SqliteSchema {
  readonly resourcesTable: string;

  constructor(private readonly prefix: string) {
    this.resourcesTable = quoteIdentifier(`${prefix}_resources`);
  }

  docsTable(state: Pick<ResourceState, "id">): string {
    return quoteIdentifier(`${this.prefix}_r${state.id}_docs`);
  }

  ftsTable(state: Pick<ResourceState, "id">, generation: number): string {
    return quoteIdentifier(`${this.prefix}_r${state.id}_fts_${generation}`);
  }

  createResourcesTable(): string {
    return `CREATE TABLE IF NOT EXISTS ${this.resourcesTable} (id INTEGER PRIMARY KEY, resource TEXT NOT NULL UNIQUE, fields TEXT NOT NULL, generation INTEGER NOT NULL)`;
  }

  selectResource(): string {
    return `SELECT id, fields, generation FROM ${this.resourcesTable} WHERE resource = ?`;
  }

  /** Names of the FTS tables of a resource, including retired or orphaned generations. */
  selectFtsTables(state: Pick<ResourceState, "id">): SqliteStatement {
    return {
      sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, ?) = ?`,
      params: [this.ftsTablePrefix(state).length, this.ftsTablePrefix(state)],
    };
  }

  /** Generation encoded in an FTS table name of this resource, or undefined for shadow tables. */
  ftsGeneration(state: Pick<ResourceState, "id">, name: string): number | undefined {
    const prefix = this.ftsTablePrefix(state);
    const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : "";
    return /^\d+$/.test(suffix) ? Number(suffix) : undefined;
  }

  private ftsTablePrefix(state: Pick<ResourceState, "id">): string {
    return `${this.prefix}_r${state.id}_fts_`;
  }

  /**
   * Abort the enclosing batch unless the published generation is still `expected`: the
   * UPDATE writes nothing when it is, and sets NULL into a NOT NULL column when it is not.
   * Detect the abort with `isStaleGenerationError()`.
   */
  guardGeneration(state: Pick<ResourceState, "id">, expected: number): SqliteStatement {
    return {
      sql: `UPDATE ${this.resourcesTable} SET generation = NULL WHERE id = ? AND generation <> ?`,
      params: [state.id, expected],
    };
  }

  isStaleGenerationError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.includes(`NOT NULL constraint failed: ${this.prefix}_resources.generation`)
    );
  }

  selectResourceNames(): string {
    return `SELECT resource FROM ${this.resourcesTable} WHERE generation >= 0 ORDER BY resource`;
  }

  insertPendingResource(resource: string, fields: string[]): SqliteStatement {
    return {
      sql: `INSERT INTO ${this.resourcesTable} (resource, fields, generation) VALUES (?, ?, ${PENDING_GENERATION}) ON CONFLICT(resource) DO NOTHING`,
      params: [resource, JSON.stringify(fields)],
    };
  }

  /**
   * Creates generation 0 for a pending resource. The leading guard aborts once the row has
   * left pending, so a delayed completion never recreates a generation a rebuild retired.
   */
  completeRegistration(state: ResourceState): SqliteStatement[] {
    return [
      this.guardGeneration(state, PENDING_GENERATION),
      {
        sql: `CREATE TABLE IF NOT EXISTS ${this.docsTable(state)} (seq INTEGER PRIMARY KEY, doc_id TEXT NOT NULL UNIQUE, sort_key TEXT NOT NULL, id_type TEXT NOT NULL, ns TEXT, region TEXT, fields TEXT NOT NULL)`,
      },
      { sql: this.createFtsTable(state, 0, state.fields.length, true) },
      {
        sql: `UPDATE ${this.resourcesTable} SET generation = 0 WHERE id = ? AND generation = ${PENDING_GENERATION}`,
        params: [state.id],
      },
    ];
  }

  private createFtsTable(
    state: ResourceState,
    generation: number,
    fieldCount: number,
    ifNotExists: boolean,
  ): string {
    const columns = columnNames(fieldCount).join(", ");
    return `CREATE VIRTUAL TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${this.ftsTable(state, generation)} USING fts5(${columns}, tokenize = '${TOKENIZER}')`;
  }

  /** `INSERT INTO fts SELECT ... FROM docs d WHERE <where>`, reading each column from the fields JSON. */
  private populateFts(
    state: ResourceState,
    generation: number,
    fields: string[],
    where: string,
  ): string {
    const target = this.ftsTable(state, generation);
    const columns = columnNames(fields.length).join(", ");
    const values = fields
      .map((field) => `(SELECT value FROM json_each(d.fields) WHERE key = ${textLiteral(field)})`)
      .join(", ");
    return `INSERT INTO ${target} (rowid, ${columns}) SELECT d.seq, ${values} FROM ${this.docsTable(state)} d${where}`;
  }

  /**
   * Swap the FTS index to `fields` under a new generation in one transaction. The UPDATE is a
   * compare-and-swap: when another writer already moved the generation it sets NULL into a
   * NOT NULL column, which aborts the whole batch. Cleanup runs only after the guard, inside
   * the same transaction: a next-generation table left by an interrupted rebuild is dropped
   * before it is recreated, and every older generation in `retired` is dropped after the swap.
   */
  rebuild(state: ResourceState, fields: string[], retired: number[]): SqliteStatement[] {
    const next = state.generation + 1;
    const dropped = Array.from(new Set([state.generation, ...retired])).filter((generation) => generation < next);
    return [
      this.guardGeneration(state, state.generation),
      { sql: this.dropFtsTable(state, next) },
      { sql: this.createFtsTable(state, next, fields.length, false) },
      { sql: this.populateFts(state, next, fields, "") },
      {
        sql: `UPDATE ${this.resourcesTable} SET fields = ?, generation = CASE generation WHEN ? THEN ? ELSE NULL END WHERE id = ?`,
        params: [JSON.stringify(fields), state.generation, next, state.id],
      },
      ...dropped.map((generation) => ({ sql: this.dropFtsTable(state, generation) })),
    ];
  }

  dropFtsTable(state: ResourceState, generation: number): string {
    return `DROP TABLE IF EXISTS ${this.ftsTable(state, generation)}`;
  }

  /**
   * Write statements (upsert, remove, clear) start with a generation guard, so an instance
   * whose cached generation was retired never writes into a lingering old table.
   *
   * Upsert a JSON array of `{ i, k, t, n, r, f }` documents: drop their old FTS rows, upsert
   * the docs rows (seq is stable across updates), then index the new values.
   */
  upsert(state: ResourceState, documentsJson: string): SqliteStatement[] {
    const fts = this.ftsTable(state, state.generation);
    const docs = this.docsTable(state);
    const ids = `SELECT json_extract(value, '$.i') FROM json_each(?)`;
    return [
      this.guardGeneration(state, state.generation),
      {
        sql: `DELETE FROM ${fts} WHERE rowid IN (SELECT seq FROM ${docs} WHERE doc_id IN (${ids}))`,
        params: [documentsJson],
      },
      {
        sql: `INSERT INTO ${docs} (doc_id, sort_key, id_type, ns, region, fields) SELECT json_extract(value, '$.i'), json_extract(value, '$.k'), json_extract(value, '$.t'), json_extract(value, '$.n'), json_extract(value, '$.r'), json_extract(value, '$.f') FROM json_each(?) WHERE true ON CONFLICT(doc_id) DO UPDATE SET id_type = excluded.id_type, ns = excluded.ns, region = excluded.region, fields = excluded.fields`,
        params: [documentsJson],
      },
      {
        sql: this.populateFts(state, state.generation, state.fields, ` WHERE d.doc_id IN (${ids})`),
        params: [documentsJson],
      },
    ];
  }

  /** Delete a JSON array of doc id strings. */
  remove(state: ResourceState, idsJson: string): SqliteStatement[] {
    const docs = this.docsTable(state);
    const ids = `SELECT value FROM json_each(?)`;
    return [
      this.guardGeneration(state, state.generation),
      {
        sql: `DELETE FROM ${this.ftsTable(state, state.generation)} WHERE rowid IN (SELECT seq FROM ${docs} WHERE doc_id IN (${ids}))`,
        params: [idsJson],
      },
      { sql: `DELETE FROM ${docs} WHERE doc_id IN (${ids})`, params: [idsJson] },
    ];
  }

  clear(state: ResourceState): SqliteStatement[] {
    return [
      this.guardGeneration(state, state.generation),
      { sql: `DELETE FROM ${this.ftsTable(state, state.generation)}` },
      { sql: `DELETE FROM ${this.docsTable(state)}` },
    ];
  }

  /**
   * Ranked matches, each row carrying the published generation. When nothing matches, one
   * row with null doc_id still reports it, so the caller can tell an empty result from a
   * read of a retired generation. Score ties are ordered by sort_key, which gives the same
   * order as comparing the ids with JavaScript `<`.
   */
  search(
    state: ResourceState,
    options: {
      match: string;
      weights: number[];
      namespaceFilter?: string[];
      regionFilter?: string[];
      limit: number;
    },
  ): SqliteStatement {
    const fts = this.ftsTable(state, state.generation);
    const params: Array<string | number> = [state.id, options.match];
    let filters = "";
    if (options.namespaceFilter && options.namespaceFilter.length > 0) {
      filters += ` AND d.ns IN (SELECT value FROM json_each(?))`;
      params.push(JSON.stringify(options.namespaceFilter));
    }
    if (options.regionFilter && options.regionFilter.length > 0) {
      filters += ` AND d.region IN (SELECT value FROM json_each(?))`;
      params.push(JSON.stringify(options.regionFilter));
    }
    params.push(options.limit);
    // bm25() is lower-is-better; negate it so callers see higher-is-better scores.
    const weights = options.weights.map((weight) => String(weight)).join(", ");
    const matches = `SELECT d.doc_id AS doc_id, d.sort_key AS sort_key, d.id_type AS id_type, -bm25(${fts}, ${weights}) AS score FROM ${fts} JOIN ${this.docsTable(state)} d ON d.seq = ${fts}.rowid WHERE ${fts} MATCH ?${filters} ORDER BY score DESC, d.sort_key ASC LIMIT ?`;
    return {
      sql: `SELECT g.generation AS generation, m.doc_id AS doc_id, m.id_type AS id_type, m.score AS score FROM (SELECT generation FROM ${this.resourcesTable} WHERE id = ?) g LEFT JOIN (${matches}) m ON 1 ORDER BY m.score DESC, m.sort_key ASC`,
      params,
    };
  }
}

/**
 * Compile free text into an FTS5 MATCH expression. Every term becomes a quoted string, so
 * FTS5 operators and syntax characters in user input (`AND`, `NEAR`, `"`, `*`, `:`, `^`)
 * are matched literally instead of being parsed. Terms are ANDed.
 */
export function compileMatch(
  query: string,
  options: { columns?: number[]; prefix?: boolean; maxTerms: number },
): string | undefined {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of query.matchAll(QUERY_TOKEN_PATTERN)) {
    const term = match[0];
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= options.maxTerms) break;
  }
  if (terms.length === 0) return undefined;

  const columnFilter = options.columns
    ? `{${options.columns.map((column) => `c${column}`).join(" ")}} : `
    : "";
  const suffix = options.prefix ? "*" : "";
  return terms.map((term) => `${columnFilter}"${term}"${suffix}`).join(" ");
}

export function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}
