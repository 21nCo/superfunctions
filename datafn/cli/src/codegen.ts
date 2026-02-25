import {
  type DatafnSchema,
  validateSchema,
  unwrapEnvelope,
} from "@datafn/core";

/**
 * Generate TypeScript definitions from a DataFn schema.
 *
 * Generates:
 * - Interfaces for each resource
 * - 'Tables' mapping type
 * - 'TypedClient' type
 *
 * @param schemaInput DataFn schema input (untrusted)
 * @returns TypeScript code string
 */
export function generateTypes(schemaInput: unknown): string {
  // Validate schema first (deterministic rejection via envelope)
  const schema = unwrapEnvelope(validateSchema(schemaInput));

  const lines: string[] = [];

  // Preamble
  lines.push(
    `import type { DatafnClient, DatafnTable } from "@datafn/client";`,
  );
  lines.push("");

  // Sort resources by name to ensure stable output (deterministic)
  // We clone first to avoid mutating input
  const resources = [...schema.resources].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Generate an interface for each resource
  for (const resource of resources) {
    const pascalName = toPascalCase(resource.name);
    lines.push(`export interface ${pascalName} {`);

    // Sort fields for stability
    const fields = [...resource.fields].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    for (const field of fields) {
      const tsType = mapFieldType(field.type);
      const optional = field.required ? "" : "?";
      lines.push(`  ${field.name}${optional}: ${tsType};`);
    }

    lines.push("}");
    lines.push("");
  }

  // Generate interfaces for many-many join tables with metadata
  const relations = schema.relations ?? [];
  const joinTableInterfaces: Array<{ name: string; pascalName: string }> = [];

  for (const rel of relations) {
    if (rel.type !== "many-many" || !rel.metadata || rel.metadata.length === 0) {
      continue;
    }

    const jtName = rel.joinTable ?? `__datafn_join_${Array.isArray(rel.from) ? rel.from[0] : rel.from}_${rel.relation ?? (Array.isArray(rel.to) ? rel.to[0] : rel.to)}`;
    const pascalName = toPascalCase(jtName);
    const fromCol = rel.joinColumns?.from ?? "fromId";
    const toCol = rel.joinColumns?.to ?? "toId";

    lines.push(`export interface ${pascalName} {`);
    lines.push(`  ${fromCol}: string;`);
    lines.push(`  ${toCol}: string;`);

    // Sort metadata fields for stability
    const sortedMeta = [...rel.metadata].sort((a, b) => a.name.localeCompare(b.name));
    for (const meta of sortedMeta) {
      const tsType = mapFieldType(meta.type);
      lines.push(`  ${meta.name}: ${tsType};`);
    }

    lines.push("}");
    lines.push("");

    joinTableInterfaces.push({ name: jtName, pascalName });
  }

  // Generate 'Tables' mapping type
  lines.push("export interface Tables {");
  for (const resource of resources) {
    const pascalName = toPascalCase(resource.name);
    lines.push(`  ${resource.name}: ${pascalName};`);
  }
  for (const jt of joinTableInterfaces) {
    lines.push(`  ${jt.name}: ${jt.pascalName};`);
  }
  lines.push("}");
  lines.push("");

  // Generate 'TypedClient'
  lines.push("export type TypedClient = DatafnClient & {");
  for (const resource of resources) {
    const pascalName = toPascalCase(resource.name);
    // Expose table getters directly on client if desired (TV-CODEGEN-001 doesn't strictly verify accessors, just types)
    // But typically typed client might have `task: DatafnTable<Task>`
    lines.push(`  ${resource.name}: DatafnTable<${pascalName}>;`);
  }
  lines.push("};");
  lines.push("");

  return lines.join("\n");
}

function toPascalCase(str: string): string {
  // Simple conversion: task -> Task, my_task -> MyTask
  return str.replace(/(^|_)(\w)/g, (_all, _sep, char) => char.toUpperCase());
}

function mapFieldType(type: string): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "Record<string, unknown>";
    case "array":
      return "unknown[]";
    case "date":
      return "number"; // timestamp
    case "file":
      return "string"; // url or id
    default:
      return "unknown";
  }
}
