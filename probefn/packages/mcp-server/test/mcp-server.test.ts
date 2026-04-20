import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { createRunManifest, createSuccessEnvelope, type DeterministicSettings, type JsonObject } from '@probefn/contracts';
import { createCheckpoint, SessionManager } from '@probefn/core';
import { ArtifactStore } from '@probefn/storage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const deterministic: DeterministicSettings = {
  enabled: true,
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  timezone: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'reduce',
  animationPolicy: 'freeze',
  networkIdleMs: 250,
};

const expectedToolNames = [
  'probefn_session_start',
  'probefn_session_stop',
  'probefn_auth_profile_save',
  'probefn_page_open',
  'probefn_page_find',
  'probefn_page_act',
  'probefn_checkpoint_create',
  'probefn_page_get_console',
  'probefn_page_get_network',
  'probefn_page_get_page_errors',
  'probefn_page_get_layout_report',
  'probefn_page_design_audit',
  'probefn_baseline_record',
  'probefn_baseline_compare',
  'probefn_report_export',
  'probefn_run_flow',
];

describe.sequential('mcp server', () => {
  let client: McpTestClient | null = null;

  beforeAll(async () => {
    await removeRun('run_console_error', 'sess_console_error');
    await removeRun('run_console_error_flow', 'sess_console_error_flow');
    await seedConsoleErrorSession();
    client = await McpTestClient.start();
    await client.initialize();
  });

  afterAll(async () => {
    await client?.close();
    await removeRun('run_console_error', 'sess_console_error');
    await removeRun('run_console_error_flow', 'sess_console_error_flow');
  });

  it('registers the full tool list from the spec', async () => {
    const response = await client!.request('tools/list', {});
    const tools = (response.result?.tools ?? []) as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...expectedToolNames].sort());
  });

  it('returns the canonical console payload through MCP tool wrapping', async () => {
    const response = await client!.request('tools/call', {
      name: 'probefn_page_get_console',
      arguments: {
        sessionId: 'sess_console_error',
      },
    });

    expect(response.result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            createSuccessEnvelope({
              events: [
                {
                  ts: '2026-04-16T04:40:02Z',
                  source: 'browser',
                  type: 'console',
                  level: 'error',
                  text: 'TypeError: Cannot read properties of undefined (reading "plan")',
                  pageUrl: 'http://127.0.0.1:4301/checkout',
                },
              ],
            }),
            null,
            2,
          ),
        },
      ],
      structuredContent: createSuccessEnvelope({
        events: [
          {
            ts: '2026-04-16T04:40:02Z',
            source: 'browser',
            type: 'console',
            level: 'error',
            text: 'TypeError: Cannot read properties of undefined (reading "plan")',
            pageUrl: 'http://127.0.0.1:4301/checkout',
          },
        ],
      }),
      isError: false,
    });
  });

  it('maps invalid tool args to E_MCP_INVALID_ARGS without leaking protocol stacks', async () => {
    const response = await client!.request('tools/call', {
      name: 'probefn_page_get_console',
      arguments: {
        session: 'sess_console_error',
      },
    });

    expect(response.result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: false,
              schemaVersion: '1.0',
              error: {
                code: 'E_MCP_INVALID_ARGS',
                message: 'Missing required field sessionId.',
                retryable: false,
                details: {
                  issues: [
                    {
                      path: 'sessionId',
                      message: 'Required',
                    },
                  ],
                },
              },
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        ok: false,
        schemaVersion: '1.0',
        error: {
          code: 'E_MCP_INVALID_ARGS',
          message: 'Missing required field sessionId.',
          retryable: false,
          details: {
            issues: [
              {
                path: 'sessionId',
                message: 'Required',
              },
            ],
          },
        },
      },
      isError: true,
    });
  });

  it('executes run_flow through MCP with the same logical payload shape as CLI JSON mode', async () => {
    let started = false;
    try {
      const sessionStart = await client!.request('tools/call', {
        name: 'probefn_session_start',
        arguments: {
          configPath: 'test/fixtures/vite-console-error/probefn.config.ts',
          mode: 'mixed',
          browser: 'chromium',
          sessionId: 'sess_console_error_flow',
          runId: 'run_console_error_flow',
        },
      });

      expect(sessionStart.result).toEqual(
        expect.objectContaining({
          structuredContent: expect.objectContaining({
            ok: true,
            schemaVersion: '1.0',
            data: expect.objectContaining({
              sessionId: 'sess_console_error_flow',
              runId: 'run_console_error_flow',
            }),
          }),
          isError: false,
        }),
      );
      started = true;

      const flowed = await client!.request('tools/call', {
        name: 'probefn_run_flow',
        arguments: {
          sessionId: 'sess_console_error_flow',
          file: 'test/fixtures/vite-console-error/flows/trigger-error.yaml',
        },
      });

      expect(flowed.result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              createSuccessEnvelope({
                file: 'test/fixtures/vite-console-error/flows/trigger-error.yaml',
                steps: [
                  'page.open',
                  'page.act',
                  'checkpoint.create',
                  'report.export',
                ],
                checkpointId: 'chk_after-submit',
                reportPath: '.artifacts/runs/run_console_error_flow/report.json',
                redactedValues: 1,
                consoleSink: '.artifacts/runs/run_console_error_flow/events/console.ndjson',
                pageErrorSink: '.artifacts/runs/run_console_error_flow/events/page-errors.ndjson',
                networkSink: '.artifacts/runs/run_console_error_flow/events/network.ndjson',
                devServerStdoutSink: '.artifacts/runs/run_console_error_flow/devserver/stdout.ndjson',
                devServerStderrSink: '.artifacts/runs/run_console_error_flow/devserver/stderr.ndjson',
              }),
              null,
              2,
            ),
          },
        ],
        structuredContent: createSuccessEnvelope({
          file: 'test/fixtures/vite-console-error/flows/trigger-error.yaml',
          steps: [
            'page.open',
            'page.act',
            'checkpoint.create',
            'report.export',
          ],
          checkpointId: 'chk_after-submit',
          reportPath: '.artifacts/runs/run_console_error_flow/report.json',
          redactedValues: 1,
          consoleSink: '.artifacts/runs/run_console_error_flow/events/console.ndjson',
          pageErrorSink: '.artifacts/runs/run_console_error_flow/events/page-errors.ndjson',
          networkSink: '.artifacts/runs/run_console_error_flow/events/network.ndjson',
          devServerStdoutSink: '.artifacts/runs/run_console_error_flow/devserver/stdout.ndjson',
          devServerStderrSink: '.artifacts/runs/run_console_error_flow/devserver/stderr.ndjson',
        }),
        isError: false,
      });
    } finally {
      if (started) {
        const stopped = await client!.request('tools/call', {
          name: 'probefn_session_stop',
          arguments: {
            sessionId: 'sess_console_error_flow',
          },
        });

        expect(stopped.result).toEqual(
          expect.objectContaining({
            structuredContent: expect.objectContaining({
              ok: true,
              schemaVersion: '1.0',
              data: expect.objectContaining({
                sessionId: 'sess_console_error_flow',
                status: 'completed',
              }),
            }),
            isError: false,
          }),
        );
      }
    }
  });

  it('rejects normalized flow paths that escape the repository root', async () => {
    const response = await client!.request('tools/call', {
      name: 'probefn_run_flow',
      arguments: {
        sessionId: 'sess_console_error',
        file: 'test/fixtures/vite-console-error/flows/../../../../../../outside.yaml',
      },
    });

    expect(response.result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: false,
              schemaVersion: '1.0',
              error: {
                code: 'E_CONFIG_INVALID',
                message: 'Flow files must stay within the repository root.',
                retryable: false,
              },
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        ok: false,
        schemaVersion: '1.0',
        error: {
          code: 'E_CONFIG_INVALID',
          message: 'Flow files must stay within the repository root.',
          retryable: false,
        },
      },
      isError: true,
    });
  });
});

class McpTestClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (reason?: unknown) => void;
  }>();

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on('data', (chunk) => {
      this.onStdout(chunk);
    });
    child.stderr.on('data', () => {
      // Startup metadata is expected on stderr.
    });
    child.once('exit', () => {
      for (const pendingRequest of this.pending.values()) {
        pendingRequest.reject(new Error('MCP server exited before responding.'));
      }
      this.pending.clear();
    });
  }

  public static async start(): Promise<McpTestClient> {
    const child = spawn(
      'pnpm',
      [
        'exec',
        'jiti',
        'apps/cli/src/index.ts',
        'mcp',
        'serve',
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          PROBEFN_VITE_CONSOLE_ERROR_PORT: '4276',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const client = new McpTestClient(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('MCP server did not start in time.'));
      }, 5000);
      child.stderr.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', reject);
    });
    return client;
  }

  public async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: 'vitest',
        version: '1.0.0',
      },
    });
    this.notify('notifications/initialized');
  }

  public async request(method: string, params: JsonObject): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.write(payload);
    return promise;
  }

  public notify(method: string, params: JsonObject = {}): void {
    void this.write({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  public async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }

    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
    });
  }

  private async write(payload: Record<string, unknown>): Promise<void> {
    const message = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.from(`Content-Length: ${message.byteLength}\r\n\r\n`, 'utf8');
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(Buffer.concat([header, message]), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = Buffer.alloc(0);
        return;
      }

      const contentLength = Number.parseInt(lengthMatch[1] ?? '0', 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      const response = JSON.parse(body.toString('utf8')) as JsonRpcResponse;
      if (response.id === undefined || response.id === null) {
        continue;
      }

      const pendingRequest = this.pending.get(Number(response.id));
      if (pendingRequest) {
        this.pending.delete(Number(response.id));
        pendingRequest.resolve(response);
      }
    }
  }
}

async function seedConsoleErrorSession(): Promise<void> {
  const artifactStore = new ArtifactStore({
    repoRoot: projectRoot,
  });
  const sessionManager = new SessionManager({
    repoRoot: projectRoot,
    artifactStore,
  });
  const runId = 'run_console_error';
  const sessionId = 'sess_console_error';
  const runPaths = artifactStore.getRunPaths(runId);

  await artifactStore.writeRunManifest(
    runId,
    createRunManifest({
      sessionId,
      runId,
      mode: 'debug',
      browser: 'chromium',
      artifactRoot: runPaths.runRoot,
      startedAt: '2026-04-16T04:40:00Z',
      endedAt: '2026-04-16T04:40:00Z',
      status: 'completed',
      deterministic,
      devServer: {
        mode: 'spawn',
        name: 'web',
        url: 'http://127.0.0.1:4301/checkout',
        resolvedUrl: 'http://127.0.0.1:4301/checkout',
        readyPattern: 'Local:',
      },
    }),
  );

  await sessionManager.initialize({
    sessionId,
    runId,
    mode: 'debug',
    browser: 'chromium',
    deterministic,
    artifactRoot: runPaths.runRoot,
    startedAt: '2026-04-16T04:40:00Z',
    manifestPath: runPaths.sessionManifestPath,
    resolvedUrl: 'http://127.0.0.1:4301/checkout',
    artifacts: {
      tracePath: runPaths.tracePath,
      consoleSinkPath: path.posix.join(runPaths.eventRoot, 'console.ndjson'),
      pageErrorSinkPath: path.posix.join(runPaths.eventRoot, 'page-errors.ndjson'),
      networkSinkPath: path.posix.join(runPaths.eventRoot, 'network.ndjson'),
      devServerStdoutSinkPath: path.posix.join(runPaths.devServerRoot, 'stdout.ndjson'),
      devServerStderrSinkPath: path.posix.join(runPaths.devServerRoot, 'stderr.ndjson'),
    },
  });

  await artifactStore.writeArtifact(runPaths.tracePath, Buffer.from('trace:run_console_error'));
  await writeEvents(artifactStore, path.posix.join(runPaths.eventRoot, 'console.ndjson'), [
    {
      ts: '2026-04-16T04:40:02Z',
      source: 'browser',
      type: 'console',
      level: 'error',
      text: 'TypeError: Cannot read properties of undefined (reading "plan")',
      pageUrl: 'http://127.0.0.1:4301/checkout',
    },
  ]);
  await writeEvents(artifactStore, path.posix.join(runPaths.eventRoot, 'page-errors.ndjson'), []);
  await writeEvents(artifactStore, path.posix.join(runPaths.eventRoot, 'network.ndjson'), []);
  await writeEvents(artifactStore, path.posix.join(runPaths.devServerRoot, 'stdout.ndjson'), []);
  await writeEvents(artifactStore, path.posix.join(runPaths.devServerRoot, 'stderr.ndjson'), []);

  await createCheckpoint({
    repoRoot: projectRoot,
    artifactStore,
    sessionId,
    runId,
    browser: 'chromium',
    name: 'after-submit',
    delta: {
      newConsoleErrors: 1,
      newPageErrors: 0,
      newNetworkFailures: 0,
    },
    includeTrace: true,
    includeStyles: true,
    tracePath: runPaths.tracePath,
    source: {
      url: () => 'http://127.0.0.1:4301/checkout',
      viewportSize: () => deterministic.viewport,
      screenshot: async () => Buffer.from('png:run_console_error'),
      domSnapshot: async () => ({ html: '<main>checkout</main>' }),
      accessibilitySnapshot: async () => ({ snapshot: '- main "checkout"' }),
      layoutSnapshot: async () => ({
        url: 'http://127.0.0.1:4301/checkout',
        elements: [
          {
            elementId: 'el_submit_order_button',
            role: 'button',
            name: 'Submit order',
            text: 'Submit order',
            visible: true,
            disabled: false,
            bounds: { x: 24, y: 96, width: 180, height: 56 },
            selectorHints: {
              id: 'submit-order',
              testId: 'submit-order',
              role: 'button',
              name: 'Submit order',
            },
          },
        ],
      }),
      stylesSnapshot: async () => ({
        elements: [],
      }),
    },
    now: () => '2026-04-16T04:40:00Z',
  });

  await sessionManager.markCompleted(sessionId, {
    endedAt: '2026-04-16T04:40:00Z',
    artifacts: {
      tracePath: runPaths.tracePath,
    },
  });
}

async function writeEvents(
  artifactStore: ArtifactStore,
  relativePath: string,
  events: Record<string, unknown>[],
): Promise<void> {
  await artifactStore.writeArtifact(
    relativePath,
    events.length > 0
      ? `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
      : '',
  );
}

async function removeRun(runId: string, sessionId: string): Promise<void> {
  await Promise.all([
    rm(path.resolve(projectRoot, '.artifacts', 'runs', runId), {
      recursive: true,
      force: true,
    }),
    rm(path.resolve(projectRoot, '.artifacts', 'session-state', `${sessionId}.json`), {
      recursive: true,
      force: true,
    }),
  ]);
  await mkdir(path.resolve(projectRoot, '.artifacts', 'session-state'), { recursive: true });
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: JsonObject;
  error?: {
    code: number;
    message: string;
  };
}
