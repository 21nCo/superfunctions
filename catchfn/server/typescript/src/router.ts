import { createRouter } from '@superfunctions/http';
import type { CatchFnService } from './service';
import type { BugReportEvent } from 'catchfn';

export function createCatchFnRouter(service: CatchFnService) {
  return createRouter({
    routes: [
      {
        method: 'POST',
        path: '/bugs',
        handler: async (req, ctx) => {
          try {
            const body = await ctx.json() as BugReportEvent;
            // Basic validation could go here
            if (!body.title || !body.severity) {
              return Response.json({ error: 'Missing required fields' }, { status: 400 });
            }
            
            const bug = await service.createBug(body);
            return Response.json(bug, { status: 201 });
          } catch (error) {
            console.error('Failed to create bug report:', error);
            return Response.json({ error: 'Internal Server Error' }, { status: 500 });
          }
        },
      },
      {
        method: 'GET',
        path: '/bugs/:id',
        handler: async (req, ctx) => {
          const bug = await service.getBug(ctx.params.id);
          if (!bug) {
            return Response.json({ error: 'Bug not found' }, { status: 404 });
          }
          return Response.json(bug);
        },
      },
      {
        method: 'GET',
        path: '/bugs',
        handler: async (req, ctx) => {
          const limit = parseInt(ctx.query.get('limit') || '50', 10);
          const offset = parseInt(ctx.query.get('offset') || '0', 10);
          const bugs = await service.listBugs(limit, offset);
          return Response.json(bugs);
        },
      },
    ],
  });
}
