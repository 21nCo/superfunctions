import type { Adapter, TableSchemaMap } from "@superfunctions/db";
import { wrapWithSchema } from "@superfunctions/db/schema";

/**
 * CmsFn owns serialization; applications supply adapters without adapterSchema.
 * SQL tables use TEXT for rules/docIds; timestamps remain ISO strings.
 * This descriptor does not create tables or migrate existing native JSON columns.
 */
export function getCmsfnStorageSchema(): TableSchemaMap {
  return {
    cmsfn_roles: {
      modelName: "cmsfn_roles",
      fields: {
        id: { type: "string", required: true, unique: true },
        name: { type: "string", required: true },
        rules: { type: "json", jsonStorageType: "json-text", required: true },
      },
    },
    cmsfn_releases: {
      modelName: "cmsfn_releases",
      fields: {
        releaseId: { type: "string", required: true, unique: true },
        dataset: { type: "string", required: true },
        name: { type: "string", required: true },
        publishAt: { type: "string" },
        docIds: { type: "json", jsonStorageType: "json-text", required: true },
        createdAt: { type: "string", required: true },
        updatedAt: { type: "string", required: true },
      },
      indexes: [{ name: "cmsfn_releases_dataset", fields: ["dataset"] }],
    },
  };
}

const adapters = new WeakMap<Adapter, Adapter>();

/** Retains the supplied adapter's table mapping, namespace and lifecycle. */
export function cmsfnStorageAdapter(adapter: Adapter): Adapter {
  let wrapped = adapters.get(adapter);
  if (!wrapped) {
    const schema = getCmsfnStorageSchema();
    // Memory already holds native arrays, including rows written before CmsFn
    // owned its schema. SQL persistence uses explicit TEXT JSON columns.
    if (adapter.id === "memory") {
      schema.cmsfn_roles.fields.rules.jsonStorageType = "native";
      schema.cmsfn_releases.fields.docIds.jsonStorageType = "native";
    }
    wrapped = wrapWithSchema(adapter, schema);
    adapters.set(adapter, wrapped);
  }
  return wrapped;
}
