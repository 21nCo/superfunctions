import { z } from "zod";
import { Tool } from "./base.js";

const ApiCallSchema = z.object({
  url: z.string().describe("The URL to call"),
  method: z.string().default("GET").describe("The HTTP method (GET, POST, etc.)"),
  headers: z.record(z.string()).optional().describe("HTTP headers"),
  body: z.any().optional().describe("Request body")
});

export const ApiCallTool = new Tool({
  name: "api_call",
  description: "Make an HTTP API call to a remote service.",
  schema: ApiCallSchema,
  execute: async (args) => {
    const response = await fetch(args.url, {
      method: args.method,
      headers: args.headers,
      body: args.body ? JSON.stringify(args.body) : undefined
    });
    
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return response.json();
    }
    return response.text();
  }
});
