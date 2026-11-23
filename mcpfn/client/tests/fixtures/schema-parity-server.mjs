// Node.js side of the schema parity fixture (see schema-parity.mjs).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { schemaParityTools } from "./schema-parity.mjs";

/** A Streamable HTTP MCP server that returns the requested structured content
 * without validating it, so the client's validator alone decides. */
export async function handleSchemaParityRequest(request) {
  const server = new Server(
    { name: "mcpfn-schema-parity-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: schemaParityTools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
    content: [{ type: "text", text: JSON.stringify(params.arguments?.value) }],
    structuredContent: { value: params.arguments?.value },
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
