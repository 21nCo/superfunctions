// Tool output schema parity fixture, shared by the Node.js side of the workerd
// test and the Worker bundle. The schemas use draft-07 features whose result
// depends on the validator dialect: a `$ref` with a sibling keyword and tuple
// `items` with `additionalItems`. The declared-dialect tools below cover a
// `$schema` per draft. It has no imports, so the Worker bundle gets
// only the client under test.

export const schemaParityTools = [
  {
    name: "bounded",
    description: "Returns its value; the schema puts a maximum beside a $ref.",
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      required: ["value"],
      definitions: { limit: { type: "number" } },
      properties: { value: { $ref: "#/definitions/limit", maximum: 10 } },
    },
  },
  {
    name: "pair",
    description: "Returns its value; the schema is a draft-07 tuple.",
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      required: ["value"],
      properties: {
        value: { type: "array", items: [{ type: "string" }, { type: "number" }], additionalItems: false },
      },
    },
  },
];

export const schemaParityCases = [
  { tool: "bounded", value: 5 },
  { tool: "bounded", value: 50 },
  { tool: "pair", value: ["a", 1] },
  { tool: "pair", value: ["a", "b"] },
  { tool: "pair", value: ["a", 1, true] },
];

// Schemas that declare their dialect. The edge validator applies the declared
// draft (the Node.js Ajv default cannot load a draft-04 meta-schema, so these
// assert the declared dialect's verdict, not Ajv's).
export const declaredDialectTools = [
  {
    name: "draft07-ref-sibling",
    description: "Draft-07: the minLength beside the $ref is ignored.",
    inputSchema: { type: "object" },
    outputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      required: ["value"],
      definitions: { name: { type: "string" } },
      properties: { value: { $ref: "#/definitions/name", minLength: 2 } },
    },
  },
  {
    name: "draft04-exclusive-minimum",
    description: "Draft-04: a boolean exclusiveMinimum excludes the minimum.",
    inputSchema: { type: "object" },
    outputSchema: {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
      required: ["value"],
      properties: { value: { type: "number", minimum: 5, exclusiveMinimum: true } },
    },
  },
  {
    name: "draft2020-prefix-items",
    description: "2020-12 over https without the empty fragment.",
    inputSchema: { type: "object" },
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["value"],
      properties: { value: { type: "array", prefixItems: [{ type: "string" }], items: false } },
    },
  },
  {
    name: "draft06-unsupported",
    description: "A dialect the edge validator cannot apply.",
    inputSchema: { type: "object" },
    outputSchema: {
      $schema: "http://json-schema.org/draft-06/schema#",
      type: "object",
      properties: { value: { type: "number" } },
    },
  },
];

export const declaredDialectCases = [
  { tool: "draft07-ref-sibling", value: "a" },
  { tool: "draft07-ref-sibling", value: 5 },
  { tool: "draft04-exclusive-minimum", value: 5 },
  { tool: "draft04-exclusive-minimum", value: 6 },
  { tool: "draft2020-prefix-items", value: ["a"] },
  { tool: "draft2020-prefix-items", value: ["a", 1] },
  { tool: "draft06-unsupported", value: 1 },
];

/** Calls every case (the parity cases by default) with the client's default
 * validator and reports which results it accepted. */
export async function runSchemaParityCases(
  { createMcpFnClient, streamableHttpTarget },
  endpoint,
  cases = schemaParityCases,
) {
  const client = createMcpFnClient({ target: streamableHttpTarget(endpoint) });
  try {
    await client.connect();
    await client.tools.listAll();
    const results = [];
    for (const { tool, value } of cases) {
      try {
        // Sequential on purpose: one connection, verdicts recorded in case order.
        await client.tools.call(tool, { value }); // NOSONAR
        results.push({ tool, value, accepted: true });
      } catch (error) {
        results.push({ tool, value, accepted: false, message: String(error?.cause?.message ?? error?.message ?? error) });
      }
    }
    return results;
  } finally {
    await client.close();
  }
}
