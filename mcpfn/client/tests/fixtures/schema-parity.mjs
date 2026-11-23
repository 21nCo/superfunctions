// Tool output schema parity fixture, shared by the Node.js side of the workerd
// test and the Worker bundle. The schemas use draft-07 features whose result
// depends on the validator dialect: a `$ref` with a sibling keyword and tuple
// `items` with `additionalItems`. It has no imports, so the Worker bundle gets
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

/** Calls every parity case with the client's default validator and reports
 * which results it accepted. */
export async function runSchemaParityCases({ createMcpFnClient, streamableHttpTarget }, endpoint) {
  const client = createMcpFnClient({ target: streamableHttpTarget(endpoint) });
  try {
    await client.connect();
    await client.tools.listAll();
    const results = [];
    for (const { tool, value } of schemaParityCases) {
      try {
        await client.tools.call(tool, { value });
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
