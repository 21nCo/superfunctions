import {
  FlowFnQueueAdapter as SharedFlowFnQueueAdapter,
  MemoryQueueAdapter as SharedMemoryQueueAdapter,
} from '@superfunctions/queue';
import type { QueueAdapter } from './types.js';
import type { AdapterConfig } from './config.js';

export const MemoryQueueAdapter = SharedMemoryQueueAdapter as unknown as new () => QueueAdapter;
export const FlowFnQueueAdapter = SharedFlowFnQueueAdapter as unknown as new (config: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}) => QueueAdapter;

export function createQueueAdapter(config: AdapterConfig['queue']): QueueAdapter {
  if (config.type === 'memory') {
    return new MemoryQueueAdapter();
  }

  if (!config.flowfnBaseUrl || !config.flowfnApiKey) {
    throw new Error('FlowFn adapter requires baseUrl and apiKey');
  }

  return new FlowFnQueueAdapter({
    baseUrl: config.flowfnBaseUrl,
    apiKey: config.flowfnApiKey,
  });
}
