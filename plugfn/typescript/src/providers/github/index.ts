import { z } from 'zod';
import type { Provider } from '../../types/provider.js';
import { AuthType } from '../../types/provider.js';
import { TriggerType } from '../../types/trigger.js';
import type { ActionContext } from '../../types/action.js';

/**
 * GitHub provider
 */
export const githubProvider: Provider = {
  name: 'github',
  displayName: 'GitHub',
  version: '1.0.0',
  description: 'Integration with GitHub for managing repositories, issues, and pull requests',
  iconUrl: 'https://github.com/favicon.ico',
  baseUrl: 'https://api.github.com',

  auth: {
    type: 'oauth2' as AuthType.OAuth2,
    config: {
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'user', 'read:org'],
      scopeSeparator: ' ',
    },
  },

  actions: {
    // Get repository
    'repos.get': {
      name: 'repos.get',
      displayName: 'Get Repository',
      description: 'Get a repository by owner and name',

      parameters: z.object({
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
      }),

      returns: z.object({
        id: z.number(),
        name: z.string(),
        full_name: z.string(),
        description: z.string().nullable(),
        html_url: z.string(),
        clone_url: z.string(),
        default_branch: z.string(),
        stargazers_count: z.number(),
        watchers_count: z.number(),
        forks_count: z.number(),
      }),

      execute: async (params: any, context: ActionContext) => {
        const response = await context.http.get(
          `${context.provider.baseUrl}/repos/${params.owner}/${params.repo}`
        );
        return response.data;
      },
    },

    // List issues
    'issues.list': {
      name: 'issues.list',
      displayName: 'List Issues',
      description: 'List issues for a repository',

      parameters: z.object({
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
        state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state'),
        labels: z.array(z.string()).optional().describe('Filter by labels'),
      }),

      returns: z.array(
        z.object({
          id: z.number(),
          number: z.number(),
          title: z.string(),
          body: z.string().nullable(),
          state: z.string(),
          html_url: z.string(),
          user: z.object({
            login: z.string(),
            avatar_url: z.string(),
          }),
          labels: z.array(
            z.object({
              name: z.string(),
              color: z.string(),
            })
          ),
          created_at: z.string(),
          updated_at: z.string(),
        })
      ),

      execute: async (params: any, context: ActionContext) => {
        const queryParams: any = {};
        if (params.state) queryParams.state = params.state;
        if (params.labels) queryParams.labels = params.labels.join(',');

        const response = await context.http.get(
          `${context.provider.baseUrl}/repos/${params.owner}/${params.repo}/issues`,
          { params: queryParams }
        );

        return response.data;
      },
    },

    // Create issue
    'issues.create': {
      name: 'issues.create',
      displayName: 'Create Issue',
      description: 'Create a new issue in a repository',

      parameters: z.object({
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
        title: z.string().describe('Issue title'),
        body: z.string().optional().describe('Issue body'),
        labels: z.array(z.string()).optional().describe('Issue labels'),
        assignees: z.array(z.string()).optional().describe('Assignees'),
      }),

      returns: z.object({
        id: z.number(),
        number: z.number(),
        title: z.string(),
        body: z.string().nullable(),
        html_url: z.string(),
        state: z.string(),
        created_at: z.string(),
      }),

      execute: async (params: any, context: ActionContext) => {
        const response = await context.http.post(
          `${context.provider.baseUrl}/repos/${params.owner}/${params.repo}/issues`,
          {
            title: params.title,
            body: params.body,
            labels: params.labels,
            assignees: params.assignees,
          }
        );

        return response.data;
      },
    },

    // Create comment
    'issues.createComment': {
      name: 'issues.createComment',
      displayName: 'Create Issue Comment',
      description: 'Create a comment on an issue',

      parameters: z.object({
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
        issueNumber: z.number().describe('Issue number'),
        body: z.string().describe('Comment body'),
      }),

      returns: z.object({
        id: z.number(),
        body: z.string(),
        html_url: z.string(),
        created_at: z.string(),
      }),

      execute: async (params: any, context: ActionContext) => {
        const response = await context.http.post(
          `${context.provider.baseUrl}/repos/${params.owner}/${params.repo}/issues/${params.issueNumber}/comments`,
          { body: params.body }
        );

        return response.data;
      },
    },
  },

  triggers: {
    'issues.opened': {
      name: 'issues.opened',
      displayName: 'Issue Opened',
      description: 'Triggered when an issue is opened',
      type: TriggerType.Webhook,

      webhookConfig: {
        path: '/webhooks/github/issues',
        method: 'POST',
        verifySignature: async (payload, signature, secret) => {
          // GitHub sends X-Hub-Signature-256
          const crypto = require('crypto');
          const hmac = crypto.createHmac('sha256', secret);
          hmac.update(JSON.stringify(payload));
          const expectedSignature = `sha256=${hmac.digest('hex')}`;
          return signature === expectedSignature;
        },
      },

      schema: z.object({
        action: z.literal('opened'),
        issue: z.object({
          id: z.number(),
          number: z.number(),
          title: z.string(),
          body: z.string().nullable(),
          html_url: z.string(),
          user: z.object({
            login: z.string(),
          }),
        }),
        repository: z.object({
          name: z.string(),
          owner: z.object({
            login: z.string(),
          }),
        }),
      }),

      handler: async (payload) => {
        return {
          event: 'issues.opened',
          data: payload,
        };
      },
    },
  },

  rateLimit: {
    requests: 5000,
    window: 3600000, // 1 hour
  },
};

