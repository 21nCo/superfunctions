import { z } from 'zod';
import type { Provider } from '../../types/provider.js';
import { AuthType } from '../../types/provider.js';
import { TriggerType } from '../../types/trigger.js';
import type { ActionContext } from '../../types/action.js';

/**
 * Linear provider
 */
export const linearProvider: Provider = {
  name: 'linear',
  displayName: 'Linear',
  version: '1.0.0',
  description: 'Integration with Linear for issue tracking and project management',
  iconUrl: 'https://linear.app/favicon.ico',
  baseUrl: 'https://api.linear.app/graphql',

  auth: {
    type: 'oauth2' as AuthType.OAuth2,
    config: {
      authorizationUrl: 'https://linear.app/oauth/authorize',
      tokenUrl: 'https://api.linear.app/oauth/token',
      scopes: ['read', 'write'],
      scopeSeparator: ',',
    },
  },

  actions: {
    // Create issue
    'issues.create': {
      name: 'issues.create',
      displayName: 'Create Issue',
      description: 'Create a new issue in Linear',

      parameters: z.object({
        teamId: z.string().describe('Team ID'),
        title: z.string().describe('Issue title'),
        description: z.string().optional().describe('Issue description'),
        priority: z.number().optional().describe('Priority (0-4)'),
        labels: z.array(z.string()).optional().describe('Label IDs'),
        assigneeId: z.string().optional().describe('Assignee user ID'),
        externalId: z.string().optional().describe('External ID for syncing'),
      }),

      returns: z.object({
        success: z.boolean(),
        issue: z.object({
          id: z.string(),
          title: z.string(),
          identifier: z.string(),
          url: z.string(),
          createdAt: z.string(),
        }),
      }),

      execute: async (params: any, context: ActionContext) => {
        const mutation = `
          mutation IssueCreate($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue {
                id
                title
                identifier
                url
                createdAt
              }
            }
          }
        `;

        const response = await context.http.post(context.provider.baseUrl, {
          query: mutation,
          variables: {
            input: {
              teamId: params.teamId,
              title: params.title,
              description: params.description,
              priority: params.priority,
              labelIds: params.labels,
              assigneeId: params.assigneeId,
            },
          },
        });

        return response.data.data.issueCreate;
      },
    },

    // List issues
    'issues.list': {
      name: 'issues.list',
      displayName: 'List Issues',
      description: 'List issues for a team',

      parameters: z.object({
        teamId: z.string().describe('Team ID'),
        first: z.number().optional().describe('Number of issues to return'),
      }),

      returns: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            identifier: z.string(),
            url: z.string(),
            state: z.object({
              name: z.string(),
            }),
            assignee: z
              .object({
                name: z.string(),
                email: z.string(),
              })
              .nullable(),
          })
        ),
      }),

      execute: async (params: any, context: ActionContext) => {
        const query = `
          query Issues($teamId: String!, $first: Int) {
            team(id: $teamId) {
              issues(first: $first) {
                nodes {
                  id
                  title
                  identifier
                  url
                  state {
                    name
                  }
                  assignee {
                    name
                    email
                  }
                }
              }
            }
          }
        `;

        const response = await context.http.post(context.provider.baseUrl, {
          query,
          variables: {
            teamId: params.teamId,
            first: params.first || 50,
          },
        });

        return response.data.data.team.issues;
      },
    },

    // Update issue
    'issues.update': {
      name: 'issues.update',
      displayName: 'Update Issue',
      description: 'Update an existing issue',

      parameters: z.object({
        issueId: z.string().describe('Issue ID'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        priority: z.number().optional().describe('New priority'),
        stateId: z.string().optional().describe('New state ID'),
      }),

      returns: z.object({
        success: z.boolean(),
        issue: z.object({
          id: z.string(),
          title: z.string(),
          identifier: z.string(),
        }),
      }),

      execute: async (params: any, context: ActionContext) => {
        const mutation = `
          mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              success
              issue {
                id
                title
                identifier
              }
            }
          }
        `;

        const response = await context.http.post(context.provider.baseUrl, {
          query: mutation,
          variables: {
            id: params.issueId,
            input: {
              title: params.title,
              description: params.description,
              priority: params.priority,
              stateId: params.stateId,
            },
          },
        });

        return response.data.data.issueUpdate;
      },
    },

    // List teams
    'teams.list': {
      name: 'teams.list',
      displayName: 'List Teams',
      description: 'List all teams in the workspace',

      parameters: z.object({
        first: z.number().optional().describe('Number of teams to return'),
      }),

      returns: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            key: z.string(),
          })
        ),
      }),

      execute: async (params: any, context: ActionContext) => {
        const query = `
          query Teams($first: Int) {
            teams(first: $first) {
              nodes {
                id
                name
                key
              }
            }
          }
        `;

        const response = await context.http.post(context.provider.baseUrl, {
          query,
          variables: {
            first: params.first || 50,
          },
        });

        return response.data.data.teams;
      },
    },
  },

  triggers: {
    'issue.created': {
      name: 'issue.created',
      displayName: 'Issue Created',
      description: 'Triggered when an issue is created',
      type: TriggerType.Webhook,

      webhookConfig: {
        path: '/webhooks/linear/issue',
        method: 'POST',
      },

      schema: z.object({
        action: z.literal('create'),
        data: z.object({
          id: z.string(),
          title: z.string(),
          identifier: z.string(),
          url: z.string(),
        }),
      }),

      handler: async (payload) => {
        return {
          event: 'issue.created',
          data: payload.data,
        };
      },
    },
  },

  rateLimit: {
    requests: 1000,
    window: 60000, // 1 minute
  },

  headers: {
    'Content-Type': 'application/json',
  },
};

