/** Manual publication shares the same durable claim and per-document journal as due execution. */
import type { IncomingMessage } from 'node:http';
import { authorize, type AuthorizeConfig } from '../auth/authorize.js';
import type { ReleasesStorageConfig } from '../storage/releases.js';
import { executeRelease, type ReleaseExecutorConfig } from './executor.js';
export interface PublishReleaseConfig extends AuthorizeConfig {
  contentfnBaseUrl: string;
  releasesStorage: ReleasesStorageConfig;
  allowedDatasets?: readonly string[];
  resolveExecutionIdentity?: ReleaseExecutorConfig['resolveIdentity'];
}
export async function publishRelease(config: PublishReleaseConfig, req: IncomingMessage, input: { dataset: string; releaseId: string }) {
  return executeRelease({ db: config.releasesStorage.db, contentfnBaseUrl: config.contentfnBaseUrl,
    allowedDatasets: config.allowedDatasets ?? [input.dataset], resolveIdentity: config.resolveExecutionIdentity },
  { ...input, origin: 'manual' }, (type, action) => authorize(config, req, { dataset: input.dataset, type, action }));
}
