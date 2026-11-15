export interface SortTerm {
  field: string;
  direction: "asc" | "desc";
}

export type SortInputTerm = string | SortTerm;

function isSortDirection(direction: string): direction is SortTerm["direction"] {
  return direction === "asc" || direction === "desc";
}

/**
 * Parse DFQL sort strings into structured sort terms.
 * Handles "field", "field:asc", "field:desc", "-field".
 * Returns [] for undefined or empty input.
 */
export function parseSortTerm(term: unknown): SortTerm {
  if (typeof term === "object" && term !== null && !Array.isArray(term)) {
    const field = (term as { field?: unknown }).field;
    const rawDirection = (term as { direction?: unknown }).direction;
    const direction = rawDirection === undefined ? "asc" : rawDirection;
    if (typeof field !== "string" || field.length === 0) {
      throw new Error("Invalid sort field");
    }
    if (typeof direction !== "string" || !isSortDirection(direction)) {
      throw new Error(`Invalid sort direction "${String(direction)}" for field "${field}"`);
    }
    return { field, direction };
  }
  if (typeof term !== "string" || term.length === 0) {
    throw new Error("Invalid sort term");
  }
  if (term.startsWith("-")) {
    if (term.length === 1) throw new Error("Invalid sort field");
    return { field: term.slice(1), direction: "desc" };
  }
  const colonIdx = term.indexOf(":");
  if (colonIdx !== -1) {
    const field = term.slice(0, colonIdx);
    const direction = term.slice(colonIdx + 1);
    if (!field) throw new Error("Invalid sort field");
    if (!isSortDirection(direction)) {
      throw new Error(`Invalid sort direction "${direction}" for term "${term}"`);
    }
    return { field, direction };
  }
  return { field: term, direction: "asc" };
}

export function parseSortTerms(sort: SortInputTerm[] | undefined): SortTerm[] {
  if (!sort || sort.length === 0) return [];
  return sort.map(parseSortTerm);
}

const NUMERIC_STRING = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** A finite number for numbers and decimal numeric strings, otherwise undefined. */
function comparableNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isNaN(value) ? undefined : value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0 && NUMERIC_STRING.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Compare two field values in ascending order. The order is total, so a full
 * sort and a limited (top N) selection agree on any mix of values:
 * - null and undefined are equal to each other and sort after every other value;
 * - numbers and numeric strings compare as numbers (`"9" < "10"`, `"9"` equals `9`)
 *   and sort before every non-numeric value;
 * - other values compare by their string form with `localeCompare`.
 */
export function compareSortValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  const aNullish = isNullish(a);
  const bNullish = isNullish(b);
  if (aNullish || bNullish) {
    if (aNullish && bNullish) return 0;
    return aNullish ? 1 : -1;
  }
  const aNumber = comparableNumber(a);
  const bNumber = comparableNumber(b);
  if (aNumber !== undefined && bNumber !== undefined) {
    return aNumber < bNumber ? -1 : aNumber > bNumber ? 1 : 0;
  }
  if (aNumber !== undefined) return -1;
  if (bNumber !== undefined) return 1;
  return String(a).localeCompare(String(b));
}

/** Plain code-unit order, the order the server uses for ids. */
export function compareIds(a: unknown, b: unknown): number {
  const aId = String(a ?? "");
  const bId = String(b ?? "");
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * Compare two records by the given terms with a stable id tie-breaker.
 * Null values sort after non-null in ascending order (before in descending).
 */
export function compareRecords(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  terms: SortTerm[],
): number {
  for (const term of terms) {
    // Ids keep the server's code-unit order whether they are the tie-break
    // or an explicit sort term.
    const cmp = term.field === "id"
      ? compareIds(a.id, b.id)
      : compareSortValues(a[term.field], b[term.field]);
    if (cmp !== 0) return term.direction === "asc" ? cmp : -cmp;
  }
  return compareIds(a.id, b.id);
}

/**
 * Sort records by the given terms with a stable id tie-breaker.
 * Null values sort after non-null in ascending order (before in descending).
 */
export function sortRecords(
  records: Record<string, unknown>[],
  terms: SortTerm[],
): Record<string, unknown>[] {
  return [...records].sort((a, b) => compareRecords(a, b, terms));
}
