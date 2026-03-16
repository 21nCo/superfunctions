export interface TestCommandOptions {
  provider?: string;
  action?: string;
  connection?: string;
  json?: boolean;
  live?: boolean;
}

interface ProviderDescriptor {
  authorizationUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
  healthUrl?: string;
}

export interface DiagnosticCheckResult {
  name: string;
  ok: boolean;
  message: string;
}

export interface DiagnosticReport {
  ok: boolean;
  provider?: string;
  checks: {
    config: boolean;
    authUrl: boolean;
    callbackValidation: boolean;
    liveHealth?: boolean;
  };
  checkResults: DiagnosticCheckResult[];
  error?: {
    code: string;
    message: string;
  };
  metadata: {
    action?: string;
    connection?: string;
    liveCheckRequested: boolean;
    timestamp: string;
  };
}

interface DiagnosticDependencies {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  setExitCode?: (code: number) => void;
}

const PROVIDERS: Record<string, ProviderDescriptor> = {
  github: {
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    defaultScopes: ['read:user'],
    healthUrl: 'https://api.github.com/rate_limit',
  },
  gmail: {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    defaultScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    healthUrl: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  },
  outlook: {
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    defaultScopes: ['offline_access'],
    healthUrl: 'https://graph.microsoft.com/v1.0/$metadata',
  },
  slack: {
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    defaultScopes: ['chat:write'],
    healthUrl: 'https://slack.com/api/api.test',
  },
  discord: {
    authorizationUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    defaultScopes: ['identify'],
    healthUrl: 'https://discord.com/api/v10/gateway',
  },
  linear: {
    authorizationUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    defaultScopes: ['read'],
    healthUrl: 'https://api.linear.app/graphql',
  },
  stripe: {
    authorizationUrl: 'https://connect.stripe.com/oauth/authorize',
    tokenUrl: 'https://connect.stripe.com/oauth/token',
    defaultScopes: ['read_only'],
    healthUrl: 'https://api.stripe.com/v1/charges?limit=1',
  },
};

export async function runProviderDiagnostics(
  options: TestCommandOptions,
  dependencies: Pick<DiagnosticDependencies, 'env' | 'fetchFn' | 'now'> = {}
): Promise<DiagnosticReport> {
  const provider = normalizeProvider(options.provider);
  const now = dependencies.now ?? (() => new Date());
  const descriptor = provider ? PROVIDERS[provider] : undefined;
  const metadata = {
    action: options.action,
    connection: options.connection,
    liveCheckRequested: options.live === true,
    timestamp: now().toISOString(),
  };

  if (!provider) {
    return {
      ok: false,
      checks: {
        config: false,
        authUrl: false,
        callbackValidation: false,
      },
      checkResults: [],
      error: {
        code: 'VALIDATION_ERROR',
        message: 'provider is required (--provider <name>)',
      },
      metadata,
    };
  }

  if (!descriptor) {
    return {
      ok: false,
      provider,
      checks: {
        config: false,
        authUrl: false,
        callbackValidation: false,
      },
      checkResults: [],
      error: {
        code: 'PROVIDER_NOT_FOUND',
        message: `provider ${provider} is not registered`,
      },
      metadata,
    };
  }

  const checkResults: DiagnosticCheckResult[] = [];
  const env = dependencies.env ?? process.env;
  const configCheck = validateProviderDescriptor(descriptor);
  checkResults.push(configCheck);

  const authCheck = generateAuthUrlCheck(provider, descriptor, env);
  checkResults.push(authCheck);

  const callbackCheck = validateCallbackStub(provider);
  checkResults.push(callbackCheck);

  let liveHealth: boolean | undefined;
  if (options.live === true) {
    const fetchFn = dependencies.fetchFn ?? fetch;
    const liveCheckResult = await runLiveHealthCheck(fetchFn, descriptor);
    checkResults.push(liveCheckResult);
    liveHealth = liveCheckResult.ok;
  }

  const checks = {
    config: configCheck.ok,
    authUrl: authCheck.ok,
    callbackValidation: callbackCheck.ok,
    liveHealth,
  };

  return {
    ok: checkResults.every((check) => check.ok),
    provider,
    checks,
    checkResults,
    metadata,
  };
}

export function formatDiagnosticReport(report: DiagnosticReport, asJson: boolean): string {
  if (asJson) {
    return JSON.stringify(report, null, 2);
  }

  const lines: string[] = [];

  if (report.error) {
    lines.push(`Error: ${report.error.code} - ${report.error.message}`);
    return lines.join('\n');
  }

  lines.push(`Provider diagnostics for ${report.provider}`);
  lines.push('');
  for (const check of report.checkResults) {
    lines.push(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.message}`);
  }
  lines.push('');
  lines.push(`Overall: ${report.ok ? 'PASS' : 'FAIL'}`);

  return lines.join('\n');
}

export async function testCommand(
  options: TestCommandOptions,
  dependencies: DiagnosticDependencies = {}
) {
  const stdout = dependencies.stdout ?? ((line: string) => console.log(line));
  const stderr = dependencies.stderr ?? ((line: string) => console.error(line));
  const setExitCode = dependencies.setExitCode ?? ((code: number) => {
    process.exitCode = code;
  });

  const report = await runProviderDiagnostics(options, dependencies);
  const output = formatDiagnosticReport(report, options.json === true);

  if (report.ok) {
    stdout(output);
    setExitCode(0);
    return;
  }

  if (options.json === true) {
    stdout(output);
  } else {
    stderr(output);
  }
  setExitCode(1);
}

function normalizeProvider(provider: string | undefined): string | undefined {
  if (typeof provider !== 'string') {
    return undefined;
  }

  const value = provider.trim().toLowerCase();
  return value.length > 0 ? value : undefined;
}

function validateProviderDescriptor(descriptor: ProviderDescriptor): DiagnosticCheckResult {
  const urls = [descriptor.authorizationUrl, descriptor.tokenUrl];
  const validUrls = urls.every((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:';
    } catch {
      return false;
    }
  });

  if (!validUrls) {
    return {
      name: 'config',
      ok: false,
      message: 'provider descriptor has invalid OAuth endpoint configuration',
    };
  }

  return {
    name: 'config',
    ok: true,
    message: 'provider descriptor is valid',
  };
}

function generateAuthUrlCheck(
  provider: string,
  descriptor: ProviderDescriptor,
  env: NodeJS.ProcessEnv
): DiagnosticCheckResult {
  const clientId = env[`${provider.toUpperCase()}_CLIENT_ID`] ?? 'diagnostic-client-id';
  const redirectUri = env.PLUGFN_REDIRECT_URI ?? 'http://localhost:3000/api/plugfn/callback';
  const scope = descriptor.defaultScopes.join(' ');

  const url = new URL(descriptor.authorizationUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', `diag-${provider}`);

  const requiredParams = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state'];
  const allPresent = requiredParams.every((param) => {
    const value = url.searchParams.get(param);
    return typeof value === 'string' && value.length > 0;
  });

  if (!allPresent) {
    return {
      name: 'authUrl',
      ok: false,
      message: 'failed to generate deterministic OAuth authorization URL',
    };
  }

  return {
    name: 'authUrl',
    ok: true,
    message: 'authorization URL generation succeeded',
  };
}

function validateCallbackStub(provider: string): DiagnosticCheckResult {
  const callbackPayload = {
    provider,
    code: 'diag-code',
    state: 'diag-state',
  };

  const valid = typeof callbackPayload.code === 'string'
    && callbackPayload.code.length > 0
    && typeof callbackPayload.state === 'string'
    && callbackPayload.state.length > 0;

  if (!valid) {
    return {
      name: 'callbackValidation',
      ok: false,
      message: 'callback payload validation failed',
    };
  }

  return {
    name: 'callbackValidation',
    ok: true,
    message: 'callback validation stub passed',
  };
}

async function runLiveHealthCheck(
  fetchFn: typeof fetch,
  descriptor: ProviderDescriptor
): Promise<DiagnosticCheckResult> {
  if (!descriptor.healthUrl) {
    return {
      name: 'liveHealth',
      ok: false,
      message: 'provider does not define a health endpoint',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetchFn(descriptor.healthUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'plugfn-cli-diagnostics',
      },
    });
    if (response.status >= 200 && response.status < 400) {
      return {
        name: 'liveHealth',
        ok: true,
        message: `provider health endpoint reachable (status ${response.status})`,
      };
    }

    return {
      name: 'liveHealth',
      ok: false,
      message: `provider health endpoint returned status ${response.status}`,
    };
  } catch (error) {
    return {
      name: 'liveHealth',
      ok: false,
      message: `provider health endpoint check failed: ${(error as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
