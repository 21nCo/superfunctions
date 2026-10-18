import { CatchFnService, type CatchFnServiceConfig } from './service.js';
import { createCatchFnRouter, type CatchFnRouterConfig } from './router.js';

export * from './service.js';
export * from './router.js';

export interface CatchFnServerConfig extends CatchFnServiceConfig {
  http?: CatchFnRouterConfig;
}

export function createCatchFnServer(config: CatchFnServerConfig) {
  const service = new CatchFnService(config);
  const router = createCatchFnRouter(service, config.http);

  return {
    service,
    router,
  };
}

export * from "./schema.js";
