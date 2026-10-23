import type { Adapter } from '@superfunctions/db';
import { CatchFnService, type CatchFnServiceConfig } from './service';
import { createCatchFnRouter } from './router';

export * from './service';
export * from './router';

export interface CatchFnServerConfig extends CatchFnServiceConfig {
  // Add any server-specific config here
}

export function createCatchFnServer(config: CatchFnServerConfig) {
  const service = new CatchFnService(config);
  const router = createCatchFnRouter(service);

  return {
    service,
    router,
  };
}
