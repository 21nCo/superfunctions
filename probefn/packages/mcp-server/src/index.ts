import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveMcpServer, type ServeMcpServerOptions } from './server.js';

export const MCP_SERVER_PACKAGE_NAME = '@probefn/mcp-server';

export * from './server.js';

export async function runMcpCli(
  args: string[] = process.argv.slice(2),
  options: Omit<ServeMcpServerOptions, 'repoRoot' | 'transport'> & { repoRoot?: string } = {},
): Promise<void> {
  if (args[0] !== 'serve') {
    throw new Error('Supported MCP command is "serve".');
  }

  const { repoRoot: configuredRoot, ...serverOptions } = options;
  const repoRoot = path.resolve(configuredRoot ?? process.cwd());
  const tcpIndex = args.indexOf('--tcp');
  const tcpPort =
    tcpIndex >= 0
      ? Number.parseInt(args[tcpIndex + 1] ?? '', 10)
      : undefined;
  const useTcp = tcpPort !== undefined && Number.isFinite(tcpPort);

  await serveMcpServer({
    repoRoot,
    transport: useTcp ? 'tcp' : 'stdio',
    ...(useTcp ? { tcpPort: tcpPort! } : {}),
    ...serverOptions,
  });
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runMcpCli().catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown MCP server error.';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
