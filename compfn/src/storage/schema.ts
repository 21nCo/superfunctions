/**
 * Storage schema for compfn: controls, frameworks, evidence, checks.
 * Tables are namespaced (e.g. compfn_controls) via adapter namespace.
 */

import type { TableSchema, TableSchemaMap } from "@superfunctions/db";

export interface CompfnSchemaOptions {
  namespace?: string;
}

const DEFAULT_NAMESPACE = "compfn";

function ns(options: CompfnSchemaOptions, suffix: string): string {
  const prefix = options.namespace ?? DEFAULT_NAMESPACE;
  return `${prefix}_${suffix}`;
}

export function getCompfnSchema(options: CompfnSchemaOptions = {}): {
  version: number;
  schemas: TableSchema[];
} {
  const controls: TableSchema = {
    modelName: "controls",
    fields: {
      id: { type: "string", required: true, unique: true },
      name: { type: "string", required: true },
      description: { type: "string", required: true },
      category: { type: "string", required: true },
      tags: { type: "json", required: false },
      createdAt: { type: "number", required: true },
      updatedAt: { type: "number", required: true },
    },
    indexes: [
      { name: ns(options, "controls_category_idx"), fields: ["category"] },
      { name: ns(options, "controls_updated_idx"), fields: ["updatedAt"] },
    ],
  };

  const frameworks: TableSchema = {
    modelName: "frameworks",
    fields: {
      id: { type: "string", required: true, unique: true },
      name: { type: "string", required: true },
      version: { type: "string", required: false },
      description: { type: "string", required: false },
      requirements: { type: "json", required: true },
      createdAt: { type: "number", required: true },
      updatedAt: { type: "number", required: true },
    },
    indexes: [
      { name: ns(options, "frameworks_updated_idx"), fields: ["updatedAt"] },
    ],
  };

  const evidence: TableSchema = {
    modelName: "evidence",
    fields: {
      id: { type: "string", required: true, unique: true },
      controlId: { type: "string", required: true },
      type: { type: "string", required: true },
      sourceId: { type: "string", required: false },
      frameworkRequirementId: { type: "string", required: false },
      timestamp: { type: "number", required: true },
      actorId: { type: "string", required: true },
      outcome: { type: "string", required: true },
      payload: { type: "json", required: false },
      artifactRef: { type: "string", required: false },
      createdAt: { type: "number", required: true },
    },
    indexes: [
      { name: ns(options, "evidence_control_idx"), fields: ["controlId"] },
      { name: ns(options, "evidence_timestamp_idx"), fields: ["timestamp"] },
      { name: ns(options, "evidence_type_idx"), fields: ["type"] },
      { name: ns(options, "evidence_created_idx"), fields: ["createdAt"] },
    ],
  };

  const checks: TableSchema = {
    modelName: "checks",
    fields: {
      id: { type: "string", required: true, unique: true },
      name: { type: "string", required: true },
      controlId: { type: "string", required: true },
      schedule: { type: "string", required: false },
      trigger: { type: "string", required: false },
      adapterName: { type: "string", required: false },
      adapterMethod: { type: "string", required: false },
      customConfig: { type: "json", required: false },
      createdAt: { type: "number", required: true },
      updatedAt: { type: "number", required: true },
    },
    indexes: [
      { name: ns(options, "checks_control_idx"), fields: ["controlId"] },
      { name: ns(options, "checks_updated_idx"), fields: ["updatedAt"] },
    ],
  };

  return {
    version: 1,
    schemas: [controls, frameworks, evidence, checks],
  };
}

export function getCompfnSchemaMap(options: CompfnSchemaOptions = {}): TableSchemaMap {
  const { schemas } = getCompfnSchema(options);
  return Object.fromEntries(schemas.map((s) => [s.modelName, s]));
}
