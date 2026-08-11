import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
  type McpFnManifest,
  type McpFnServer,
} from '@mcpfn/core';

import type { IMemoryFn } from '../core/config';

export class MemoryMCP {
  readonly registry: McpFnRegistry;
  readonly server: McpFnServer;

  constructor(private readonly memory: IMemoryFn) {
    this.registry = new McpFnRegistry()
      .register({
        name: 'add_memory',
        description: 'Add a new memory to long-term storage.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              minLength: 1,
              description: 'The fact or information to store',
            },
            tags: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              uniqueItems: true,
              description: 'Tags used to scope and organize the memory',
            },
          },
          required: ['content'],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        metadata: { 'mcpfn/source': 'memoryfn' },
        handler: async (args) => {
          const result = await this.memory.add({
            content: args.content as string,
            containerTags: (args.tags as string[] | undefined) ?? [],
            type: 'conversational',
          });
          return structuredResult(
            { result },
            [{ type: 'text', text: 'Memory added successfully.' }],
          );
        },
      })
      .register({
        name: 'search_memories',
        description: 'Search for memories relevant to a query.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              description: 'The search query',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 5,
              description: 'Maximum number of results to return',
            },
            tags: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              uniqueItems: true,
              description: 'Optional memory scope tags',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        metadata: { 'mcpfn/source': 'memoryfn' },
        handler: async (args) => {
          const result = await this.memory.search({
            q: args.query as string,
            limit: (args.limit as number | undefined) ?? 5,
            containerTags: (args.tags as string[] | undefined) ?? [],
          });
          const text = result.results.map((entry) => `- ${entry.content}`).join('\n');
          return structuredResult(
            { result },
            [{ type: 'text', text: text || 'No relevant memories found.' }],
          );
        },
      });

    this.server = createMcpFnServer({
      info: {
        name: 'memoryfn-mcp',
        version: '0.1.0',
        instructions: 'Store and retrieve long-term memories through MemoryFn.',
      },
      registry: this.registry,
      transports: ['stdio'],
    });
  }

  manifest(): McpFnManifest {
    return this.server.manifest();
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async start(): Promise<void> {
    await this.server.serveStdio();
    console.error('MemoryFn MCP Server running on stdio');
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}
