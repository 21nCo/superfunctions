import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

  it('advertises the instructions represented by the generated manifest', () => {
    expect(client!.instructions()).toBe(
      'Run deterministic browser probes and inspect their regression artifacts.',
    );
  });

  it('registers the full tool list from the spec', async () => {
    const response = await client!.request('tools/list', {});
    const tools = (response.result?.tools ?? []) as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...expectedToolNames].sort());
  });

  it('exposes bounded event schemas and traverses a canonical MCP cursor', async () => {
    const listed = await client!.request('tools/list', {});
    for (const name of ['probefn_page_get_console', 'probefn_page_get_network', 'probefn_page_get_page_errors']) {
      const tool = (listed.result?.tools as any[]).find(tool => tool.name === name);
      expect(tool.description).toContain('Follow nextCursor until null');
      expect(tool.inputSchema.properties.limit.maximum).toBe(1000);
      expect(tool.inputSchema.properties.cursor.maxLength).toBe(8192);
      const invalid = await client!.request('tools/call', { name, arguments: { sessionId: 'sess_console_error', limit: 0 } });
      expect((invalid.result?.structuredContent as any).error.code).toBe('E_MCP_INVALID_ARGS');
    }
    const first = await client!.request('tools/call', { name: 'probefn_page_get_console', arguments: { sessionId: 'sess_console_error', limit: 1 } });
    const data = (first.result?.structuredContent as any).data;
    expect(data.events).toHaveLength(1); expect(typeof data.nextCursor).toBe('string');
    const last = await client!.request('tools/call', { name: 'probefn_page_get_console', arguments: { sessionId: 'sess_console_error', cursor: data.nextCursor } });
    expect((last.result?.structuredContent as any).data).toEqual({ events: [], provenance: [], nextCursor: null });
    const wrong = await client!.request('tools/call', { name: 'probefn_page_get_network', arguments: { sessionId: 'sess_console_error', cursor: data.nextCursor } });
    expect((wrong.result?.structuredContent as any).error.code).toBe('E_MCP_INVALID_ARGS');
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
              provenance: [{ relativePath: '.artifacts/runs/run_console_error/events/console.ndjson', lineNumber: 1 }],
              nextCursor: null,
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
        provenance: [{ relativePath: '.artifacts/runs/run_console_error/events/console.ndjson', lineNumber: 1 }],
        nextCursor: null,
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
  private constructor(private readonly client: Client) {}

  public static async start(): Promise<McpTestClient> {
    const transport = new StdioClientTransport({
      command: path.resolve(projectRoot, '../node_modules/.bin/jiti'),
      args: [
        'apps/cli/src/index.ts',
        'mcp',
        'serve',
      ],
      cwd: projectRoot,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        PROBEFN_VITE_CONSOLE_ERROR_PORT: '4276',
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {
      // Startup metadata is expected on stderr.
    });
    const client = new Client(
      { name: 'probefn-vitest', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return new McpTestClient(client);
  }

  public async initialize(): Promise<void> {
    // Client.connect performs the official initialize/initialized handshake.
  }

  public instructions(): string | undefined {
    return this.client.getInstructions();
  }

  public async request(method: string, params: JsonObject): Promise<JsonRpcResponse> {
    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        result: await this.client.listTools() as unknown as JsonObject,
      };
    }
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const arguments_ = params.arguments && typeof params.arguments === 'object'
        ? params.arguments as JsonObject
        : {};
      return {
        jsonrpc: '2.0',
        result: await this.client.callTool({ name, arguments: arguments_ }) as unknown as JsonObject,
      };
    }
    throw new Error(`Unsupported test request ${method}.`);
  }

  public async close(): Promise<void> {
    await this.client.close();
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
