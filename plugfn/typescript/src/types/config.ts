import type { Logger } from './action.js';
import type { RetryOptions } from './action.js';
import type { RateLimitConfig } from './provider.js';
import type { Adapter as DbAdapter } from '@superfunctions/db';

/**
 * Subset of @superfunctions/db Adapter methods used by PlugFn persistence.
 * This keeps PlugFn contracts anchored to the shared DB abstraction.
 */
export type PlugFnDbAdapterContract = Partial<DbAdapter>;

export interface PlugFnDatabaseAdapter extends PlugFnDbAdapterContract {
  // Connections
  createConnection(connection: any): Promise<void>;
  getConnection(id: string): Promise<any>;
  listConnections(userId: string, provider?: string): Promise<any[]>;
  updateConnection(id: string, updates: any): Promise<void>;
  deleteConnection(id: string): Promise<void>;

  // Webhooks
  createWebhook(webhook: any): Promise<void>;
  getWebhook(id: string): Promise<any>;
  listWebhooks(provider?: string): Promise<any[]>;
  updateWebhook(id: string, updates: any): Promise<void>;
  deleteWebhook(id: string): Promise<void>;

  // Workflows
  createWorkflow(workflow: any): Promise<void>;
  getWorkflow(id: string): Promise<any>;
  listWorkflows(userId?: string, status?: string): Promise<any[]>;
  updateWorkflow(id: string, updates: any): Promise<void>;
  deleteWorkflow(id: string): Promise<void>;

  // Workflow executions
  createWorkflowExecution(execution: any): Promise<void>;
  updateWorkflowExecution(id: string, updates: any): Promise<void>;
  listWorkflowExecutions(workflowId: string, limit?: number): Promise<any[]>;

  // Action logs
  createActionLog(log: any): Promise<void>;
  listActionLogs(filters: any, limit?: number): Promise<any[]>;
}

/**
 * Backward-compatible alias retained for one minor release.
 */
export type Adapter = PlugFnDatabaseAdapter;

/**
 * Auth provider interface
 */
export interface AuthProvider {
  getUserId(request: any): Promise<string | null>;
  requireAuth(request: any): Promise<string>;
}

/**
 * Integration configuration per provider
 */
export type IntegrationConfig =
  | OAuth2IntegrationConfig
  | ApiKeyIntegrationConfig
  | JWTIntegrationConfig
  | BasicAuthIntegrationConfig;

export interface OAuth2IntegrationConfig {
  type?: 'oauth2';
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  redirectUris?: string[];
}

export interface ApiKeyIntegrationConfig {
  type: 'api-key';
  apiKey: string;
}

export interface JWTIntegrationConfig {
  type: 'jwt';
  privateKey: string;
  publicKey?: string;
}

export interface BasicAuthIntegrationConfig {
  type: 'basic';
  username: string;
  password: string;
}

/**
 * Webhook configuration
 */
export interface WebhookOptions {
  verifySignatures?: boolean;
  allowedIPs?: string[];
  maxPayloadSize?: number;
}

/**
 * Global cache configuration
 */
export interface GlobalCacheConfig {
  enabled: boolean;
  ttl?: number;
  instance?: any;
  defaultTTL?: number;
}

/**
 * Global rate limit configuration
 */
export interface GlobalRateLimitConfig {
  enabled: boolean;
  respectProviderLimits?: boolean;
  global?: RateLimitConfig;
}

/**
 * Global retry configuration
 */
export interface GlobalRetryConfig extends RetryOptions {
  enabled?: boolean;
}

/**
 * Main PlugFn configuration
 */
export interface PlugFnConfig {
  database: Adapter;
  auth: AuthProvider;
  baseUrl: string;
  encryptionKey: string;
  integrations: Record<string, IntegrationConfig>;
  cache?: GlobalCacheConfig;
  rateLimit?: GlobalRateLimitConfig;
  retry?: GlobalRetryConfig;
  logger?: Logger;
  webhooks?: WebhookOptions;
}

/**
 * Metrics configuration
 */
export interface MetricsOptions {
  timeRange?: 'last-hour' | 'last-24h' | 'last-7d' | 'last-30d';
  groupBy?: 'provider' | 'action' | 'user';
  provider?: string;
  userId?: string;
}

/**
 * Metrics data
 */
export interface Metrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  avgResponseTime: number;
  byProvider?: ProviderMetrics[];
  byAction?: ActionMetrics[];
}

export interface ProviderMetrics {
  name: string;
  requests: number;
  successRate: number;
  avgResponseTime: number;
  rateLimitHits: number;
}

export interface ActionMetrics {
  provider: string;
  action: string;
  requests: number;
  successRate: number;
  avgResponseTime: number;
}
