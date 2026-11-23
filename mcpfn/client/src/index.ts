// Remote-only main entry: it never loads the stdio transport, `cross-spawn` or
// `node:child_process`, so Cloudflare Workers can bundle it. Node.js stdio
// targets come from `@mcpfn/client/stdio`.
export * from "./client.js";
export * from "./targets.js";
export * from "./types.js";
