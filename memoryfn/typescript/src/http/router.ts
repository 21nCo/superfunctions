import { createRouter, Route } from '@superfunctions/http';
import { IMemoryFn } from '../core/config';
import { AddMemoryInput, SearchMemoryInput } from '../core/types';

export function createMemoryRouter(memory: IMemoryFn) {
  const routes: Route[] = [
    {
      method: 'POST',
      path: '/v1/memories',
      handler: async (req, ctx) => {
        const body = await ctx.json();
        // Validate body (using Zod in a real implementation)
        const input = body as AddMemoryInput;
        const result = await memory.add(input);
        return Response.json(result);
      }
    },
    {
      method: 'POST',
      path: '/v1/memories/search',
      handler: async (req, ctx) => {
        const body = await ctx.json();
        const input = body as SearchMemoryInput;
        const result = await memory.search(input);
        return Response.json(result);
      }
    }
  ];

  return createRouter({ routes });
}
