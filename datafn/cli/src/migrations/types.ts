/**
 * Migration Types
 *
 * DataFn Schema Migration Plan definitions.
 */

import type { DatafnSchema } from "@datafn/core";

export type RelationType = "one-to-one" | "one-to-many" | "many-to-many";
export type IndexType = "base" | "search" | "vector";

export type MigrationChange =
  | { kind: "addResource"; resource: string }
  | { kind: "removeResource"; resource: string }
  | {
      kind: "addField";
      resource: string;
      field: string;
      type: string;
      required: boolean;
    }
  | { kind: "removeField"; resource: string; field: string }
  | {
      kind: "alterField";
      resource: string;
      field: string;
      changes: { type?: string; required?: boolean };
    }
  | {
      kind: "addRelation";
      from: string;
      to: string;
      type: RelationType;
      relation?: string;
      inverse?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "removeRelation";
      from: string;
      to: string;
      relation: string;
    }
  | {
      kind: "addIndex";
      resource: string;
      indexType: IndexType;
      fields: string[];
    }
  | {
      kind: "removeIndex";
      resource: string;
      indexType: IndexType;
      fields: string[];
    };

export interface MigrationPlan {
  changes: MigrationChange[];
}

export interface MigrationContext {
  /** Target database dialect */
  dialect: "postgres" | "mysql" | "sqlite";
  /** Target ORM adapter */
  adapter: "drizzle" | "prisma" | "kysely" | "raw";
  /** The 'from' schema (null if creating from scratch) */
  fromSchema: DatafnSchema | null;
  /** The 'to' schema */
  toSchema: DatafnSchema;
  /** Namespace prefix for tables (e.g., for join tables) */
  namespace?: string;
  /** Join table prefix (default: '__datafn_join_') */
  joinTablePrefix?: string;
}
