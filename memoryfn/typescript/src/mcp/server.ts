import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { IMemoryFn } from '../core/config';
import { AddMemoryInput, SearchMemoryInput } from '../core/types';

export class MemoryMCP {
  private server: Server;
  private memory: IMemoryFn;

  constructor(memory: IMemoryFn) {
    this.memory = memory;
    
    this.server = new Server(
      {
        name: 'memoryfn-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'add_memory',
            description: 'Add a new memory to the user\'s long-term storage.',
            inputSchema: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'The fact or information to store' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags to organize the memory' }
              },
              required: ['content']
            }
          },
          {
            name: 'search_memories',
            description: 'Search for memories relevant to a query.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'The search query' },
                limit: { type: 'number', description: 'Number of results to return' }
              },
              required: ['query']
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case 'add_memory': {
          const content = String(request.params.arguments?.content);
          const tags = (request.params.arguments?.tags as string[]) || [];
          
          await this.memory.add({
            content,
            containerTags: tags, // In real usage, might inject user context tags here
            type: 'conversational'
          });
          
          return {
            content: [{ type: 'text', text: 'Memory added successfully.' }]
          };
        }

        case 'search_memories': {
          const query = String(request.params.arguments?.query);
          const limit = Number(request.params.arguments?.limit) || 5;
          
          const result = await this.memory.search({
            q: query,
            limit,
            containerTags: [] // Needs context in real usage
          });

          const text = result.results.map(r => `- ${r.content}`).join('\n');
          return {
            content: [{ type: 'text', text: text || 'No relevant memories found.' }]
          };
        }

        default:
          throw new Error('Unknown tool');
      }
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MemoryFn MCP Server running on stdio');
  }
}
