/**
 * Switchable Client - Multi-tenant context switching
 * 
 * Provides a thin wrapper around createDatafnClient that manages the
 * destroy/create lifecycle behind a stable Proxy reference.
 */

import type { DatafnSchema } from "@datafn/core";
import type { AuthContext } from "@superfunctions/auth";
import type { DatafnClient, DatafnClientConfig } from "./client.js";
import { createDatafnClient } from "./client.js";
import type { DatafnStorageFactory } from "./storage.js";

/**
 * @deprecated Use `createDatafnClient` which includes `switchContext()`, `subscribeClient()`,
 * and lifecycle-aware signals. `createSwitchableClient` will be removed in the next major version.
 */
export interface SwitchableClientConfig<S extends DatafnSchema> {
  /** Schema definition */
  schema: S;
  
  /** Stable client/device identifier (persists across tenant switches) */
  clientId: string;
  
  /** Storage factory that creates tenant-isolated adapters */
  storage: DatafnStorageFactory;
  
  /** Initial auth context */
  initialAuth: AuthContext;
  
  /** Sync configuration (optional) */
  sync?: DatafnClientConfig<S>["sync"];
  
  /** Plugins (optional) */
  plugins?: DatafnClientConfig<S>["plugins"];
  
  /** Custom ID generator (optional) */
  generateId?: DatafnClientConfig<S>["generateId"];
  
  /** Timestamp function for testing (optional) */
  getTimestamp?: () => number;
  
  /** 
   * Called after the new client is created and before sync starts.
   * Useful for showing loading spinners, clearing UI caches, or analytics.
   */
  onSwitch?: (newContext: AuthContext, oldContext: AuthContext) => void | Promise<void>;
}

/**
 * @deprecated Use `createDatafnClient` which includes `switchContext()`, `subscribeClient()`,
 * and lifecycle-aware signals. `createSwitchableClient` will be removed in the next major version.
 */
export interface SwitchableClient<S extends DatafnSchema> {
  /** Proxied client — always delegates to the current underlying client */
  client: DatafnClient<S>;

  /** Switch to a new auth context. Destroys old client, creates new one. */
  switchContext(auth: AuthContext): Promise<void>;

  /** Get the current auth context */
  currentContext(): AuthContext;

  /** Destroy the switchable client and its underlying client */
  destroy(): Promise<void>;

  /**
   * Subscribe to client lifecycle changes. The callback fires immediately with
   * the current underlying client, and again after every `switchContext()`.
   * Returns an unsubscribe function.
   */
  subscribeClient(fn: (client: DatafnClient<S>) => void): () => void;
}

/**
 * Create a switchable datafn client that supports runtime tenant switching.
 *
 * @deprecated `createDatafnClient` now includes built-in `switchContext`, `subscribeClient`,
 * and `currentContext` methods. Use `createDatafnClient` directly for all new code.
 * `createSwitchableClient` will be removed in a future version.
 *
 * The returned client reference is stable across switches - it's a Proxy that
 * always delegates to the current underlying client. This allows you to pass
 * the client through context/stores without worrying about stale references.
 *
 * @example
 * ```typescript
 * const { client, switchContext, currentContext } = createSwitchableClient({
 *   schema,
 *   clientId: "device-123",
 *   storage: (ctx) => IndexedDbStorageAdapter.create({
 *     dbName: `my-app_${ctx.tenantId}_${ctx.userId}`,
 *     schema,
 *   }),
 *   initialAuth: { userId: "user-123", tenantId: "tenant-a" },
 *   sync: {
 *     mode: "sync",
 *     remote: "http://localhost:3000/datafn",
 *     offlinability: true,
 *   },
 * });
 * 
 * // client.todos, client.kv work normally
 * await client.todos.insert({ title: "Task in tenant-a" });
 * 
 * // Switch to a different tenant
 * await switchContext({ userId: "user-123", tenantId: "tenant-b" });
 * 
 * // Same client reference, but now points to tenant-b's data
 * await client.todos.insert({ title: "Task in tenant-b" });
 * ```
 */
export function createSwitchableClient<S extends DatafnSchema>(
  config: SwitchableClientConfig<S>,
): SwitchableClient<S> {
  let currentAuth = config.initialAuth;
  let switchInProgress = false;
  let switchQueue: Array<() => Promise<void>> = [];
  let isDestroyed = false;

  // Lifecycle subscribers — notified whenever realClient is replaced
  const clientSubscribers = new Set<(client: DatafnClient<S>) => void>();

  function notifyClientSubscribers(): void {
    for (const fn of clientSubscribers) {
      fn(realClient);
    }
  }
  
  let realClient = createDatafnClient({
    schema: config.schema,
    clientId: config.clientId,
    authContext: currentAuth,
    storage: config.storage,
    sync: config.sync,
    plugins: config.plugins,
    generateId: config.generateId,
    getTimestamp: config.getTimestamp,
  });

  // Proxy that always delegates to the current realClient
  // We use a function as the proxy target to avoid issues with callable proxies
  const proxy = new Proxy(() => {}, {
    get(_target, prop, receiver) {
      const value = (realClient as any)[prop];
      
      // If it's a function, bind it to realClient so 'this' context is correct
      if (typeof value === "function") {
        return value.bind(realClient);
      }
      
      return value;
    },
    
    has(_target, prop) {
      return prop in realClient;
    },
    
    ownKeys(_target) {
      return Reflect.ownKeys(realClient);
    },
    
    getOwnPropertyDescriptor(_target, prop) {
      const desc = Object.getOwnPropertyDescriptor(realClient, prop);
      if (desc) return desc;
      
      // For properties that exist through the underlying proxy,
      // create a descriptor
      if (prop in realClient) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: (realClient as any)[prop],
        };
      }
      
      return undefined;
    },
  }) as unknown as DatafnClient<S>;

  /**
   * Internal function to perform the actual switch.
   * Assumes switchInProgress flag is already set by caller.
   */
  async function performSwitch(auth: AuthContext): Promise<void> {
    const oldAuth = currentAuth;

    // 1. Destroy old client (flushes, stops sync, closes storage)
    await realClient.destroy();

    // 2. Create new client for the new context
    currentAuth = auth;
    realClient = createDatafnClient({
      schema: config.schema,
      clientId: config.clientId,
      authContext: auth,
      storage: config.storage,
      sync: config.sync,
      plugins: config.plugins,
      generateId: config.generateId,
      getTimestamp: config.getTimestamp,
    });

    // 3. Notify lifecycle subscribers so framework adapters can recreate signals
    notifyClientSubscribers();

    // 4. Notify onSwitch callback
    if (config.onSwitch) {
      await config.onSwitch(auth, oldAuth);
    }

    // 5. Start sync if applicable
    if (config.sync?.mode === "sync") {
      await realClient.sync.start();
    }
  }

  /**
   * Process the switch queue sequentially.
   */
  async function processSwitchQueue(): Promise<void> {
    while (switchQueue.length > 0) {
      const nextSwitch = switchQueue.shift();
      if (nextSwitch) {
        await nextSwitch();
      }
    }
    switchInProgress = false;
  }

  return {
    client: proxy,

    async switchContext(auth: AuthContext) {
      // Prevent switching after destroy
      if (isDestroyed) {
        throw new Error("Cannot switch context on a destroyed switchable client");
      }
      
      // If a switch is already in progress, queue this one
      if (switchInProgress) {
        return new Promise<void>((resolve, reject) => {
          switchQueue.push(async () => {
            try {
              await performSwitch(auth);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        });
      }

      // Start the switch
      switchInProgress = true;
      try {
        await performSwitch(auth);
        
        // Process any queued switches
        await processSwitchQueue();
      } catch (err) {
        switchInProgress = false;
        throw err;
      }
    },

    currentContext() {
      return currentAuth;
    },

    async destroy() {
      // Wait for any in-progress switch to complete
      while (switchInProgress) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Clear the queue
      switchQueue = [];

      // Mark as destroyed
      isDestroyed = true;

      // Clear all lifecycle subscribers
      clientSubscribers.clear();

      // Destroy the current client
      await realClient.destroy();
    },

    subscribeClient(fn: (client: DatafnClient<S>) => void): () => void {
      clientSubscribers.add(fn);
      // Emit current client immediately so callers can initialise on subscription
      fn(realClient);
      return () => clientSubscribers.delete(fn);
    },
  };
}
