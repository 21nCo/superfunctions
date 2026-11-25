// Resolved for `#stdio-target` by bundlers and runtimes without the `node`
// export condition (Cloudflare Workers, browsers). It keeps the deprecated
// main-entry `stdioTarget` from pulling `child_process` into those bundles.
import type { McpFnStdioTargetOptions } from "./stdio-options.js";
import type { McpFnTarget } from "./types.js";

export function stdioTarget(_options: McpFnStdioTargetOptions): McpFnTarget {
  throw new Error(
    "McpFn stdio targets spawn a child process and need Node.js; " +
      'import stdioTarget from "@mcpfn/client/stdio" in a Node.js process',
  );
}
