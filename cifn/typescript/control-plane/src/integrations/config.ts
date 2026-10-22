import type { AdapterType } from './types.js';

export interface AdapterConfig {
  queue: {
    type: AdapterType;
    flowfnBaseUrl?: string;
    flowfnApiKey?: string;
  };
  artifacts: {
    type: AdapterType;
    filefnBaseUrl?: string;
    filefnApiKey?: string;
  };
  secrets: {
    type: AdapterType;
    secfnBaseUrl?: string;
    secfnApiKey?: string;
    secfnVaultPath?: string;
  };
  logs: {
    type: AdapterType;
    logfnBaseUrl?: string;
    logfnApiKey?: string;
    logfnSink?: string;
  };
}

export interface AdapterConfigValidationResult {
  ok: boolean;
  errors: string[];
}

export function parseAdapterConfig(env: Record<string, string | undefined> = process.env): AdapterConfig {
  return {
    queue: {
      type: (env.CIFN_QUEUE_ADAPTER as AdapterType) ?? 'memory',
      flowfnBaseUrl: env.FLOWFN_BASE_URL,
      flowfnApiKey: env.FLOWFN_API_KEY,
    },
    artifacts: {
      type: (env.CIFN_ARTIFACTS_ADAPTER as AdapterType) ?? 'memory',
      filefnBaseUrl: env.FILEFN_BASE_URL,
      filefnApiKey: env.FILEFN_API_KEY,
    },
    secrets: {
      type: (env.CIFN_SECRETS_ADAPTER as AdapterType) ?? 'memory',
      secfnBaseUrl: env.SECFN_BASE_URL,
      secfnApiKey: env.SECFN_API_KEY,
      secfnVaultPath: env.SECFN_VAULT_PATH,
    },
    logs: {
      type: (env.CIFN_LOGS_ADAPTER as AdapterType) ?? 'memory',
      logfnBaseUrl: env.LOGFN_BASE_URL,
      logfnApiKey: env.LOGFN_API_KEY,
      logfnSink: env.LOGFN_SINK,
    },
  };
}

export function validateAdapterConfig(config: AdapterConfig): AdapterConfigValidationResult {
  const errors: string[] = [];

  if (config.queue.type === 'real') {
    if (!config.queue.flowfnBaseUrl) {
      errors.push('FLOWFN_BASE_URL is required when CIFN_QUEUE_ADAPTER=real');
    }
    if (!config.queue.flowfnApiKey) {
      errors.push('FLOWFN_API_KEY is required when CIFN_QUEUE_ADAPTER=real');
    }
  }

  if (config.artifacts.type === 'real') {
    if (!config.artifacts.filefnBaseUrl) {
      errors.push('FILEFN_BASE_URL is required when CIFN_ARTIFACTS_ADAPTER=real');
    }
  }

  if (config.secrets.type === 'real') {
    if (!config.secrets.secfnBaseUrl) {
      errors.push('SECFN_BASE_URL is required when CIFN_SECRETS_ADAPTER=real');
    }
  }

  if (config.logs.type === 'real') {
    errors.push('CIFN_LOGS_ADAPTER=real standalone HTTP mode is unsupported; use SQLite durable remote log delivery and CIFN_LOGS_ADAPTER=memory for lifecycle events');
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
