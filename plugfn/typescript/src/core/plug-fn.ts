import type { PlugFnConfig, MetricsOptions, PlugFnPrincipal } from '../types/config.js';
import type {
  ActionOptions,

  BatchAction,
  BatchResult,
  Logger,
} from '../types/action.js';
import type {
  GetAuthUrlOptions,
  HandleCallbackOptions,
  ListConnectionsOptions,
  DisconnectOptions,
  Connection,
} from '../types/connection.js';
import type { Provider } from '../types/provider.js';
import type { TriggerHandler } from '../types/trigger.js';
import type { Workflow, WorkflowStats, ListWorkflowsOptions } from '../types/workflow.js';

import { ProviderRegistry } from './provider-registry.js';
import {
  ConnectionManager,
  createConnectionManagerOAuthDependencies,
} from './connection-manager.js';
import { ActionExecutor } from './action-executor.js';
import { WorkflowEngine } from './workflow-engine.js';
import { WebhookHandler } from '../webhooks/webhook-handler.js';
import { AdapterConnectionStorage } from '../storage/connection-storage.js';
import { AdapterWorkflowStorage } from '../storage/workflow-storage.js';
import { ConsoleLogger } from '../utils/logger.js';

/**
 * Main PlugFn SDK interface
 */
export interface PlugFn {
  config: {
    auth: {
      authenticate(request: Request): Promise<PlugFnPrincipal | null>;
    };
    baseUrl: string;
    integrations: Record<string, PlugFnConfig['integrations'][string]>;
  };

  // Connection management
  connections: {
    getAuthUrl(options: GetAuthUrlOptions): Promise<string>;
    handleCallback(options: HandleCallbackOptions): Promise<Connection>;
    list(options: ListConnectionsOptions): Promise<Connection[]>;
    get(id: string): Promise<Connection>;
    disconnect(options: DisconnectOptions): Promise<void>;
    refresh(id: string): Promise<Connection>;
  };

  // Workflow management
  workflows: {
    list(options?: ListWorkflowsOptions): Promise<Workflow[]>;
    get(id: string): Promise<Workflow | null>;
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    delete(id: string): Promise<void>;
    getStats(id: string): Promise<WorkflowStats>;
  };

  // Webhook management
  webhooks: {
    on(provider: string, event: string, handler: TriggerHandler): void;
    off(provider: string, event: string, handler: TriggerHandler): void;
    handle(
      provider: string,
      event: string,
      payload: any,
      headers: Record<string, string>,
      secret?: string,
      options?: {
        rawBody?: Uint8Array;
      }
    ): Promise<any>;
  };

  // Provider management
  providers: {
    list(): Provider[];
    get(name: string): Provider | undefined;
    register(provider: Provider): void;
  };

  // Action execution
  batch(actions: BatchAction[]): Promise<BatchResult[]>;
  getMetrics(options: MetricsOptions): Promise<any>;
  on(event: string, handler: (event: any) => void): void;
  off(event: string, handler: (event: any) => void): void;

  // Dynamic provider access
  [provider: string]: any;
}

/**
 * Create PlugFn instance
 */
export function plugFn(config: PlugFnConfig): PlugFn {
  // Initialize logger
  const logger: Logger = config.logger || new ConsoleLogger('[PlugFn]');
  const normalizedAuthProvider = normalizeAuthProvider(config.auth);

  // Initialize storage
  const connectionStorage = new AdapterConnectionStorage(config.database);
  // const _webhookStorage = new AdapterWebhookStorage(config.database);
  const workflowStorage = new AdapterWorkflowStorage(config.database);

  // Initialize provider registry
  const providerRegistry = new ProviderRegistry(logger);

  // Convert integration configs to Map
  const integrationConfigs = new Map(Object.entries(config.integrations));

  // Mark configured providers
  for (const providerName of integrationConfigs.keys()) {
    providerRegistry.markConfigured(providerName);
  }

  const providerMap = providerRegistry['providers'] as Map<string, Provider>;
  const oauthFlowDependencies = createConnectionManagerOAuthDependencies({
    database: config.database,
    providers: providerMap,
    integrationConfigs,
    baseUrl: config.baseUrl,
    encryptionKey: config.encryptionKey,
  });

  // Initialize managers
  const connectionManager = new ConnectionManager(
    connectionStorage,
    providerMap,
    integrationConfigs,
    config.baseUrl,
    config.encryptionKey,
    logger,
    oauthFlowDependencies
  );

  const actionExecutor = new ActionExecutor(
    connectionManager,
    providerRegistry,
    logger,
    {
      enableRetry: config.retry?.enabled !== false,
      enableRateLimit: config.rateLimit?.enabled !== false,
      enableCache: config.cache?.enabled !== false,
      enableLogging: true,
      enableMetrics: true,
    }
  );

  const webhookHandler = new WebhookHandler(providerRegistry, logger);

  const workflowEngine = new WorkflowEngine(workflowStorage, webhookHandler, logger);

  // Event handlers
  const eventHandlers = new Map<string, Set<(event: any) => void>>();

  // Create the main API
  const api: PlugFn = {
    config: {
      auth: normalizedAuthProvider,
      baseUrl: config.baseUrl,
      integrations: config.integrations,
    },

    // Connection management
    connections: {
      getAuthUrl: (options) => connectionManager.getAuthUrl(options),
      handleCallback: (options) => connectionManager.handleCallback(options),
      list: (options) => connectionManager.list(options),
      get: (id) => connectionManager.get(id),
      disconnect: (options) => connectionManager.disconnect(options),
      refresh: (id) => connectionManager.refresh(id),
    },

    // Workflow management
    workflows: {
      list: (options) => workflowEngine.list(options),
      get: (id) => workflowEngine.get(id),
      enable: (id) => workflowEngine.enable(id),
      disable: (id) => workflowEngine.disable(id),
      delete: (id) => workflowEngine.delete(id),
      getStats: (id) => workflowEngine.getStats(id),
    },

    // Webhook management
    webhooks: {
      on: (provider, event, handler) => webhookHandler.on(provider, event, handler),
      off: (provider, event, handler) => webhookHandler.off(provider, event, handler),
      handle: (provider, event, payload, headers, secret, options) =>
        webhookHandler.handleWebhook(provider, event, payload, headers, secret, options),
    },

    // Provider management
    providers: {
      list: () => providerRegistry.list(),
      get: (name) => providerRegistry.get(name),
      register: (provider) => {
        providerRegistry.register(provider);
      },
    },

    // Batch execution
    batch: (actions) => actionExecutor.batch(actions),

    // Metrics
    getMetrics: async (options) => actionExecutor.getMetrics(options),

    // Event handling
    on: (event: string, handler: (event: any) => void) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set());
      }
      eventHandlers.get(event)!.add(handler);
    },

    off: (event: string, handler: (event: any) => void) => {
      const handlers = eventHandlers.get(event);
      if (handlers) {
        handlers.delete(handler);
      }
    },
  };

  // Create dynamic provider proxies
  return new Proxy(api, {
    get(target, prop: string) {
      // If property exists on target, return it
      if (prop in target) {
        return target[prop as keyof typeof target];
      }

      // Check if it's a provider
      const provider = providerRegistry.get(prop);
      if (!provider) {
        return undefined;
      }

      // Create provider action proxy
      const providerProxy: any = {
        on: (event: string, handler: TriggerHandler) => {
          webhookHandler.on(prop, event, handler);
        },
      };

      // Add all actions
      for (const [actionName, _action] of Object.entries(provider.actions)) {
        providerProxy[actionName] = async (options: ActionOptions) => {
          const result = await actionExecutor.execute(prop, actionName, options);
          if (!result.success) {
            throw result.error;
          }
          return result.data;
        };
      }

      return providerProxy;
    },
  }) as PlugFn;
}

function normalizeAuthProvider(configuredAuth: PlugFnConfig['auth']): {
  authenticate(request: Request): Promise<PlugFnPrincipal | null>;
} {
  if (typeof configuredAuth.authenticate === 'function') {
    return {
      authenticate: async (request: Request) => {
        const principal = await configuredAuth.authenticate!(request);
        return normalizePrincipal(principal);
      },
    };
  }

  return {
    authenticate: async (request: Request) => {
      if (typeof configuredAuth.getUserId === 'function') {
        const userId = await configuredAuth.getUserId(request);
        return normalizePrincipal(userId);
      }

      if (typeof configuredAuth.requireAuth === 'function') {
        try {
          const userId = await configuredAuth.requireAuth(request);
          return normalizePrincipal(userId);
        } catch {
          return null;
        }
      }

      return null;
    },
  };
}

function normalizePrincipal(value: PlugFnPrincipal | string | null | undefined): PlugFnPrincipal | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value.length > 0 ? { userId: value } : null;
  }

  if (typeof value === 'object' && typeof value.userId === 'string' && value.userId.length > 0) {
    return value;
  }

  return null;
}
