import { rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  createSuccessEnvelope,
  createProbefnError,
  toErrorEnvelope,
  type JsonObject,
} from '../packages/contracts/src/index.js';

type VectorId =
  | 'TV-CONFIG-001'
  | 'TV-SESSION-001'
  | 'TV-SESSION-002'
  | 'TV-BROWSER-001'
  | 'TV-ACTION-001'
  | 'TV-ACTION-002'
  | 'TV-ACTION-003'
  | 'TV-ACTION-004'
  | 'TV-CHECKPOINT-001'
  | 'TV-EVENT-001'
  | 'TV-DELTA-001'
  | 'TV-STORAGE-001'
  | 'TV-LIMITS-001'
  | 'TV-DESIGN-001'
  | 'TV-DESIGN-002'
  | 'TV-BASELINE-001'
  | 'TV-BASELINE-002'
  | 'TV-BASELINE-003'
  | 'TV-DEBUG-001'
  | 'TV-REPORT-001'
  | 'TV-AUTH-001'
  | 'TV-SECURITY-001'
  | 'TV-DETERMINISM-001'
  | 'TV-DETERMINISM-002'
  | 'TV-MCP-001'
  | 'TV-CLI-001'
  | 'TV-OBS-001'
  | 'TV-FIXTURE-001';

type FixtureName =
  | 'vite-healthy'
  | 'vite-hangs'
  | 'vite-ambiguous'
  | 'vite-overlay'
  | 'vite-auth'
  | 'vite-secret-leak'
  | 'vite-overflow'
  | 'vite-token-drift'
  | 'vite-regression'
  | 'vite-console-error';

interface VectorGroup {
  name: string;
  vectorIds: VectorId[];
  fixtures: FixtureName[];
  run: () => Promise<void>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fixtureFilter = getFixtureFilter(process.argv.slice(2));
const knownFixtures = new Set<FixtureName>([
  'vite-healthy',
  'vite-hangs',
  'vite-ambiguous',
  'vite-overlay',
  'vite-auth',
  'vite-secret-leak',
  'vite-overflow',
  'vite-token-drift',
  'vite-regression',
  'vite-console-error',
]);

async function main(): Promise<void> {
  try {
    if (fixtureFilter && !knownFixtures.has(fixtureFilter)) {
      throw createProbefnError({
        code: 'E_CONFIG_INVALID',
        message: `Unknown fixture ${fixtureFilter}.`,
        retryable: false,
      });
    }

    const groups = buildGroups();
    const selectedGroups =
      fixtureFilter
        ? groups.filter((group) => group.fixtures.includes(fixtureFilter))
        : groups;

    const passedVectors = new Set<VectorId>();
    const failures: Array<{ group: string; vectorIds: VectorId[]; detail: string }> = [];

    for (const group of selectedGroups) {
      try {
        await group.run();
        group.vectorIds.forEach((vectorId) => {
          passedVectors.add(vectorId);
        });
      } catch (error) {
        failures.push({
          group: group.name,
          vectorIds: group.vectorIds,
          detail: formatError(error),
        });
      }
    }

    const payload = createSuccessEnvelope({
      vectorsPassed: passedVectors.size,
      vectorsFailed: failures.reduce((count, failure) => count + failure.vectorIds.length, 0),
      vectors: Array.from(passedVectors).sort(),
      ...(fixtureFilter ? { fixture: fixtureFilter } : {}),
      ...(failures.length > 0
        ? {
            failures: failures.map((failure) => ({
              group: failure.group,
              vectorIds: failure.vectorIds,
              detail: failure.detail,
            })) as JsonObject[],
          }
        : {}),
    });

    const stream = failures.length > 0 ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(failures.length > 0 ? 1 : 0);
  } catch (error) {
    const envelope = toErrorEnvelope(error);
    process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
    process.exit(envelope.ok ? 0 : 2);
  }
}

function buildGroups(): VectorGroup[] {
  return [
    {
      name: 'contracts',
      vectorIds: ['TV-CONFIG-001'],
      fixtures: [],
      run: () => runPnpm(['--filter', '@probefn/contracts', 'test']),
    },
    {
      name: 'dev-server',
      vectorIds: ['TV-SESSION-001', 'TV-SESSION-002'],
      fixtures: ['vite-healthy', 'vite-hangs'],
      run: () => runPnpm(['--filter', '@probefn/dev-server', 'test']),
    },
    {
      name: 'browser-runner',
      vectorIds: [
        'TV-BROWSER-001',
        'TV-ACTION-001',
        'TV-ACTION-002',
        'TV-ACTION-003',
        'TV-ACTION-004',
      ],
      fixtures: ['vite-healthy', 'vite-ambiguous', 'vite-overlay'],
      run: () => runPnpm(['--filter', '@probefn/browser-runner', 'test']),
    },
    {
      name: 'core',
      vectorIds: [
        'TV-CHECKPOINT-001',
        'TV-AUTH-001',
        'TV-DETERMINISM-002',
      ],
      fixtures: ['vite-healthy', 'vite-auth'],
      run: () => runPnpm(['--filter', '@probefn/core', 'test']),
    },
    {
      name: 'storage',
      vectorIds: ['TV-STORAGE-001', 'TV-LIMITS-001'],
      fixtures: [],
      run: () => runPnpm(['--filter', '@probefn/storage', 'test']),
    },
    {
      name: 'design-analyzers',
      vectorIds: ['TV-DESIGN-001', 'TV-DESIGN-002'],
      fixtures: ['vite-overflow', 'vite-token-drift'],
      run: () => runPnpm(['--filter', '@probefn/analyzers', 'test']),
    },
    {
      name: 'visual-baselines',
      vectorIds: ['TV-BASELINE-001', 'TV-BASELINE-002', 'TV-BASELINE-003'],
      fixtures: ['vite-regression', 'vite-healthy'],
      run: () => runPnpm(['--filter', '@probefn/visual-baselines', 'test']),
    },
    {
      name: 'session-reporter',
      vectorIds: ['TV-DEBUG-001', 'TV-REPORT-001', 'TV-OBS-001'],
      fixtures: ['vite-console-error', 'vite-healthy'],
      run: () => runPnpm(['--filter', '@probefn/session-reporter', 'test']),
    },
    {
      name: 'mcp-server',
      vectorIds: ['TV-MCP-001'],
      fixtures: ['vite-console-error'],
      run: () => runPnpm(['--filter', '@probefn/mcp-server', 'test']),
    },
    {
      name: 'cli',
      vectorIds: ['TV-CLI-001'],
      fixtures: ['vite-healthy'],
      run: () => runPnpm(['--filter', '@probefn/cli', 'test']),
    },
    {
      name: 'cli-runtime-flows',
      vectorIds: ['TV-EVENT-001', 'TV-DELTA-001', 'TV-SECURITY-001'],
      fixtures: ['vite-console-error', 'vite-secret-leak'],
      run: runCliRuntimeFlows,
    },
    {
      name: 'deterministic-session-smoke',
      vectorIds: ['TV-DETERMINISM-001'],
      fixtures: ['vite-healthy'],
      run: runDeterministicSmoke,
    },
    {
      name: 'fixture-suite-summary',
      vectorIds: ['TV-FIXTURE-001'],
      fixtures: [],
      run: async () => undefined,
    },
  ];
}

async function runDeterministicSmoke(): Promise<void> {
  await Promise.all([
    rm(path.resolve(repoRoot, '.artifacts', 'runs', 'run_healthy'), {
      recursive: true,
      force: true,
    }),
    rm(path.resolve(repoRoot, '.artifacts', 'session-state', 'sess_healthy.json'), {
      force: true,
    }),
  ]);

  const started = await runPnpm([
    'probefn',
    'session',
    'start',
    '--config',
    'test/fixtures/vite-healthy/probefn.config.ts',
    '--mode',
    'visual-regression',
    '--browser',
    'chromium',
    '--json',
  ]);
  const payload = parseJsonDocument(started.stdout, started.stderr) as {
    ok: boolean;
    data?: {
      sessionId?: string;
      runId?: string;
      deterministic?: {
        enabled?: boolean;
        viewport?: { width?: number; height?: number };
      };
    };
  };

  if (!payload.ok) {
    throw new Error(`Expected deterministic session start to succeed: ${started.stdout || started.stderr}`);
  }

  if (payload.data?.sessionId !== 'sess_healthy' || payload.data?.runId !== 'run_healthy') {
    throw new Error(`Expected deterministic fixture session ids, received ${JSON.stringify(payload.data)}`);
  }

  if (
    payload.data?.deterministic?.enabled !== true ||
    payload.data?.deterministic?.viewport?.width !== 1440 ||
    payload.data?.deterministic?.viewport?.height !== 900
  ) {
    throw new Error(`Expected deterministic settings in session start output, received ${JSON.stringify(payload.data)}`);
  }

  await runPnpm([
    'probefn',
    'session',
    'stop',
    '--session',
    'sess_healthy',
    '--json',
  ]);
}

async function runCliRuntimeFlows(): Promise<void> {
  await runConsoleErrorFlowVector();
  await runConsoleErrorDeltaVector();
  await runSecretLeakFlowVector();
}

async function runConsoleErrorFlowVector(): Promise<void> {
  const sessionId = 'sess_console_error';
  const runId = 'run_console_error';
  const consoleErrorEnv = {
    PROBEFN_VITE_CONSOLE_ERROR_PORT: '4277',
  };
  await cleanupSessionArtifacts(runId, sessionId);

  try {
    await runPnpm([
      'probefn',
      'session',
      'start',
      '--config',
      'test/fixtures/vite-console-error/probefn.config.ts',
      '--mode',
      'mixed',
      '--browser',
      'chromium',
      '--json',
    ], consoleErrorEnv);

    const flowed = await runPnpm([
      'probefn',
      'run',
      'flow',
      '--session',
      sessionId,
      '--file',
      'test/fixtures/vite-console-error/flows/trigger-error.yaml',
      '--json',
    ], consoleErrorEnv);
    const payload = parseJsonDocument(flowed.stdout, flowed.stderr) as {
      ok: boolean;
      data?: {
        steps?: string[];
        checkpointId?: string | null;
        consoleSink?: string | null;
        pageErrorSink?: string | null;
        networkSink?: string | null;
        devServerStdoutSink?: string | null;
        devServerStderrSink?: string | null;
      };
    };

    if (!payload.ok) {
      throw new Error(`Expected run flow to succeed: ${flowed.stdout || flowed.stderr}`);
    }

    if (payload.data?.checkpointId !== 'chk_after-submit') {
      throw new Error(`Expected chk_after-submit from run flow, received ${JSON.stringify(payload.data)}`);
    }

    if (
      payload.data?.steps?.join(',') !== 'page.open,page.act,checkpoint.create,report.export' ||
      !payload.data.consoleSink ||
      !payload.data.pageErrorSink ||
      !payload.data.networkSink ||
      !payload.data.devServerStdoutSink ||
      !payload.data.devServerStderrSink
    ) {
      throw new Error(`Expected sink paths and executed steps from run flow, received ${JSON.stringify(payload.data)}`);
    }
  } finally {
    await safeStopSession(sessionId, consoleErrorEnv);
    await cleanupSessionArtifacts(runId, sessionId);
  }
}

async function runConsoleErrorDeltaVector(): Promise<void> {
  const sessionId = 'sess_console_error';
  const runId = 'run_console_error';
  const consoleErrorEnv = {
    PROBEFN_VITE_CONSOLE_ERROR_PORT: '4277',
  };
  await cleanupSessionArtifacts(runId, sessionId);

  try {
    await runPnpm([
      'probefn',
      'session',
      'start',
      '--config',
      'test/fixtures/vite-console-error/probefn.config.ts',
      '--mode',
      'mixed',
      '--browser',
      'chromium',
      '--json',
    ], consoleErrorEnv);

    const acted = await runPnpm([
      'probefn',
      'page',
      'act',
      '--session',
      sessionId,
      '--action',
      'click',
      '--query',
      'Submit order',
      '--checkpoint-after',
      'after-submit',
      '--json',
    ], consoleErrorEnv);
    const payload = parseJsonDocument(acted.stdout, acted.stderr) as {
      ok: boolean;
      data?: {
        action?: string;
        checkpointId?: string | null;
        newConsoleErrors?: number;
        newPageErrors?: number;
        newNetworkFailures?: number;
      };
    };

    if (!payload.ok) {
      throw new Error(`Expected page act to succeed: ${acted.stdout || acted.stderr}`);
    }

    if (
      payload.data?.action !== 'click' ||
      payload.data?.checkpointId !== 'chk_after-submit' ||
      payload.data?.newConsoleErrors !== 1 ||
      payload.data?.newPageErrors !== 0 ||
      payload.data?.newNetworkFailures !== 1
    ) {
      throw new Error(`Expected action deltas 1/0/1 from console fixture, received ${JSON.stringify(payload.data)}`);
    }
  } finally {
    await safeStopSession(sessionId, consoleErrorEnv);
    await cleanupSessionArtifacts(runId, sessionId);
  }
}

async function runSecretLeakFlowVector(): Promise<void> {
  const sessionId = 'sess_secret_leak';
  const runId = 'run_secret_leak';
  await cleanupSessionArtifacts(runId, sessionId);

  try {
    await runPnpm([
      'probefn',
      'session',
      'start',
      '--config',
      'test/fixtures/vite-secret-leak/probefn.config.ts',
      '--mode',
      'mixed',
      '--browser',
      'chromium',
      '--json',
    ]);

    const flowed = await runPnpm([
      'probefn',
      'run',
      'flow',
      '--session',
      sessionId,
      '--file',
      'test/fixtures/vite-secret-leak/flows/leak.yaml',
      '--json',
    ]);
    const payload = parseJsonDocument(flowed.stdout, flowed.stderr) as {
      ok: boolean;
      data?: {
        reportPath?: string | null;
        redactedValues?: number;
      };
    };

    if (!payload.ok) {
      throw new Error(`Expected secret-leak flow to succeed: ${flowed.stdout || flowed.stderr}`);
    }

    if (!payload.data?.reportPath || (payload.data.redactedValues ?? 0) < 1) {
      throw new Error(`Expected redacted report export from leak flow, received ${JSON.stringify(payload.data)}`);
    }
  } finally {
    await safeStopSession(sessionId);
    await cleanupSessionArtifacts(runId, sessionId);
  }
}

async function safeStopSession(
  sessionId: string,
  envOverrides: Record<string, string> = {},
): Promise<void> {
  await runCommand(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['probefn', 'session', 'stop', '--session', sessionId, '--json'],
    repoRoot,
    envOverrides,
  ).catch(() => undefined);
}

async function cleanupSessionArtifacts(runId: string, sessionId: string): Promise<void> {
  await Promise.all([
    rm(path.resolve(repoRoot, '.artifacts', 'runs', runId), {
      recursive: true,
      force: true,
    }),
    rm(path.resolve(repoRoot, '.artifacts', 'session-state', `${sessionId}.json`), {
      force: true,
    }),
  ]);
}

async function runPnpm(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<CommandResult> {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = await runCommand(command, args, repoRoot, envOverrides);
  if (result.exitCode !== 0) {
    throw new Error([
      `$ ${command} ${args.join(' ')}`,
      result.stdout.trim(),
      result.stderr.trim(),
    ].filter(Boolean).join('\n'));
  }

  return result;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
      });
    });
  });
}

function getFixtureFilter(args: string[]): FixtureName | undefined {
  const index = args.indexOf('--fixture');
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  return value as FixtureName | undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseJsonDocument(stdout: string, stderr: string): unknown {
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const lastJsonStart = combined.lastIndexOf('\n{');
  const candidate =
    lastJsonStart >= 0
      ? combined.slice(lastJsonStart + 1).trim()
      : combined.trim().startsWith('{')
        ? combined.trim()
        : null;

  if (!candidate) {
    throw new Error(`Could not locate JSON output in command result.\n${combined}`);
  }

  return JSON.parse(candidate);
}

main().catch((error) => {
  const envelope = toErrorEnvelope(error);
  process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
  process.exit(envelope.ok ? 0 : 1);
});
