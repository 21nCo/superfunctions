// Node.js-only entry: `@mcpfn/client/stdio`. The official SDK stdio transport
// spawns the server with `cross-spawn` (`node:child_process`), so it lives
// outside the remote-only main entry that Cloudflare Workers bundle.
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { customTarget } from "./custom-target.js";
import { stdioTargetDescriptor, type McpFnStdioTargetOptions } from "./stdio-options.js";
import type { McpFnTarget } from "./types.js";

export type { McpFnStdioTargetOptions } from "./stdio-options.js";

export function stdioTarget(options: McpFnStdioTargetOptions): McpFnTarget {
  return customTarget({
    kind: "stdio",
    descriptor: stdioTargetDescriptor(options),
    open: () => {
      const transport = new StdioClientTransport(options);
      return {
        transport,
        close: () => transport.close(),
      };
    },
  });
}
