import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpFnManifest } from "@mcpfn/core";

import type { McpFnTestClient } from "./client.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class McpFnAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpFnAssertionError";
  }
}

export async function assertManifestContract(
  client: McpFnTestClient<unknown>,
  manifest: McpFnManifest,
): Promise<Tool[]> {
  const actual = await client.listTools();
  const actualByName = new Map(actual.map((tool) => [tool.name, tool]));
  const expectedNames = manifest.tools.map((tool) => tool.name).sort();
  const actualNames = actual.map((tool) => tool.name).sort();
  if (stable(expectedNames) !== stable(actualNames)) {
    throw new McpFnAssertionError(
      `Tool inventory mismatch\nexpected: ${stable(expectedNames)}\nactual:   ${stable(actualNames)}`,
    );
  }
  for (const expected of manifest.tools) {
    const tool = actualByName.get(expected.name)!;
    const comparableExpected = {
      name: expected.name,
      description: expected.description,
      inputSchema: expected.inputSchema,
      outputSchema: expected.outputSchema,
      annotations: expected.annotations,
      execution: expected.execution,
      icons: expected.icons,
      title: expected.title,
      _meta: expected.metadata,
    };
    const comparableActual = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      execution: tool.execution,
      icons: tool.icons,
      title: tool.title,
      _meta: tool._meta,
    };
    if (stable(comparableExpected) !== stable(comparableActual)) {
      throw new McpFnAssertionError(
        `Contract mismatch for ${expected.name}\nexpected: ${stable(comparableExpected)}\nactual:   ${stable(comparableActual)}`,
      );
    }
  }

  const actualResources = manifest.capabilities?.resources
    ? await client.listResources()
    : [];
  const actualResourcesByUri = new Map(actualResources.map((resource) => [resource.uri, resource]));
  for (const expected of manifest.resources ?? []) {
    const resource = actualResourcesByUri.get(expected.uri);
    if (!resource) {
      throw new McpFnAssertionError(`Missing resource ${expected.uri}`);
    }
    const { metadata, ...expectedFields } = expected;
    if (stable({ ...expectedFields, _meta: metadata }) !== stable(resource)) {
      throw new McpFnAssertionError(
        `Contract mismatch for resource ${expected.uri}\nexpected: ${stable({ ...expectedFields, _meta: metadata })}\nactual:   ${stable(resource)}`,
      );
    }
  }

  const actualTemplates = manifest.capabilities?.resources
    ? await client.listResourceTemplates()
    : [];
  const comparableTemplates = actualTemplates.map(({ _meta, ...template }) => ({
    ...template,
    metadata: _meta,
  }));
  if (stable(manifest.resourceTemplates ?? []) !== stable(comparableTemplates)) {
    throw new McpFnAssertionError(
      `Resource template inventory mismatch\nexpected: ${stable(manifest.resourceTemplates ?? [])}\nactual:   ${stable(comparableTemplates)}`,
    );
  }

  const actualPrompts = manifest.capabilities?.prompts
    ? await client.listPrompts()
    : [];
  const comparablePrompts = actualPrompts.map(({ _meta, ...prompt }) => ({
    ...prompt,
    metadata: _meta,
  }));
  const expectedPrompts = (manifest.prompts ?? []).map(({ argumentsSchema: _schema, ...prompt }) => prompt);
  if (stable(expectedPrompts) !== stable(comparablePrompts)) {
    throw new McpFnAssertionError(
      `Prompt inventory mismatch\nexpected: ${stable(expectedPrompts)}\nactual:   ${stable(comparablePrompts)}`,
    );
  }
  return actual;
}

export function assertStructuredTextParity(result: {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
}): void {
  if (!result.structuredContent) {
    throw new McpFnAssertionError("Tool result has no structuredContent");
  }
  const text = (result.content ?? []).find(
    (entry): entry is { type: "text"; text: string } =>
      !!entry &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string",
  )?.text;
  if (!text) {
    throw new McpFnAssertionError("Tool result has no text content");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpFnAssertionError("Tool text content is not JSON");
  }
  if (stable(parsed) !== stable(result.structuredContent)) {
    throw new McpFnAssertionError(
      "Tool text content and structuredContent are not equivalent",
    );
  }
}
