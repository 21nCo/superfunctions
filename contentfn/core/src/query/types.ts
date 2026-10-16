/**
 * ContentFn Query Language (CFQL) types (SPEC.md).
 */

import type { ContentfnDocument } from "../schema/types.js";

export type CfqlOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "is_null"
  | "is_not_null"
  | "match";

export type CfqlFilter =
  | { op: "and"; filters: CfqlFilter[] }
  | { op: "or"; filters: CfqlFilter[] }
  | { field: string; op: CfqlOperator; value?: unknown };

export interface CfqlOrderBy {
  field: string;
  direction: "asc" | "desc";
}

export interface CfqlProjection {
  fields?: string[];
  expand?: Record<
    string,
    {
      field: string;
      projection?: CfqlProjection;
    }
  >;
}

export interface CfqlQuery {
  dataset: string;
  types?: string[];
  filter?: CfqlFilter;
  orderBy?: CfqlOrderBy[];
  projection?: CfqlProjection;
  limit?: number;
  cursor?: string | null;
}

export interface CfqlResultPage {
  data: ContentfnDocument[];
  nextCursor: string | null;
}

export const CFQL_OPERATORS: ReadonlySet<CfqlOperator> = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
  "is_null",
  "is_not_null",
  "match",
]);
